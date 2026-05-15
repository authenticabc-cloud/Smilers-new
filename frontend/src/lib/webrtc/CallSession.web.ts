// Web stub for CallSession — react-native-webrtc is native-only and would crash
// the web bundler if pulled in. The native version lives in CallSession.ts.
// Metro automatically picks this file when bundling for the web platform.

export type SignalType = 'offer' | 'answer' | 'ice-candidate';

export type SignalMessage = {
  callId: string;
  toUserId: string;
  type: SignalType;
  payload: string;
};

export type CallSessionOptions = {
  callType: 'voice' | 'video';
  isCaller: boolean;
  callId: string;
  remoteUserId: string;
  sendSignal: (signal: SignalMessage) => Promise<void> | void;
  onRemoteStream?: (stream: any) => void;
  onLocalStream?: (stream: any) => void;
  onConnectionStateChange?: (state: string) => void;
  onError?: (err: Error) => void;
};

/**
 * Web stub: real WebRTC implementation is in CallSession.ts (native only).
 * On web, the call screen falls back to the avatar/status UI without media.
 */
export class CallSession {
  public readonly opts: CallSessionOptions;
  public pc: any = null;
  public localStream: any = null;
  public remoteStream: any = null;

  constructor(opts: CallSessionOptions) {
    this.opts = opts;
  }

  async initLocalMedia(_useScreen?: boolean): Promise<any> {
    return null;
  }

  async startScreenShare(): Promise<any> {
    return null;
  }

  async stopScreenShare(_restoreVideo?: boolean): Promise<void> {
    // no-op on web
  }

  createPeerConnection(): any {
    return null;
  }

  async createOffer(): Promise<void> {
    // no-op on web
  }

  async handleRemoteOffer(_payload: string): Promise<void> {
    // no-op on web
  }

  async handleRemoteAnswer(_payload: string): Promise<void> {
    // no-op on web
  }

  async handleRemoteIceCandidate(_payload: string): Promise<void> {
    // no-op on web
  }

  setMuted(_muted: boolean): boolean {
    return false;
  }

  setCameraOff(_off: boolean): boolean {
    return false;
  }

  switchCamera(): void {
    // no-op on web
  }

  close(): void {
    // no-op on web
  }
}
