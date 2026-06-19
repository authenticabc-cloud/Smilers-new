/**
 * useTwilioCallSession — web stub (Twilio Video RN SDK has no web build).
 *
 * Metro auto-prefers `useTwilioCallSession.native.ts` on iOS/Android,
 * so this file is only loaded by the web preview. Returning a fail-fast
 * shape lets the call screen render an explanatory message instead of
 * crashing the bundle.
 */
import type { TwilioCallSession, TwilioConnectionState, ScreenShareState } from './TwilioCallSession';

export interface TwilioCallHostState {
  session: TwilioCallSession | null;
  state: TwilioConnectionState;
  participants: { sid: string; identity: string; videoTrackSid?: string }[];
  videoElement: any;
  screenShareState: ScreenShareState;
  renderLocalView: (style?: any, enabled?: boolean) => null;
  renderParticipantView: (
    participant: { sid: string; identity: string; videoTrackSid?: string },
    style?: any,
  ) => null;
  renderParticipantScreenView: (
    participant: { sid: string; identity: string; videoTrackSid?: string },
    style?: any,
  ) => null;
  renderScreenShareView: (enabled: boolean, style?: any) => null;
  isSupported: boolean;
  error: string | null;
}

export interface UseTwilioCallSessionArgs {
  identity: string;
  roomName: string;
  token: string;
  isVideo: boolean;
  isCaller: boolean;
  region?: string;
  enabled?: boolean;
  onDataMessage?: (message: string) => void;
}

export function useTwilioCallSession(_args: UseTwilioCallSessionArgs): TwilioCallHostState {
  return {
    session: null,
    state: 'failed',
    participants: [],
    videoElement: null,
    screenShareState: 'unsupported',
    renderLocalView: () => null,
    renderParticipantView: () => null,
    renderParticipantScreenView: () => null,
    renderScreenShareView: () => null,
    isSupported: false,
    error: 'Twilio Video is not supported on web. Open this screen from a mobile build.',
  };
}
