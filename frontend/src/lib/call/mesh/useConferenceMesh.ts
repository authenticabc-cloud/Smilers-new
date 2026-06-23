/**
 * useConferenceMesh — drives the multi-party WebRTC voice mesh inside a
 * Conference room, interoperating with the Smilers WEB conference mesh.
 *
 * Web contract (confirmed by the web team):
 *   - Conferences use `conferenceId` (NOT a `callId`). There is no `initiateCall`.
 *   - Roster / join / leave / mute → `api.conferenceRoom.*`.
 *   - Offer/answer/ICE signaling → `api.conferenceSignaling.*` (separate from the
 *     `api.signaling.*` channel used by 1:1 + group calls).
 *   - Mesh connects to `peerUserIds` (other active participants, breakout-scoped).
 *
 * The negotiation engine is the shared, transport-agnostic `MeshController` /
 * `MeshPeer` (same perfect-negotiation / politeness rules as group calls), so
 * web↔mobile conferences converge identically. Voice only for now.
 *
 * NATIVE ONLY — react-native-webrtc does not run on web/Expo Go.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useMutation } from 'convex/react';

import { api } from '../../../convexApi';
import { useReactiveSafeConvexQuery } from '../../../hooks/useReactiveSafeConvexQuery';
import type { MeshController as MeshControllerType } from './MeshController';

type Any = any;

interface UseConferenceMeshArgs {
  conferenceId?: string;
  myUserId?: string;
  peerUserIds: string[];
  /** True once the user has joined the room and we have a valid identity. */
  isActive: boolean;
  /** Mirror of the user's mute state — false mutes the local mic track. */
  micEnabled: boolean;
}

interface UseConferenceMeshResult {
  /** userId → true once a remote audio stream is flowing. */
  connectedPeers: Record<string, boolean>;
}

export function useConferenceMesh({
  conferenceId,
  myUserId,
  peerUserIds,
  isActive,
  micEnabled,
}: UseConferenceMeshArgs): UseConferenceMeshResult {
  const isWeb = Platform.OS === 'web';
  const enabled = !isWeb && !!conferenceId && !!myUserId && isActive;

  const sendSignalM = useMutation((api as Any).conferenceSignaling.send);
  const markConsumedM = useMutation((api as Any).conferenceSignaling.markConsumed);

  const controllerRef = useRef<MeshControllerType | null>(null);
  const [connectedPeers, setConnectedPeers] = useState<Record<string, boolean>>({});

  // Build the controller + acquire the mic once we're active.
  useEffect(() => {
    if (!enabled || controllerRef.current) return;
    let disposed = false;
    (async () => {
      try {
        const { MeshController } = await import('./MeshController');
        const { InCallAudio } = await import('../../webrtc/inCallManager');
        const controller = new MeshController({
          callId: conferenceId as string, // opaque shared-room id (not used for signaling)
          myUserId: myUserId as string,
          sendSignal: (toUserId, type, payload) => {
            void sendSignalM({ conferenceId, toUserId, type, payload } as Any).catch(() => {});
          },
          onRemoteStreamsChanged: (streams) => {
            if (disposed) return;
            const map: Record<string, boolean> = {};
            Object.keys(streams).forEach((id) => {
              map[id] = true;
            });
            setConnectedPeers(map);
          },
        });
        controllerRef.current = controller;
        await controller.start();
        try {
          InCallAudio.start('audio');
          InCallAudio.setSpeakerOn?.(true);
        } catch {}
        controller.setMicEnabled(micEnabled);
        if (disposed) {
          controller.close();
          controllerRef.current = null;
        }
      } catch {
        /* mic denied / webrtc unavailable — room still works for chat/roster */
      }
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, conferenceId, myUserId]);

  // Teardown on unmount.
  useEffect(() => {
    return () => {
      try {
        controllerRef.current?.close();
      } catch {}
      controllerRef.current = null;
      if (!isWeb) {
        import('../../webrtc/inCallManager')
          .then((m) => m.InCallAudio.stop())
          .catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile peers as the roster changes.
  const stablePeers = useMemo(
    () => peerUserIds.filter((id) => id && id !== myUserId),
    [peerUserIds, myUserId],
  );
  useEffect(() => {
    controllerRef.current?.syncParticipants(stablePeers);
  }, [stablePeers]);

  // Reflect mute changes onto the local mic track.
  useEffect(() => {
    controllerRef.current?.setMicEnabled(micEnabled);
  }, [micEnabled]);

  // Route incoming signaling messages, then mark them consumed.
  const signalsQ = useReactiveSafeConvexQuery<Any[]>(
    (api as Any).conferenceSignaling.poll,
    enabled && conferenceId ? { conferenceId } : undefined,
    [],
    !!(enabled && conferenceId),
  );
  const rawSignals = (signalsQ.data || []) as Any[];

  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl || !myUserId || rawSignals.length === 0) return;
    const mine = rawSignals.filter(
      (s) => s && String(s.toUserId) === myUserId && String(s.fromUserId) !== myUserId,
    );
    if (mine.length === 0) return;
    mine.forEach((s) => {
      try {
        ctrl.handleSignal(String(s.fromUserId), s.type, String(s.payload));
      } catch {}
    });
    const ids = mine.map((s) => s._id).filter(Boolean);
    if (ids.length > 0) void markConsumedM({ messageIds: ids } as Any).catch(() => {});
  }, [rawSignals, myUserId, markConsumedM]);

  return { connectedPeers };
}
