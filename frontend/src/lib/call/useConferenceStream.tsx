/**
 * Conference media — Stream SFU (Task 1 migration).
 *
 * Drop-in replacement for the legacy mesh (`useConferenceMesh` + per-peer
 * `RTCPeerConnection`s). All conference ORCHESTRATION (roles, motions, polls,
 * chat, lobby, minutes, timer …) still lives on the external Convex backend and
 * is untouched — this provider ONLY moves the audio/video transport onto
 * Stream's global SFU, so N participants scale as one upstream + one downstream
 * per client instead of an O(n²) mesh.
 *
 * Everyone in the same conference joins ONE Stream call keyed by the
 * conferenceId, so Stream mixes/routes all tracks. The live participant list
 * comes from Stream itself (keyed by the user's Stream id === Convex user id).
 *
 * NATIVE only — the Stream RN SDK is not bundled on web/Expo Go, so on web we
 * render children with an empty media context (avatar tiles), exactly like the
 * old mesh degraded there.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform } from 'react-native';

import { createStreamVideoClient } from '../stream/streamClient';

export interface ConferenceMedia {
  ready: boolean;
  /** Stream participant object keyed by Convex/Stream user id (for ParticipantView). */
  byUserId: Record<string, any>;
  /** Speaking flags keyed by user id; `__local` is this device. */
  speaking: Record<string, boolean> & { __local?: boolean };
  setMic: (on: boolean) => void;
  setCam: (on: boolean) => void;
  /** Stream's <ParticipantView/> component (native only) for rendering tiles. */
  ParticipantView: any | null;
}

const EMPTY: ConferenceMedia = {
  ready: false,
  byUserId: {},
  speaking: {},
  setMic: () => {},
  setCam: () => {},
  ParticipantView: null,
};

const Ctx = createContext<ConferenceMedia>(EMPTY);

export function useConferenceStreamMedia(): ConferenceMedia {
  return useContext(Ctx);
}

function sanitizeCallId(conferenceId: string): string {
  return `conf_${String(conferenceId).replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 50)}`;
}

/**
 * Bridge — rendered INSIDE <StreamCall>. Reads the live Stream participant list
 * and exposes it + mic/cam controls through the React context to the screen.
 */
function MediaBridge({
  sdk,
  callRef,
  ParticipantView,
  children,
}: {
  sdk: any;
  callRef: React.MutableRefObject<any>;
  ParticipantView: any;
  children: React.ReactNode;
}) {
  const { useParticipants } = sdk.useCallStateHooks();
  const participants = useParticipants();

  const { byUserId, speaking } = useMemo(() => {
    const map: Record<string, any> = {};
    const spk: Record<string, boolean> & { __local?: boolean } = {};
    for (const p of participants || []) {
      const uid = String(p?.userId || '');
      if (!uid) continue;
      map[uid] = p;
      spk[uid] = !!p?.isSpeaking;
      if (p?.isLocalParticipant) spk.__local = !!p?.isSpeaking;
    }
    return { byUserId: map, speaking: spk };
  }, [participants]);

  const setMic = useCallback((on: boolean) => {
    const call = callRef.current;
    if (!call) return;
    try {
      (on ? call.microphone.enable() : call.microphone.disable())?.catch?.(() => {});
    } catch {}
  }, [callRef]);

  const setCam = useCallback((on: boolean) => {
    const call = callRef.current;
    if (!call) return;
    try {
      (on ? call.camera.enable() : call.camera.disable())?.catch?.(() => {});
    } catch {}
  }, [callRef]);

  const value = useMemo<ConferenceMedia>(
    () => ({ ready: true, byUserId, speaking, setMic, setCam, ParticipantView }),
    [byUserId, speaking, setMic, setCam, ParticipantView],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function ConferenceStreamProvider({
  conferenceId,
  isActive,
  children,
}: {
  conferenceId?: string;
  isActive: boolean;
  children: React.ReactNode;
}) {
  const isWeb = Platform.OS === 'web';
  const [sdk, setSdk] = useState<any>(null);
  const [client, setClient] = useState<any>(null);
  const [call, setCall] = useState<any>(null);
  const callRef = useRef<any>(null);

  // Load the native SDK (never on web).
  useEffect(() => {
    if (isWeb || !isActive) return;
    let cancelled = false;
    (async () => {
      try {
        // @ts-expect-error native-only SDK, resolved in the iOS/Android build
        const mod = await import('@stream-io/video-react-native-sdk');
        if (!cancelled) setSdk(mod);
      } catch {
        /* SDK unavailable — degrade to avatar tiles */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isWeb, isActive]);

  // Create + join the conference's Stream call once the SDK is ready.
  useEffect(() => {
    if (isWeb || !isActive || !sdk || !conferenceId) return;
    let disposed = false;
    let joined: any = null;
    (async () => {
      try {
        const c = await createStreamVideoClient();
        if (!c || disposed) return;
        const roomId = sanitizeCallId(conferenceId);
        joined = c.call('default', roomId);
        callRef.current = joined;
        // Start muted-camera; the screen drives mic/cam via setMic/setCam once
        // it knows the conference type + the user's toggle state.
        await joined.camera.disable().catch(() => {});
        await joined.join({ create: true });
        if (disposed) {
          joined.leave().catch(() => {});
          return;
        }
        setClient(c);
        setCall(joined);
      } catch {
        /* join failed — screen stays on avatar tiles */
      }
    })();
    return () => {
      disposed = true;
      callRef.current = null;
      try {
        joined?.leave?.().catch(() => {});
      } catch {}
    };
  }, [isWeb, isActive, sdk, conferenceId]);

  if (isWeb || !sdk || !client || !call) {
    // Not (yet) connected — render children with the empty media context so the
    // full conference UI still works (avatar tiles).
    return <Ctx.Provider value={EMPTY}>{children}</Ctx.Provider>;
  }

  const { StreamVideo, StreamCall, ParticipantView } = sdk;
  return (
    <StreamVideo client={client}>
      <StreamCall call={call}>
        <MediaBridge sdk={sdk} callRef={callRef} ParticipantView={ParticipantView}>
          {children}
        </MediaBridge>
      </StreamCall>
    </StreamVideo>
  );
}
