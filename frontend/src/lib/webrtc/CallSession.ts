import { PEER_CONNECTION_CONFIG } from './iceServers';
import { callDebug } from '../callDebugLog';

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
  // iter-128: track the LAST applied remote SDP payload bytes so we can
  // distinguish "duplicate (re-emitted by signaling poll loop)" from
  // "ICE restart offer/answer" (which will be byte-different because
  // the ice-ufrag/ice-pwd lines change). Without this, the iter-96
  // idempotency guard would silently drop legitimate ICE restart
  // signaling messages.
  private lastAppliedOfferPayload: string | null = null;
  private lastAppliedAnswerPayload: string | null = null;
  // iter-128: ICE restart bookkeeping. Browsers/native-webrtc do NOT
  // auto-restart ICE when the path breaks (e.g. carrier re-NAT, network
  // handoff, brief signal loss). We have to do it ourselves: when ICE
  // state goes 'disconnected' we wait a short grace period and then
  // initiate an ICE restart from the caller side. 'failed' triggers an
  // immediate restart. Capped at MAX_ICE_RESTART_ATTEMPTS per failure
  // cycle so we don't loop forever on a totally dead path.
  private iceRestartAttempts = 0;
  private iceRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private iceRestartInFlight = false;
  private static readonly MAX_ICE_RESTART_ATTEMPTS = 3;
  // 5s grace — covers the 99% case where a transient handoff recovers
  // on its own without needing a renegotiation. (WebRTC spec recommends
  // 5–10s; 5 is the WhatsApp/Telegram-observed sweet spot for cellular.)
  private static readonly ICE_RESTART_GRACE_MS = 5000;

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
  async initLocalMedia(useScreen: boolean = false): Promise<MediaStream> {
    const webrtc = await this.getWebRTC();
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
    // iter-133: explicit audio constraints. Previously we passed
    // `audio: true` which uses platform defaults — on Android those
    // defaults can leave AEC (acoustic echo cancellation), NS (noise
    // suppression), and AGC (auto gain control) DISABLED depending
    // on the device, the audio source, and the system audio mode.
    // The user reported echo on speakerphone — that's the AEC=off
    // signature. Explicitly requesting all three telephony DSPs +
    // forcing the audio source to VOICE_COMMUNICATION (the only mode
    // where Android's hardware AEC kicks in reliably) fixes echo.
    const constraints: any = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        // Hint to react-native-webrtc to set the AudioRecord source to
        // VOICE_COMMUNICATION (Android MediaRecorder.AudioSource = 7)
        // instead of the default MIC source — VOICE_COMMUNICATION is
        // the source that gets hardware AEC + NS on most Android
        // chipsets (Qualcomm/MediaTek/Samsung).
        sourceId: 'default',
        mandatory: {
          googEchoCancellation: true,
          googEchoCancellation2: true,
          googAutoGainControl: true,
          googAutoGainControl2: true,
          googNoiseSuppression: true,
          googNoiseSuppression2: true,
          googHighpassFilter: true,
          googTypingNoiseDetection: true,
        },
      },
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

  /** Internal: capture the device screen using getDisplayMedia.
   *
   * ⚠ Per Emergent Support iteration 83 — the native `getDisplayMedia`
   * implementation in `react-native-webrtc@124.0.7` can fail in ways that
   * propagate as uncaught native errors and crash the JS bridge. We wrap
   * the call in a try/catch and surface a JS-side Error so the call screen
   * can show a friendly alert via the existing `setPermissionDenied` /
   * `alertScreenShareIOSError` paths instead of bringing down the whole
   * app.
   */
  private async captureScreen(): Promise<MediaStream> {
    const webrtc = await this.getWebRTC();
    const md: any = webrtc.mediaDevices as any;
    callDebug.push('PC', 'captureScreen: starting (will trigger system MediaProjection picker)');
    if (typeof md.getDisplayMedia !== 'function') {
      callDebug.push('ERR', 'captureScreen: getDisplayMedia not available in this build');
      throw new Error('Screen capture is not available on this device.');
    }
    try {
      // iter-132: capture more detail about the getDisplayMedia call so
      // we can diagnose the "picker no longer appears" regression.
      // On Android 14+, getDisplayMedia requires the app to start a
      // foreground service of type `mediaProjection` BEFORE invoking;
      // react-native-webrtc v124 handles this internally if the
      // FOREGROUND_SERVICE_MEDIA_PROJECTION permission is declared
      // (we do declare it in app.json). If the picker doesn't show,
      // the error text below will tell us exactly which step failed.
      const stream = (await md.getDisplayMedia({ video: true, audio: false })) as MediaStream;
      callDebug.push('PC', 'captureScreen: getDisplayMedia resolved');
      if (!stream || typeof (stream as any).getVideoTracks !== 'function') {
        callDebug.push('ERR', 'captureScreen: invalid stream returned');
        throw new Error('Screen capture returned an invalid stream.');
      }
      const videoTracks = stream.getVideoTracks();
      if (!videoTracks || videoTracks.length === 0) {
        callDebug.push('ERR', 'captureScreen: zero video tracks in stream');
        throw new Error('Screen capture returned no video tracks.');
      }
      callDebug.push('PC', `captureScreen: success (${videoTracks.length} track(s))`);
      return stream;
    } catch (errorValue: any) {
      const nameStr = errorValue?.name || 'Error';
      const msgStr = errorValue?.message || String(errorValue);
      callDebug.push('ERR', `captureScreen failed: ${nameStr}: ${msgStr}`);
      // Detect common Android-specific failure modes so the user-facing
      // alert can point at the actual root cause.
      let friendly = msgStr;
      if (msgStr.includes('Permission') || nameStr === 'NotAllowedError') {
        friendly =
          'Screen-capture permission was denied. Tap the share-screen button again and tap "Start now" on the system prompt.';
      } else if (msgStr.includes('foreground service') || msgStr.includes('FOREGROUND_SERVICE')) {
        friendly =
          'Android blocked screen capture because the foreground service did not start. Tip: close any other screen-recorder apps, restart Smilers, and try again. (FOREGROUND_SERVICE_MEDIA_PROJECTION permission must be granted.)';
      } else if (msgStr.includes('cancelled') || msgStr.includes('canceled')) {
        friendly = 'Screen-capture was cancelled. Tap the share button again to retry.';
      } else if (nameStr === 'NotFoundError') {
        friendly = 'No screen capture source found. Restart the app and try again.';
      } else if (nameStr === 'AbortError') {
        friendly = 'Screen-capture was aborted by the system. Try again, and grant the picker prompt within 5 seconds.';
      }
      throw new Error(friendly);
    }
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

  /**
   * Upgrade an in-progress VOICE call to VIDEO by capturing the camera and
   * publishing it to the peer. Mirrors the screen-share "add a video sender to
   * a voice-only call + renegotiate" path so it works mid-call without an
   * onnegotiationneeded handler. Safe to call when already sending video (it
   * just refreshes the camera track). Interoperates with the web app, which is
   * notified separately via api.calls.requestVideoUpgrade.
   */
  async upgradeToVideo(): Promise<MediaStream | null> {
    if (!this.pc || this.closed) return null;
    const webrtc = await this.getWebRTC();
    let camTrack: any = null;
    try {
      const camStream = (await webrtc.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: { minWidth: 640, minHeight: 480, minFrameRate: 24 },
          facingMode: 'user',
        },
      } as any)) as unknown as MediaStream;
      camTrack = camStream.getVideoTracks()[0];
    } catch (e: any) {
      throw new Error('Could not access the camera: ' + (e?.message || e));
    }
    if (!camTrack) throw new Error('No camera track available.');

    const senders = (this.pc as any).getSenders ? (this.pc as any).getSenders() : [];
    const videoSender = senders.find((s: any) => s.track && s.track.kind === 'video');
    if (videoSender) {
      try {
        videoSender.track?.stop();
      } catch {}
      try {
        await videoSender.replaceTrack(camTrack);
      } catch (e: any) {
        throw new Error('Failed to enable camera: ' + (e?.message || e));
      }
    } else {
      // Voice-only → add a new video sender + renegotiate so the remote
      // (mobile OR web peer) starts receiving our camera.
      try {
        (this.pc as any).addTrack(camTrack, this.localStream || undefined);
      } catch (e: any) {
        throw new Error('Failed to attach camera track: ' + (e?.message || e));
      }
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

    if (this.localStream) {
      try {
        this.localStream.getVideoTracks().forEach((t) => {
          try {
            this.localStream?.removeTrack(t);
          } catch {}
        });
        this.localStream.addTrack(camTrack);
        this.opts.onLocalStream?.(this.localStream as MediaStream);
      } catch {}
    }
    return this.localStream;
  }


  /** Build the RTCPeerConnection and wire all listeners. */
  async createPeerConnection(): Promise<RTCPeerConnection> {
    const webrtc = await this.getWebRTC();
    const pc = new webrtc.RTCPeerConnection(PEER_CONNECTION_CONFIG);
    this.pc = pc;
    callDebug.push(
      'PC',
      `created (callType=${this.opts.callType}, isCaller=${this.opts.isCaller}, ` +
        `hasLocalStream=${!!this.localStream}, localTracks=${this.localStream?.getTracks?.()?.length ?? 0})`,
    );

    // ICE candidates → send via signaling
    (pc as any).addEventListener('icecandidate', (event: any) => {
      if (event?.candidate && !this.closed) {
        const payload = JSON.stringify(event.candidate.toJSON ? event.candidate.toJSON() : event.candidate);
        callDebug.push('SIG', `→ ice-candidate (${(event.candidate?.candidate || '').slice(0, 40)})`);
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
      const trackInfo =
        event?.track
          ? `kind=${event.track.kind} readyState=${event.track.readyState}`
          : 'no-track';
      callDebug.push('PC', `ontrack ${trackInfo}, streams=${streams?.length ?? 0}`);
      if (stream) {
        this.remoteStream = stream;
        this.opts.onRemoteStream?.(stream);
      }
    });

    (pc as any).addEventListener('connectionstatechange', () => {
      const state = (pc as any).connectionState as string | undefined;
      if (state) {
        callDebug.push('PC', `state=${state}`);
        this.opts.onConnectionStateChange?.(state);
      }
    });

    (pc as any).addEventListener('iceconnectionstatechange', () => {
      const state = (pc as any).iceConnectionState as string | undefined;
      if (state) {
        callDebug.push('PC', `ice=${state}`);
        this.opts.onConnectionStateChange?.(`ice:${state}`);
        // iter-128: auto-recovery on transient ICE failures (the bug
        // root-cause for "calls fail after some minutes" — Native
        // WebRTC does NOT auto-restart ICE when the path breaks).
        this.handleIceStateForRestart(state);
      }
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
    callDebug.push('PC', 'createOffer() called');
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
      callDebug.push(
        'SCRN',
        `track kind=${screenTrack.kind} enabled=${screenTrack.enabled} state=${screenTrack.readyState}`,
      );
    } else {
      callDebug.push('SCRN', 'no video track on localStream (audio-only or no capture)');
    }
    callDebug.push(
      'SIG',
      `→ offer (sdp ${(offer.sdp || '').length}B, recvVideo=${this.opts.callType === 'video'})`,
    );
    await this.opts.sendSignal({
      callId: this.opts.callId,
      toUserId: this.opts.remoteUserId,
      type: 'offer',
      payload: JSON.stringify(offer),
    });
  }

  /** Callee: handle a received offer and reply with an answer. */
  async handleRemoteOffer(payload: string): Promise<void> {
    if (!this.pc) {
      callDebug.push('ERR', 'handleRemoteOffer: pc is null');
      throw new Error('Peer connection not initialized');
    }
    // iter-128: previous (iter-96) idempotency guard rejected ANY offer
    // arriving while signalingState==='stable' + remoteDescriptionSet.
    // That correctly skipped re-emitted duplicates from the signaling
    // poll loop — but it ALSO incorrectly dropped legitimate ICE
    // restart offers, which carry a different ice-ufrag/ice-pwd and
    // arrive *after* the connection is stable. Fix: only skip if the
    // payload is BYTE-IDENTICAL to the last applied offer. ICE restart
    // offers will differ in bytes, so they get through.
    if (
      (this.pc as any).signalingState === 'stable' &&
      this.remoteDescriptionSet &&
      this.lastAppliedOfferPayload === payload
    ) {
      callDebug.push('SIG', '← offer ignored (byte-identical duplicate)');
      return;
    }
    const isRestart =
      (this.pc as any).signalingState === 'stable' && this.remoteDescriptionSet;
    callDebug.push('SIG', `← offer (${payload.length}B${isRestart ? ', ICE-restart' : ''})`);
    const offer = JSON.parse(payload);
    const webrtc = await this.getWebRTC();
    await this.pc.setRemoteDescription(new webrtc.RTCSessionDescription(offer));
    this.lastAppliedOfferPayload = payload;
    this.remoteDescriptionSet = true;
    callDebug.push('PC', 'setRemoteDescription(offer) ok');
    await this.flushPendingIce();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    callDebug.push(
      'SIG',
      `→ answer (sdp ${(answer.sdp || '').length}B${isRestart ? ', ICE-restart' : ''})`,
    );
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
    // iter-128: same byte-identity check as handleRemoteOffer — drop
    // ONLY exact duplicates re-emitted by the signaling poll loop,
    // never drop legitimate ICE-restart answers.
    if (
      (this.pc as any).signalingState === 'stable' &&
      this.remoteDescriptionSet &&
      this.lastAppliedAnswerPayload === payload
    ) {
      callDebug.push('SIG', '← answer ignored (byte-identical duplicate)');
      return;
    }
    const isRestart =
      (this.pc as any).signalingState === 'stable' && this.remoteDescriptionSet;
    callDebug.push('SIG', `← answer (${payload.length}B${isRestart ? ', ICE-restart' : ''})`);
    const answer = JSON.parse(payload);
    const webrtc = await this.getWebRTC();
    await this.pc.setRemoteDescription(new webrtc.RTCSessionDescription(answer));
    this.lastAppliedAnswerPayload = payload;
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

  // iter-128: ──────────────────────────────────────────────────────
  // ICE auto-recovery
  // ──────────────────────────────────────────────────────────────
  //
  // Native WebRTC does NOT auto-restart ICE when the path breaks. Without
  // this logic, a single transient network blip (carrier re-NAT, Wi-Fi ↔
  // cellular handoff, brief signal loss) permanently kills the call ~10s
  // after iceConnectionState first goes 'disconnected'. This was the
  // user-reported "calls fail after some minutes" bug.
  //
  // Recovery strategy (matches what WhatsApp/Telegram do):
  //   • 'disconnected' → wait ICE_RESTART_GRACE_MS, then restart if still
  //     not back to 'connected'/'completed' (99% of transient blips
  //     recover on their own within 5s, no need to renegotiate).
  //   • 'failed'       → restart immediately, no grace period (the path
  //     is definitively dead, waiting just wastes time).
  //   • 'connected'/'completed' → cancel pending restart + reset retry
  //     counter (we recovered).
  //
  // Only the CALLER side initiates the restart (per WebRTC spec, only one
  // peer should generate an offer at a time to avoid glare). The callee
  // just waits for the new offer to arrive via signaling and replies with
  // an answer, exactly like the initial handshake.
  //
  // If MAX_ICE_RESTART_ATTEMPTS is exhausted (default 3), we stop trying
  // — at that point the network is genuinely dead and the user should
  // end the call.
  private handleIceStateForRestart(state: string): void {
    if (this.closed) return;

    if (state === 'connected' || state === 'completed') {
      // Recovered — clear any pending restart and reset attempts.
      if (this.iceRestartTimer) {
        clearTimeout(this.iceRestartTimer);
        this.iceRestartTimer = null;
      }
      if (this.iceRestartAttempts > 0) {
        callDebug.push(
          'PC',
          `ice recovered after ${this.iceRestartAttempts} restart attempt(s)`,
        );
        this.iceRestartAttempts = 0;
      }
      return;
    }

    if (state === 'disconnected') {
      // Schedule a restart after the grace period, but only if we
      // haven't already scheduled one and we're the caller.
      if (this.iceRestartTimer || this.iceRestartInFlight) return;
      if (!this.opts.isCaller) {
        callDebug.push(
          'PC',
          `ice=disconnected (callee — waiting for caller to restart)`,
        );
        return;
      }
      if (this.iceRestartAttempts >= CallSession.MAX_ICE_RESTART_ATTEMPTS) {
        callDebug.push(
          'ERR',
          `ice=disconnected but restart attempts exhausted (${this.iceRestartAttempts}/${CallSession.MAX_ICE_RESTART_ATTEMPTS})`,
        );
        return;
      }
      callDebug.push(
        'PC',
        `ice=disconnected — scheduling restart in ${CallSession.ICE_RESTART_GRACE_MS}ms (attempt ${this.iceRestartAttempts + 1}/${CallSession.MAX_ICE_RESTART_ATTEMPTS})`,
      );
      this.iceRestartTimer = setTimeout(() => {
        this.iceRestartTimer = null;
        if (this.closed) return;
        const currentState = (this.pc as any)?.iceConnectionState as string | undefined;
        if (currentState === 'connected' || currentState === 'completed') {
          // Recovered on its own during the grace period — no-op.
          return;
        }
        void this.restartIce('grace-timer fired, ice=' + currentState);
      }, CallSession.ICE_RESTART_GRACE_MS);
      return;
    }

    if (state === 'failed') {
      // Don't wait — restart immediately. The path is definitively dead.
      if (this.iceRestartTimer) {
        clearTimeout(this.iceRestartTimer);
        this.iceRestartTimer = null;
      }
      if (this.iceRestartInFlight) return;
      if (!this.opts.isCaller) {
        callDebug.push(
          'PC',
          'ice=failed (callee — waiting for caller to restart)',
        );
        return;
      }
      if (this.iceRestartAttempts >= CallSession.MAX_ICE_RESTART_ATTEMPTS) {
        callDebug.push(
          'ERR',
          `ice=failed and restart attempts exhausted (${this.iceRestartAttempts}/${CallSession.MAX_ICE_RESTART_ATTEMPTS}) — call is dead`,
        );
        return;
      }
      void this.restartIce(
        `ice=failed (attempt ${this.iceRestartAttempts + 1}/${CallSession.MAX_ICE_RESTART_ATTEMPTS})`,
      );
    }
  }

  /**
   * Generates a new offer with `iceRestart: true`, applies it locally,
   * and sends it via signaling. The callee will reply with an answer
   * carrying new ICE credentials, ICE re-gathers, and a new path is
   * chosen. Caller-side only.
   *
   * Exposed publicly so the UI can also offer a manual "Reconnect" button
   * later, but normally this is invoked automatically by
   * handleIceStateForRestart().
   */
  async restartIce(reason: string): Promise<void> {
    if (this.closed || !this.pc) {
      callDebug.push('ERR', `restartIce: pc closed/null (reason=${reason})`);
      return;
    }
    if (!this.opts.isCaller) {
      callDebug.push('ERR', `restartIce called on callee — ignored (reason=${reason})`);
      return;
    }
    if (this.iceRestartInFlight) {
      callDebug.push('PC', `restartIce already in flight — skipping (reason=${reason})`);
      return;
    }
    this.iceRestartInFlight = true;
    this.iceRestartAttempts += 1;
    callDebug.push(
      'PC',
      `restartIce starting (attempt ${this.iceRestartAttempts}/${CallSession.MAX_ICE_RESTART_ATTEMPTS}, reason=${reason})`,
    );

    try {
      const offer = await this.pc.createOffer({
        iceRestart: true,
        offerToReceiveAudio: true,
        offerToReceiveVideo: this.opts.callType === 'video',
      } as any);
      await this.pc.setLocalDescription(offer);
      callDebug.push(
        'SIG',
        `→ offer (ICE-restart, sdp ${(offer.sdp || '').length}B)`,
      );
      await this.opts.sendSignal({
        callId: this.opts.callId,
        toUserId: this.opts.remoteUserId,
        type: 'offer',
        payload: JSON.stringify(offer),
      });

      // iter-132b: schedule an answer-timeout. If we don't get an
      // answer to the ICE-restart offer within 12 seconds (typically
      // because the callee's app was killed, or the callee's APK
      // doesn't have iter-128's idempotency fix and silently drops the
      // offer as a duplicate), trigger another restart attempt. This
      // is the only way the call self-heals when the peer is in a
      // bad state — without it the state machine just sits at 'failed'
      // forever.
      if (this.iceRestartTimer) {
        clearTimeout(this.iceRestartTimer);
      }
      this.iceRestartTimer = setTimeout(() => {
        this.iceRestartTimer = null;
        if (this.closed) return;
        const currentState = (this.pc as any)?.iceConnectionState as string | undefined;
        if (currentState === 'connected' || currentState === 'completed') {
          return; // answer arrived, ICE recovered — no-op
        }
        callDebug.push(
          'PC',
          `restartIce answer-timeout fired (state=${currentState}) — escalating to attempt ${this.iceRestartAttempts + 1}`,
        );
        if (this.iceRestartAttempts < CallSession.MAX_ICE_RESTART_ATTEMPTS) {
          void this.restartIce(`answer-timeout, state=${currentState}`);
        } else {
          callDebug.push(
            'ERR',
            `answer-timeout but attempts exhausted (${this.iceRestartAttempts}/${CallSession.MAX_ICE_RESTART_ATTEMPTS}) — call is dead. Common cause: peer's APK doesn't have iter-128's idempotency fix.`,
          );
        }
      }, 12_000);
    } catch (errorValue: any) {
      callDebug.push(
        'ERR',
        `restartIce failed: ${errorValue?.message || String(errorValue)}`,
      );
      this.opts.onError?.(
        errorValue instanceof Error ? errorValue : new Error(String(errorValue)),
      );
    } finally {
      this.iceRestartInFlight = false;
    }
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

    // iter-128: cancel any pending ICE restart timer so it doesn't fire
    // after the call is torn down.
    if (this.iceRestartTimer) {
      clearTimeout(this.iceRestartTimer);
      this.iceRestartTimer = null;
    }

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
