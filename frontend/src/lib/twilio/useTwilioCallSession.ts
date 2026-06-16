/**
 * useTwilioCallSession — web stub (Twilio Video RN SDK has no web build).
 *
 * Metro auto-prefers `useTwilioCallSession.native.ts` on iOS/Android,
 * so this file is only loaded by the web preview. Returning a fail-fast
 * shape lets the call screen render an explanatory message instead of
 * crashing the bundle.
 */
import type { TwilioCallSession, TwilioConnectionState } from './TwilioCallSession';

export interface TwilioCallHostState {
  session: TwilioCallSession | null;
  state: TwilioConnectionState;
  participants: { sid: string; identity: string; videoTrackSid?: string }[];
  videoElement: any;
  renderLocalView: (style?: any, enabled?: boolean) => null;
  renderParticipantView: (
    participant: { sid: string; identity: string; videoTrackSid?: string },
    style?: any,
  ) => null;
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
}

export function useTwilioCallSession(_args: UseTwilioCallSessionArgs): TwilioCallHostState {
  return {
    session: null,
    state: 'failed',
    participants: [],
    videoElement: null,
    renderLocalView: () => null,
    renderParticipantView: () => null,
    isSupported: false,
    error: 'Twilio Video is not supported on web. Open this screen from a mobile build.',
  };
}
