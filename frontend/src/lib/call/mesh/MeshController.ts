/**
 * MeshController — orchestrates a multi-party (mesh) voice call on native.
 *
 * Owns ONE local audio stream and one `MeshPeer` per remote participant, all
 * sharing a single `callId`. The React layer feeds it:
 *   • the current participant roster (user ids) from `api.conference.getParticipants`
 *   • incoming signaling messages (with `fromUserId`) from `api.signaling.poll`
 * and provides a `sendSignal` that calls `api.signaling.send`.
 *
 * Voice only (no video) for the first release.
 */

import { MeshPeer, MeshSignalType } from './MeshPeer';

type Any = any;
type WebRTCModule = typeof import('react-native-webrtc');

export interface MeshControllerOptions {
  callId: string;
  myUserId: string;
  /** Acquire a camera track too (conferences are voice+video). Default false. */
  video?: boolean;
  sendSignal: (toUserId: string, type: MeshSignalType, payload: string) => void;
  /** Called whenever the set of remote streams changes. */
  onRemoteStreamsChanged?: (streams: Record<string, Any>) => void;
  /** Periodic speaking state: `{ [peerUserId]: boolean, __local: boolean }`. */
  onSpeakingChange?: (speaking: Record<string, boolean>) => void;
  onError?: (err: Error) => void;
}

export class MeshController {
  private opts: MeshControllerOptions;
  private webrtc: WebRTCModule | null = null;
  private localStream: Any = null;
  private peers = new Map<string, MeshPeer>();
  private remoteStreams: Record<string, Any> = {};
  private micEnabled = true;
  private cameraEnabled: boolean;
  private wantsVideo: boolean;
  private started = false;
  private closed = false;
  private speakingTimer: Any = null;

  constructor(opts: MeshControllerOptions) {
    this.opts = opts;
    this.wantsVideo = !!opts.video;
    this.cameraEnabled = !!opts.video;
  }

  private async getWebRTC(): Promise<WebRTCModule> {
    if (!this.webrtc) this.webrtc = await import('react-native-webrtc');
    return this.webrtc;
  }

  /** Acquire mic (and camera for video conferences). Call once before syncing. */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    const webrtc = await this.getWebRTC();
    this.localStream = await webrtc.mediaDevices.getUserMedia({
      audio: true,
      video: this.wantsVideo ? ({ facingMode: 'user' } as Any) : false,
    });
    this.startSpeakingPoll();
  }

  private startSpeakingPoll(): void {
    if (this.speakingTimer || !this.opts.onSpeakingChange) return;
    const THRESHOLD = 0.02;
    this.speakingTimer = setInterval(async () => {
      if (this.closed) return;
      const peers = Array.from(this.peers.values());
      const speaking: Record<string, boolean> = {};
      for (const peer of peers) {
        try {
          speaking[peer.peerUserId] = (await peer.getInboundAudioLevel()) > THRESHOLD;
        } catch {}
      }
      let localLevel = 0;
      if (peers[0]) {
        try {
          localLevel = await peers[0].getLocalAudioLevel();
        } catch {}
      }
      speaking.__local = this.micEnabled && localLevel > THRESHOLD;
      this.opts.onSpeakingChange?.(speaking);
    }, 700);
  }

  /** The local camera/mic stream (for rendering a self-view). */
  getLocalStream(): Any {
    return this.localStream;
  }

  /**
   * Reconcile the live roster: open peer connections for newly-seen
   * participants and tear down those who left. `userIds` should EXCLUDE me.
   */
  syncParticipants(userIds: string[]): void {
    if (this.closed || !this.localStream) return;
    const next = new Set(userIds.filter((id) => id && id !== this.opts.myUserId));

    // Remove peers who left.
    for (const peerId of Array.from(this.peers.keys())) {
      if (!next.has(peerId)) {
        this.peers.get(peerId)?.close();
        this.peers.delete(peerId);
        if (this.remoteStreams[peerId]) {
          delete this.remoteStreams[peerId];
          this.emitStreams();
        }
      }
    }

    // Add new peers.
    for (const peerId of next) {
      if (!this.peers.has(peerId)) this.createPeer(peerId);
    }
  }

  private createPeer(peerUserId: string): MeshPeer {
    const peer = new MeshPeer({
      callId: this.opts.callId,
      myUserId: this.opts.myUserId,
      peerUserId,
      localStream: this.localStream,
      sendSignal: this.opts.sendSignal,
      onRemoteStream: (id, stream) => {
        this.remoteStreams[id] = stream;
        this.emitStreams();
      },
    });
    this.peers.set(peerUserId, peer);
    peer.init().catch((e) => this.opts.onError?.(e instanceof Error ? e : new Error(String(e))));
    return peer;
  }

  /** Route an incoming signaling message (creating the peer if needed). */
  handleSignal(fromUserId: string, type: MeshSignalType, payload: string): void {
    if (this.closed || !fromUserId || fromUserId === this.opts.myUserId) return;
    let peer = this.peers.get(fromUserId);
    if (!peer) {
      // A peer we haven't seen in the roster yet sent us an offer → create it.
      if (!this.localStream) return;
      peer = this.createPeer(fromUserId);
    }
    peer.handleSignal(type, payload).catch(() => {});
  }

  /** Toggle the local microphone. Returns the new enabled state. */
  setMicEnabled(enabled: boolean): void {
    this.micEnabled = enabled;
    try {
      this.localStream?.getAudioTracks?.().forEach((t: Any) => {
        t.enabled = enabled;
      });
    } catch {}
  }

  isMicEnabled(): boolean {
    return this.micEnabled;
  }

  /** Enable/disable the local camera track (video conferences). */
  setVideoEnabled(enabled: boolean): void {
    this.cameraEnabled = enabled;
    try {
      this.localStream?.getVideoTracks?.().forEach((t: Any) => {
        t.enabled = enabled;
      });
    } catch {}
  }

  isCameraEnabled(): boolean {
    return this.cameraEnabled;
  }

  getRemoteStreams(): Record<string, Any> {
    return this.remoteStreams;
  }

  private emitStreams(): void {
    this.opts.onRemoteStreamsChanged?.({ ...this.remoteStreams });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.speakingTimer) {
      clearInterval(this.speakingTimer);
      this.speakingTimer = null;
    }
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    try {
      this.localStream?.getTracks?.().forEach((t: Any) => t.stop?.());
    } catch {}
    this.localStream = null;
    this.remoteStreams = {};
  }
}
