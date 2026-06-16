/**
 * TwilioCallSession (Phase A.2 — skeleton).
 *
 * Thin imperative wrapper around the `<TwilioVideo>` React Native
 * component from `@twilio/video-react-native-sdk`. The component is
 * stateful and lives in the React tree; this class holds a ref to it
 * and exposes the same vocabulary the legacy `CallSession` orchestrator
 * uses, so the call screen (`/app/call/[conversationId].tsx`) can call
 * the same methods regardless of which engine is running underneath.
 *
 * Phase A.2 scope: connect, leave, mute/video toggle, flip camera,
 * event subscription. Phase A.3 wires this into the call screen behind
 * the `EXPO_PUBLIC_USE_TWILIO` flag. Phase A.4 adds participant
 * subscription helpers + recording. Phase A.5 adds screen sharing.
 *
 * The class deliberately does NOT import `@twilio/video-react-native-sdk`
 * directly — it only accepts a ref to the component instance (which the
 * React hook builds). This keeps the file safe to import on web (which
 * has no Twilio RN SDK) and on builds where Twilio is disabled.
 */

import { recordDiagnostic } from '../diagnostics';

// Mirror the SDK types loosely so we don't pull in the SDK on web.
type TwilioConnectParams = {
  roomName?: string;
  accessToken: string;
  enableAudio?: boolean;
  enableVideo?: boolean;
  enableNetworkQualityReporting?: boolean;
  dominantSpeakerEnabled?: boolean;
  region?: string | null;
};

export interface TwilioVideoRef {
  connect: (options: TwilioConnectParams) => void;
  disconnect: () => void;
  setLocalAudioEnabled: (enabled: boolean) => Promise<boolean>;
  setLocalVideoEnabled: (enabled: boolean) => Promise<boolean>;
  flipCamera: () => void;
  toggleSoundSetup: (speaker: boolean) => void;
  toggleScreenSharing?: (enabled: boolean) => void;
  publishLocalAudio: () => void;
  unpublishLocalAudio: () => void;
}

export type TwilioConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed';

/** Screen-sharing state — separate from the call connection state. */
export type ScreenShareState = 'off' | 'starting' | 'on' | 'stopping' | 'unsupported';

export interface TwilioCallSessionOptions {
  /** Stable user ID (OIDC sub / Convex user _id). Mirrors the JWT identity. */
  identity: string;
  /** Twilio room name (from /api/twilio/initiate-call or push payload). */
  roomName: string;
  /** Twilio access token JWT (from /api/twilio/video-token). */
  token: string;
  /** Whether this is a video or voice-only call. */
  isVideo: boolean;
  /** Caller vs callee — pure metadata for diagnostics. */
  isCaller: boolean;
  /** Optional region pin; falls back to whatever the token encodes. */
  region?: string;
  onStateChange?: (state: TwilioConnectionState, detail?: string) => void;
  onParticipantConnected?: (participantSid: string, identity: string) => void;
  onParticipantDisconnected?: (participantSid: string, identity: string) => void;
  onScreenShareChange?: (next: ScreenShareState) => void;
  onError?: (err: Error) => void;
}

/**
 * Imperative wrapper. Build one of these once per call lifecycle, hand
 * it the `<TwilioVideo>` ref via `attach()`, then call `connect()`.
 *
 *   const session = new TwilioCallSession({...});
 *   <TwilioVideo ref={ref => session.attach(ref)} ... />
 *   await session.connect();
 *   ...
 *   await session.leave();
 */
export class TwilioCallSession {
  public readonly opts: TwilioCallSessionOptions;
  private ref: TwilioVideoRef | null = null;
  private state: TwilioConnectionState = 'idle';
  private hasConnectedOnce = false;

  constructor(opts: TwilioCallSessionOptions) {
    this.opts = opts;
    this.log('constructed', `room=${opts.roomName} identity=${opts.identity} video=${opts.isVideo}`);
  }

  /** Attach the <TwilioVideo> component ref. Required before `connect()`. */
  attach(ref: TwilioVideoRef | null): void {
    this.ref = ref;
  }

  /** Current connection state. */
  getState(): TwilioConnectionState {
    return this.state;
  }

  /** Did we ever successfully connect during this session? */
  didConnect(): boolean {
    return this.hasConnectedOnce;
  }

  /**
   * Kick off the connection. Component-level events
   * (onRoomDidConnect / onRoomDidDisconnect / etc.) MUST be wired by
   * the host React component into `markConnected()`, `markDisconnected()`,
   * etc. — they're public so the React layer can plumb them in
   * without exposing internal state.
   */
  connect(): void {
    if (!this.ref) {
      this.fail('connect called before attach() — no Twilio ref');
      return;
    }
    if (this.state === 'connecting' || this.state === 'connected') {
      this.log('connect-skip', `already in state=${this.state}`);
      return;
    }
    this.setState('connecting');
    try {
      this.ref.connect({
        roomName: this.opts.roomName,
        accessToken: this.opts.token,
        enableAudio: true,
        enableVideo: this.opts.isVideo,
        enableNetworkQualityReporting: true,
        dominantSpeakerEnabled: true,
        region: this.opts.region || null,
      });
      this.log('connect-issued', `region=${this.opts.region || '(default)'}`);
    } catch (err: any) {
      this.fail(`connect threw: ${err?.message || err}`);
    }
  }

  /** Disconnect from the room. Idempotent — safe to call multiple times. */
  leave(): void {
    if (this.state === 'idle' || this.state === 'disconnected') {
      return;
    }
    this.log('leave', `from state=${this.state}`);
    try {
      this.ref?.disconnect();
    } catch (err: any) {
      this.log('leave-error', err?.message || String(err));
    }
    this.setState('disconnected');
  }

  /** Mute/unmute the local mic. */
  async setMuted(muted: boolean): Promise<boolean> {
    if (!this.ref) return false;
    try {
      const ok = await this.ref.setLocalAudioEnabled(!muted);
      this.log('mute', `muted=${muted} sdk_ok=${ok}`);
      return ok;
    } catch (err: any) {
      this.log('mute-error', err?.message || String(err));
      return false;
    }
  }

  /** Enable/disable local camera. */
  async setVideoEnabled(enabled: boolean): Promise<boolean> {
    if (!this.ref) return false;
    try {
      const ok = await this.ref.setLocalVideoEnabled(enabled);
      this.log('video', `enabled=${enabled} sdk_ok=${ok}`);
      return ok;
    } catch (err: any) {
      this.log('video-error', err?.message || String(err));
      return false;
    }
  }

  /** Flip between front and back camera. */
  flipCamera(): void {
    try {
      this.ref?.flipCamera();
      this.log('flip-camera');
    } catch {}
  }

  /** Route audio to loudspeaker (true) or earpiece/default (false). */
  setSpeakerOn(on: boolean): void {
    try {
      this.ref?.toggleSoundSetup(on);
      this.log('speaker', `on=${on}`);
    } catch {}
  }

  /**
   * Phase A.5 — start/stop screen sharing.
   *   - Android: the Twilio SDK uses MediaProjection internally. Permissions
   *     and FOREGROUND_SERVICE_MEDIA_PROJECTION are declared in app.json.
   *     OS shows the standard "Start now" / "Cancel" system prompt.
   *   - iOS: full-device sharing requires a ReplayKit Broadcast Upload
   *     Extension (separate Xcode target). The existing
   *     `plugins/withIosBroadcastExtension.js` config plugin is a stub
   *     — full implementation needs a native engineer. Until then, this
   *     method emits an 'unsupported' state event so the UI can show
   *     a friendly message.
   */
  setScreenShareEnabled(enabled: boolean): void {
    try {
      // The host React component reads Platform.OS and emits
      // 'unsupported' on iOS; here we just forward the toggle.
      this.ref?.toggleScreenSharing?.(enabled);
      this.log('screen-share-toggle', `requested=${enabled}`);
    } catch (err: any) {
      this.log('screen-share-error', err?.message || String(err));
    }
  }

  /** Wired by the host: SDK fired onScreenShareChanged. */
  markScreenShareState(next: ScreenShareState): void {
    this.log('screen-share-state', next);
    try {
      this.opts.onScreenShareChange?.(next);
    } catch {}
  }

  // -------------------------------------------------------------
  // PUBLIC: wired in by the React host component from SDK events
  // -------------------------------------------------------------

  markConnected(): void {
    this.hasConnectedOnce = true;
    this.setState('connected');
  }

  markReconnecting(detail?: string): void {
    this.setState('reconnecting', detail);
  }

  markReconnected(): void {
    this.setState('connected');
  }

  markDisconnected(error?: string): void {
    this.setState(error ? 'failed' : 'disconnected', error);
  }

  emitParticipantConnected(sid: string, identity: string): void {
    this.log('participant-join', `sid=${sid} identity=${identity}`);
    this.opts.onParticipantConnected?.(sid, identity);
  }

  emitParticipantDisconnected(sid: string, identity: string): void {
    this.log('participant-leave', `sid=${sid} identity=${identity}`);
    this.opts.onParticipantDisconnected?.(sid, identity);
  }

  // -------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------

  private setState(next: TwilioConnectionState, detail?: string): void {
    if (this.state === next) return;
    this.log('state', `${this.state} -> ${next}${detail ? ` (${detail})` : ''}`);
    this.state = next;
    try {
      this.opts.onStateChange?.(next, detail);
    } catch {}
  }

  private fail(msg: string): void {
    this.log('fail', msg);
    this.setState('failed', msg);
    try {
      this.opts.onError?.(new Error(`[twilio-call] ${msg}`));
    } catch {}
  }

  private log(event: string, detail?: string): void {
    try {
      recordDiagnostic({
        tag: 'TWILIO-CALL',
        source: this.opts.isCaller ? 'caller' : 'callee',
        message: `room=${this.opts.roomName} ev=${event}${detail ? ` ${detail}` : ''}`,
      });
    } catch {}
  }
}
