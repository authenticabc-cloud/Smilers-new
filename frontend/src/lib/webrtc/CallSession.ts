import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
  MediaStream,
} from 'react-native-webrtc';
import { PEER_CONNECTION_CONFIG } from './iceServers';

export type SignalType = 'offer' | 'answer' | 'ice-candidate';

export type SignalMessage = {
  callId: string;
  toUserId: string;
  type: SignalType;
  payload: string; // JSON-serialized SDP or ICE candidate
};

export type CallSessionOptions = {
  callType: 'voice' | 'video';
  isCaller: boolean;
  callId: string;
  remoteUserId: string;
  sendSignal: (signal: SignalMessage) => Promise<void> | void;
  onRemoteStream?: (stream: MediaStream) => void;
  onLocalStream?: (stream: MediaStream) => void;
  onConnectionStateChange?: (state: string) => void;
  onError?: (err: Error) => void;
};

/**
 * CallSession — wraps RTCPeerConnection + getUserMedia + signaling glue.
 * Mirrors the web app's WebRTC implementation exactly.
 */
export class CallSession {
  public readonly opts: CallSessionOptions;
  public pc: RTCPeerConnection | null = null;
  public localStream: MediaStream | null = null;
  public remoteStream: MediaStream | null = null;

  private closed = false;
  private remoteDescriptionSet = false;
  private pendingIce: RTCIceCandidate[] = [];

  constructor(opts: CallSessionOptions) {
    this.opts = opts;
  }

  /** Acquire camera/mic and attach to the peer connection. */
  async initLocalMedia(): Promise<MediaStream> {
    const constraints: any = {
      audio: true,
      video:
        this.opts.callType === 'video'
          ? {
              mandatory: {
                minWidth: 640,
                minHeight: 480,
                minFrameRate: 24,
              },
              facingMode: 'user',
            }
          : false,
    };
    const stream = (await mediaDevices.getUserMedia(constraints)) as unknown as MediaStream;
    this.localStream = stream;
    this.opts.onLocalStream?.(stream);
    return stream;
  }

  /** Build the RTCPeerConnection and wire all listeners. */
  createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection(PEER_CONNECTION_CONFIG);
    this.pc = pc;

    // ICE candidates → send via signaling
    (pc as any).addEventListener('icecandidate', (event: any) => {
      if (event?.candidate && !this.closed) {
        const payload = JSON.stringify(event.candidate.toJSON ? event.candidate.toJSON() : event.candidate);
        void Promise.resolve(
          this.opts.sendSignal({
            callId: this.opts.callId,
            toUserId: this.opts.remoteUserId,
            type: 'ice-candidate',
            payload,
          }),
        ).catch((errorValue) =>
          this.opts.onError?.(errorValue instanceof Error ? errorValue : new Error(String(errorValue))),
        );
      }
    });

    // Remote tracks → expose as remoteStream
    (pc as any).addEventListener('track', (event: any) => {
      const streams = event?.streams as MediaStream[] | undefined;
      const stream = streams && streams.length > 0 ? streams[0] : null;
      if (stream) {
        this.remoteStream = stream;
        this.opts.onRemoteStream?.(stream);
      }
    });

    (pc as any).addEventListener('connectionstatechange', () => {
      const state = (pc as any).connectionState as string | undefined;
      if (state) this.opts.onConnectionStateChange?.(state);
    });

    (pc as any).addEventListener('iceconnectionstatechange', () => {
      const state = (pc as any).iceConnectionState as string | undefined;
      if (state) this.opts.onConnectionStateChange?.(`ice:${state}`);
    });

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        try {
          pc.addTrack(track, this.localStream as any);
        } catch (errorValue) {
          this.opts.onError?.(
            errorValue instanceof Error ? errorValue : new Error(String(errorValue)),
          );
        }
      });
    }

    return pc;
  }

  /** Caller: create + send the SDP offer. */
  async createOffer(): Promise<void> {
    if (!this.pc) throw new Error('Peer connection not initialized');
    const offer = await this.pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: this.opts.callType === 'video',
    } as any);
    await this.pc.setLocalDescription(offer);
    await this.opts.sendSignal({
      callId: this.opts.callId,
      toUserId: this.opts.remoteUserId,
      type: 'offer',
      payload: JSON.stringify(offer),
    });
  }

  /** Callee: handle a received offer and reply with an answer. */
  async handleRemoteOffer(payload: string): Promise<void> {
    if (!this.pc) throw new Error('Peer connection not initialized');
    const offer = JSON.parse(payload);
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.opts.sendSignal({
      callId: this.opts.callId,
      toUserId: this.opts.remoteUserId,
      type: 'answer',
      payload: JSON.stringify(answer),
    });
  }

  /** Caller: handle the answer from the callee. */
  async handleRemoteAnswer(payload: string): Promise<void> {
    if (!this.pc) throw new Error('Peer connection not initialized');
    const answer = JSON.parse(payload);
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();
  }

  /** Add a remote ICE candidate. Buffered until the remote SDP is set. */
  async handleRemoteIceCandidate(payload: string): Promise<void> {
    if (!this.pc) return;
    let candidate: RTCIceCandidate;
    try {
      const parsed = JSON.parse(payload);
      candidate = new RTCIceCandidate(parsed);
    } catch {
      return;
    }
    if (!this.remoteDescriptionSet) {
      this.pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (errorValue) {
      this.opts.onError?.(
        errorValue instanceof Error ? errorValue : new Error(String(errorValue)),
      );
    }
  }

  private async flushPendingIce(): Promise<void> {
    if (!this.pc || this.pendingIce.length === 0) return;
    for (const candidate of this.pendingIce) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (errorValue) {
        this.opts.onError?.(
          errorValue instanceof Error ? errorValue : new Error(String(errorValue)),
        );
      }
    }
    this.pendingIce = [];
  }

  /** Toggle local audio track. Returns the new muted state. */
  setMuted(muted: boolean): boolean {
    if (!this.localStream) return false;
    this.localStream.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    return muted;
  }

  /** Toggle local video track. Returns the new state (true = camera off). */
  setCameraOff(off: boolean): boolean {
    if (!this.localStream) return false;
    this.localStream.getVideoTracks().forEach((t) => {
      t.enabled = !off;
    });
    return off;
  }

  /** Switch between front/back camera (react-native-webrtc helper). */
  switchCamera(): void {
    if (!this.localStream) return;
    this.localStream.getVideoTracks().forEach((track: any) => {
      if (typeof track._switchCamera === 'function') {
        track._switchCamera();
      }
    });
  }

  /** Tear down: stop tracks, close peer connection, mark closed. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    try {
      this.localStream?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
    } catch {}

    try {
      this.remoteStream?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
    } catch {}

    try {
      this.pc?.close();
    } catch {}

    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
  }
}
