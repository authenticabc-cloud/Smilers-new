import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';

import { api } from '../../convexApi';
import { CallSession } from '../webrtc/CallSession';
import { callDebug } from '../callDebugLog';

export type SecondaryCallInfo = {
  callId: string;
  remoteUserId: string;
  callType: 'voice' | 'video';
};

/**
 * useSecondaryCall (iter-327 — CALL WAITING Phase 2)
 *
 * Runs a SECOND, independent 1:1 WebRTC session ALONGSIDE the primary call so
 * the user can hold one call and talk on the other (true media hold). We are
 * always the ANSWERER for the second call (it's the incoming one), so we only
 * need: answerCall → initLocalMedia → createPeerConnection → feed the caller's
 * offer/ICE from `signaling.poll({ callId })` into the session (it replies with
 * the answer + ICE automatically).
 *
 * "Hold" is a purely CLIENT-side media action (agreed contract): mute our mic,
 * pause our camera, and stop rendering/playing the remote track. The peer
 * connection stays alive. No backend/signaling changes required.
 *
 * Fully additive: when `active` is false this hook does nothing and has ZERO
 * effect on the primary single-call flow.
 */
export function useSecondaryCall({
  active,
  call,
  isAuthenticated,
}: {
  active: boolean;
  call: SecondaryCallInfo | null;
  isAuthenticated: boolean;
}) {
  const answerCall = useMutation(api.calls.answerCall);
  const endCall = useMutation(api.calls.endCall);
  const sendSignal = useMutation(api.signaling.send);
  const markConsumed = useMutation(api.signaling.markConsumed);

  const callId = active && call ? call.callId : null;
  const signals = useQuery(
    (api as any).signaling.poll,
    callId && isAuthenticated ? { callId } : 'skip',
  ) as any[] | undefined;

  const sessionRef = useRef<CallSession | null>(null);
  const startedRef = useRef<string | null>(null);
  const [remoteStreamURL, setRemoteStreamURL] = useState<string | null>(null);
  const [localStreamURL, setLocalStreamURL] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [held, setHeldState] = useState(false);

  // Start / stop the secondary session as `active` + `call` change.
  useEffect(() => {
    if (!active || !call?.callId || !call?.remoteUserId || !isAuthenticated) return;
    if (startedRef.current === call.callId) return; // already started
    startedRef.current = call.callId;
    let cancelled = false;

    (async () => {
      try {
        callDebug.push('CALL', `[secondary] answering ${String(call.callId).slice(0, 8)}…`);
        try {
          await answerCall({ callId: call.callId });
        } catch (e: any) {
          callDebug.push('ERR', `[secondary] answerCall failed: ${String(e?.message || e)}`);
        }
        if (cancelled) return;

        const session = new CallSession({
          callType: call.callType,
          isCaller: false, // the incoming call → we answer
          callId: call.callId,
          remoteUserId: call.remoteUserId,
          sendSignal: async (sig) => {
            try {
              await sendSignal(sig as any);
            } catch (e: any) {
              const msg = String(e?.message || '');
              if (
                (msg.includes('ArgumentValidationError') || msg.toLowerCase().includes('literal')) &&
                sig.type === 'ice-candidate'
              ) {
                try {
                  await sendSignal({ ...sig, type: 'iceCandidate' } as any);
                } catch {}
              }
            }
          },
          onRemoteStream: (stream) => {
            try {
              setRemoteStreamURL((stream as any).toURL());
            } catch {}
          },
          onLocalStream: (stream) => {
            try {
              setLocalStreamURL((stream as any).toURL());
            } catch {}
          },
          onConnectionStateChange: (state) => {
            if (state === 'connected') setConnected(true);
            if (state === 'failed' || state === 'closed') setConnected(false);
          },
          onError: (err) => callDebug.push('ERR', `[secondary] ${err?.message}`),
        });
        sessionRef.current = session;

        await session.initLocalMedia(false);
        if (cancelled) {
          session.close();
          return;
        }
        await session.createPeerConnection();
        callDebug.push('CALL', '[secondary] pc ready, awaiting offer');
      } catch (e: any) {
        callDebug.push('ERR', `[secondary] start failed: ${String(e?.message || e)}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, call, isAuthenticated, answerCall, sendSignal]);

  // Feed incoming signaling messages into the secondary session.
  useEffect(() => {
    if (!signals || !Array.isArray(signals) || signals.length === 0) return;
    const session = sessionRef.current;
    if (!session) return;
    const ids: string[] = [];
    (async () => {
      for (const msg of signals) {
        try {
          if (msg.type === 'offer') await session.handleRemoteOffer(msg.payload);
          else if (msg.type === 'answer') await session.handleRemoteAnswer(msg.payload);
          else if (msg.type === 'ice-candidate' || msg.type === 'iceCandidate' || msg.type === 'ice')
            await session.handleRemoteIceCandidate(msg.payload);
          ids.push(msg._id);
        } catch (e: any) {
          callDebug.push('ERR', `[secondary] signal ${msg.type} failed: ${String(e?.message || e)}`);
        }
      }
      if (ids.length > 0) {
        try {
          await markConsumed({ messageIds: ids });
        } catch {}
      }
    })();
  }, [signals, markConsumed]);

  // Apply / release media hold.
  const setHeld = (nextHeld: boolean) => {
    const session = sessionRef.current;
    setHeldState(nextHeld);
    if (!session) return;
    try {
      session.setMuted(nextHeld);
      if (session.opts.callType === 'video') session.setCameraOff(nextHeld);
      // Stop playing the remote audio (and video) while held.
      const remote: any = (session as any).remoteStream;
      if (remote?.getTracks) {
        remote.getTracks().forEach((t: any) => {
          t.enabled = !nextHeld;
        });
      }
    } catch (e: any) {
      callDebug.push('ERR', `[secondary] setHeld failed: ${String(e?.message || e)}`);
    }
  };

  const teardown = (opts?: { endOnServer?: boolean }) => {
    const session = sessionRef.current;
    const id = call?.callId || null;
    try {
      session?.close();
    } catch {}
    sessionRef.current = null;
    startedRef.current = null;
    setRemoteStreamURL(null);
    setLocalStreamURL(null);
    setConnected(false);
    setHeldState(false);
    if (opts?.endOnServer && id) {
      void endCall({ callId: id }).catch(() => {});
    }
  };

  // Tear down when the hook unmounts.
  useEffect(() => {
    return () => {
      try {
        sessionRef.current?.close();
      } catch {}
      sessionRef.current = null;
    };
  }, []);

  return { remoteStreamURL, localStreamURL, connected, held, setHeld, teardown, session: sessionRef };
}
