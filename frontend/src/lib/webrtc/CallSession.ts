import { PEER_CONNECTION_CONFIG } from './iceServers';

type MediaStream = any;
type RTCPeerConnection = any;
type RTCIceCandidate = any;
type RTCSessionDescription = any;
type WebRTCModule = typeof import('react-native-webrtc');

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
  private webrtc: WebRTCModule | null = null;

  constructor(opts: CallSessionOptions) {
    this.opts = opts;
  }

  private async getWebRTC(): Promise<WebRTCModule> {
    if (!this.webrtc) {
      this.webrtc = await import('react-native-webrtc');
    }
    return this.webrtc;
  }

  /** Acquire camera/mic and attach to the peer connection. */
  async initLocalMedia(useScreen: boolean = false, viewerOnly: boolean = false): Promise<MediaStream | null> {
    const webrtc = await this.getWebRTC();
    if (viewerOnly) {
      // Screen-share viewer: NO local capture at all. We're purely receiving
      // the sender's screen — capturing our own camera/mic would be wrong
      // UX (and would block the whole flow if the user denies camera, which
      // is exactly what happened in the field). The offer/answer SDP
      // negotiation will still create a recvonly video transceiver because
      // the remote offer advertises a video sender.
      this.localStream = null;
      this.opts.onLocalStream?.(null as any);
      return null;
    }
    if (useScreen) {
      // Screen-share-only mode: capture the device screen + mic audio
      const screenStream = await this.captureScreen();
      // Add a mic audio track so the remote can still hear us
      try {
        const audioStream = (await webrtc.mediaDevices.getUserMedia({ audio: true, video: false })) as unknown as MediaStream;
        audioStream.getAudioTracks().forEach((track) => {
          try {
            screenStream.addTrack(track);
          } catch {}
        });
      } catch {
        // Audio track is best-effort; continue with screen-only
      }
      this.localStream = screenStream;
      this.opts.onLocalStream?.(screenStream);
      return screenStream;
    }
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
    const stream = (await webrtc.mediaDevices.getUserMedia(constraints)) as unknown as MediaStream;
    this.localStream = stream;
    this.opts.onLocalStream?.(stream);
    return stream;
  }

  /** Internal: capture the device screen using getDisplayMedia. */
  private async captureScreen(): Promise<MediaStream> {
    const webrtc = await this.getWebRTC();
    const md: any = webrtc.mediaDevices as any;
    if (typeof md.getDisplayMedia !== 'function') {
      throw new Error('Screen capture is not available on this device.');
    }
    const stream = (await md.getDisplayMedia({ video: true, audio: false })) as MediaStream;
    return stream;
  }

  /**
   * Replace the outgoing video track with the device screen.
   * Returns the new screen stream so the caller can render it as the local preview.
   */
  async startScreenShare(): Promise<MediaStream> {
    if (!this.pc) throw new Error('Peer connection not initialized');
    const screenStream = await this.captureScreen();
    const screenTrack = screenStream.getVideoTracks()[0];
    if (!screenTrack) throw new Error('Failed to acquire screen track.');

    // Find the existing video sender (if any) and replace its track
    const senders = (this.pc as any).getSenders ? (this.pc as any).getSenders() : [];
    const videoSender = senders.find((s: any) => s.track && s.track.kind === 'video');

    if (videoSender) {
      // Stop the old camera track so the camera light turns off
      try {
        videoSender.track?.stop();
      } catch {}
      try {
        await videoSender.replaceTrack(screenTrack);
      } catch (e: any) {
        throw new Error('Failed to switch to screen sharing: ' + e?.message);
      }
    } else {
      // Voice-only call → add a new sender so the remote starts receiving video
      try {
        (this.pc as any).addTrack(screenTrack, screenStream);
      } catch (e: any) {
        throw new Error('Failed to attach screen track: ' + e?.message);
      }
      // Renegotiate to advertise the new video track
      try {
        const offer = await this.pc.createOffer({} as any);
        await this.pc.setLocalDescription(offer);
        await this.opts.sendSignal({
          callId: this.opts.callId,
          toUserId: this.opts.remoteUserId,
          type: 'offer',
          payload: JSON.stringify(offer),
        });
      } catch {}
    }

    // Swap localStream's video track so previews / onLocalStream subscribers see the screen
    if (this.localStream) {
      try {
        this.localStream.getVideoTracks().forEach((t) => {
          try {
            this.localStream?.removeTrack(t);
          } catch {}
        });
        this.localStream.addTrack(screenTrack);
      } catch {}
    } else {
      this.localStream = screenStream;
    }
    this.opts.onLocalStream?.(this.localStream as MediaStream);
    return screenStream;
  }

  /**
   * Stop screen sharing. If `cameraStream` is provided (video call), restore
   * the camera track. Otherwise just stop the screen track (voice call).
   */
  async stopScreenShare(restoreVideo: boolean = true): Promise<void> {
    if (!this.pc) return;
    const senders = (this.pc as any).getSenders ? (this.pc as any).getSenders() : [];
    const videoSender = senders.find((s: any) => s.track && s.track.kind === 'video');

    if (restoreVideo) {
      try {
        const webrtc = await this.getWebRTC();
        const camStream = (await webrtc.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user' },
        })) as unknown as MediaStream;
        const camTrack = camStream.getVideoTracks()[0];
        if (camTrack && videoSender) {
          try {
            videoSender.track?.stop();
          } catch {}
          await videoSender.replaceTrack(camTrack);

          if (this.localStream) {
            this.localStream.getVideoTracks().forEach((t) => {
              try {
                this.localStream?.removeTrack(t);
              } catch {}
            });
            this.localStream.addTrack(camTrack);
            this.opts.onLocalStream?.(this.localStream as MediaStream);
          }
        }
      } catch {
        // Couldn't reacquire camera — just stop the current track
        try {
          videoSender?.track?.stop();
        } catch {}
      }
    } else {
      // Voice/screen-only mode: just stop sending video
      try {
        videoSender?.track?.stop();
      } catch {}
      if (videoSender && (videoSender as any).replaceTrack) {
        try {
          await (videoSender as any).replaceTrack(null);
        } catch {}
      }
    }
  }

  /** Build the RTCPeerConnection and wire all listeners. */
  async createPeerConnection(): Promise<RTCPeerConnection> {
    const webrtc = await this.getWebRTC();
    const pc = new webrtc.RTCPeerConnection(PEER_CONNECTION_CONFIG);
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
    // Viewer-only mode (no local stream): we DO NOT pre-add `recvonly`
    // transceivers anymore — that was attempted in iteration 79 but caused
    // hard native crashes in `react-native-webrtc` v124 on some Android
    // devices when paired with an asymmetric offer. The WebRTC spec
    // guarantees that `setRemoteDescription(offer)` auto-creates matching
    // transceivers for every m-line in the offer (defaulting to `recvonly`
    // when we have no local tracks to send), so the receiver will still
    // negotiate video correctly without any explicit `addTransceiver` call.

    return pc;
  }

  /** Caller: create + send the SDP offer. */
  async createOffer(): Promise<void> {
    if (!this.pc) throw new Error('Peer connection not initialized');
    const offer = await this.pc.createOffer({
      // Screen sharing is callType==='video' but we always want to receive
      // the remote video too in case of bidirectional flows. For pure voice
      // calls we still set offerToReceiveAudio:true.
      offerToReceiveAudio: true,
      offerToReceiveVideo: this.opts.callType === 'video',
    } as any);
    await this.pc.setLocalDescription(offer);
    const videoTracks = (this.localStream as any)?.getVideoTracks?.() || [];
    const screenTrack = videoTracks[0];
    if (screenTrack) {
      // Diagnostic log per backend team's checklist (Iteration 79):
      //   "Log track kind/id/readyState after screen share starts."
      console.log(
        '[CallSession] outgoing video track:',
        'kind=', screenTrack.kind,
        'id=', screenTrack.id,
        'enabled=', screenTrack.enabled,
        'readyState=', screenTrack.readyState,
      );
    }
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
    const webrtc = await this.getWebRTC();
    await this.pc.setRemoteDescription(new webrtc.RTCSessionDescription(offer));
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
    const webrtc = await this.getWebRTC();
    await this.pc.setRemoteDescription(new webrtc.RTCSessionDescription(answer));
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();
  }

  /** Add a remote ICE candidate. Buffered until the remote SDP is set. */
  async handleRemoteIceCandidate(payload: string): Promise<void> {
    if (!this.pc) return;
    let candidate: RTCIceCandidate;
    try {
      const parsed = JSON.parse(payload);
      const webrtc = await this.getWebRTC();
      candidate = new webrtc.RTCIceCandidate(parsed);
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
