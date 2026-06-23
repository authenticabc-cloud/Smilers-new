/**
 * MeshPeer — a single WebRTC peer connection inside a multi-party (mesh) call.
 *
 * Interop contract with the Smilers WEB app (confirmed by the web team):
 *   • One peer connection per remote participant, all sharing one `callId`.
 *   • Signaling addressed by `toUserId`; incoming messages carry `fromUserId`.
 *   • Politeness rule:  polite = (String(myUserId) > String(peerUserId))
 *     (lexicographic compare on the Convex `users._id`; LARGER id = polite).
 *
 * Glare strategy (deliberately rollback-free):
 *   react-native-webrtc has weak/unreliable SDP rollback support, so instead of
 *   the symmetric "perfect negotiation with rollback" the web uses, we use the
 *   equivalent collision-free subset that still interoperates with it:
 *     - The IMPOLITE peer (smaller id) is the SOLE initiator of the offer.
 *     - The POLITE peer (larger id) NEVER initiates — it only answers.
 *     - If the impolite peer ever receives an offer while it is mid-negotiation
 *       (a glare), it IGNORES it (no rollback needed).
 *   Against the web's full perfect-negotiation peer this still converges:
 *   when we are polite the web (impolite) drives and we answer; when we are
 *   impolite we drive and the web (polite) rolls back on its own side.
 */

import { getPeerConnectionConfig } from '../../webrtc/iceServers';

type Any = any;
type WebRTCModule = typeof import('react-native-webrtc');

export type MeshSignalType = 'offer' | 'answer' | 'ice-candidate';

export interface MeshPeerOptions {
  callId: string;
  myUserId: string;
  peerUserId: string;
  /** Shared local audio stream (created once by the controller). */
  localStream: Any;
  /** Send a signaling message addressed to this peer. */
  sendSignal: (toUserId: string, type: MeshSignalType, payload: string) => void;
  /** Remote audio stream became available for this peer. */
  onRemoteStream: (peerUserId: string, stream: Any) => void;
  /** Connection-state changes (connected / failed / closed …). */
  onConnectionState?: (peerUserId: string, state: string) => void;
}

export class MeshPeer {
  readonly peerUserId: string;
  readonly polite: boolean;
  private opts: MeshPeerOptions;
  private pc: Any = null;
  private webrtc: WebRTCModule | null = null;
  private makingOffer = false;
  private remoteDescriptionSet = false;
  private pendingIce: Any[] = [];
  private closed = false;
  remoteStream: Any = null;

  constructor(opts: MeshPeerOptions) {
    this.opts = opts;
    this.peerUserId = opts.peerUserId;
    // LARGER id == polite. Polite peer only answers, never initiates.
    this.polite = String(opts.myUserId) > String(opts.peerUserId);
  }

  private async getWebRTC(): Promise<WebRTCModule> {
    if (!this.webrtc) this.webrtc = await import('react-native-webrtc');
    return this.webrtc;
  }

  /** Build the peer connection, attach local audio, wire listeners. */
  async init(): Promise<void> {
    if (this.closed) return;
    const webrtc = await this.getWebRTC();
    let config: Any;
    try {
      config = await getPeerConnectionConfig();
    } catch {
      config = undefined;
    }
    const pc = new webrtc.RTCPeerConnection(config);
    this.pc = pc;

    // Attach local audio tracks.
    try {
      this.opts.localStream?.getTracks?.().forEach((track: Any) => {
        pc.addTrack(track, this.opts.localStream);
      });
    } catch {
      /* ignore — controller guarantees a stream */
    }

    pc.addEventListener('icecandidate', (event: Any) => {
      if (event?.candidate && !this.closed) {
        const c = event.candidate;
        const payload = JSON.stringify(c.toJSON ? c.toJSON() : c);
        this.opts.sendSignal(this.peerUserId, 'ice-candidate', payload);
      }
    });

    pc.addEventListener('track', (event: Any) => {
      const stream = event?.streams?.[0];
      if (stream) {
        this.remoteStream = stream;
      } else if (event?.track) {
        // Build a stream if the remote didn't attach one.
        if (!this.remoteStream) this.remoteStream = new webrtc.MediaStream();
        try {
          this.remoteStream.addTrack(event.track);
        } catch {}
      }
      if (this.remoteStream) this.opts.onRemoteStream(this.peerUserId, this.remoteStream);
    });

    pc.addEventListener('connectionstatechange', () => {
      this.opts.onConnectionState?.(this.peerUserId, pc.connectionState);
    });

    // Only the IMPOLITE peer initiates. Adding tracks fires negotiationneeded.
    pc.addEventListener('negotiationneeded', async () => {
      if (this.polite || this.closed) return;
      try {
        this.makingOffer = true;
        await pc.setLocalDescription(await pc.createOffer({ offerToReceiveAudio: true } as Any));
        this.opts.sendSignal(this.peerUserId, 'offer', JSON.stringify(pc.localDescription));
      } catch {
        /* swallow — ICE restart / transient */
      } finally {
        this.makingOffer = false;
      }
    });
  }

  /** Route an incoming signaling message from this peer. */
  async handleSignal(type: MeshSignalType, payload: string): Promise<void> {
    if (!this.pc || this.closed) return;
    const webrtc = await this.getWebRTC();
    const pc = this.pc;

    if (type === 'offer') {
      const collision = this.makingOffer || pc.signalingState !== 'stable';
      // Impolite peer ignores colliding offers (no rollback needed).
      if (!this.polite && collision) return;
      try {
        await pc.setRemoteDescription(new webrtc.RTCSessionDescription(JSON.parse(payload)));
        this.remoteDescriptionSet = true;
        await this.flushPendingIce();
        await pc.setLocalDescription(await pc.createAnswer());
        this.opts.sendSignal(this.peerUserId, 'answer', JSON.stringify(pc.localDescription));
      } catch {
        /* swallow */
      }
      return;
    }

    if (type === 'answer') {
      // Only meaningful for the impolite (offering) side.
      if (pc.signalingState !== 'have-local-offer') return;
      try {
        await pc.setRemoteDescription(new webrtc.RTCSessionDescription(JSON.parse(payload)));
        this.remoteDescriptionSet = true;
        await this.flushPendingIce();
      } catch {
        /* swallow */
      }
      return;
    }

    // ice-candidate
    let candidate: Any;
    try {
      candidate = new webrtc.RTCIceCandidate(JSON.parse(payload));
    } catch {
      return;
    }
    if (!this.remoteDescriptionSet) {
      this.pendingIce.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      /* candidate may be stale after a renegotiation; safe to drop */
    }
  }

  private async flushPendingIce(): Promise<void> {
    if (!this.pc || this.pendingIce.length === 0) return;
    const queued = this.pendingIce.splice(0, this.pendingIce.length);
    for (const c of queued) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {}
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.pc?.close?.();
    } catch {}
    this.pc = null;
    this.remoteStream = null;
    this.pendingIce = [];
  }
}
