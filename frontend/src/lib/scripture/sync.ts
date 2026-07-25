/**
 * "Read with all" sync — the reader (leader) broadcasts the current reading
 * position over the ACTIVE Stream call's custom-event channel; followers in the
 * same study-room call receive it and jump/scroll to match. Best-effort and
 * NATIVE-only (needs a live Stream call).
 */
import { useCallback, useEffect, useRef } from 'react';
import { createStreamVideoClient } from '../stream/streamClient';

const EVENT_TYPE = 'smilers.scripture';

export type ScripturePosition = {
  material: 'bible' | 'quran';
  translation?: string; // bible
  edition?: string; // quran
  book?: number; // bible book nr
  chapter?: number; // bible chapter
  surah?: number; // quran surah
  scrollPct: number; // 0..1 scroll fraction
  leaderId: string;
  ts: number;
};

async function getActiveCall(): Promise<any | null> {
  try {
    const client: any = await createStreamVideoClient();
    if (!client) return null;
    const calls: any[] = client.state?.calls || [];
    // Prefer a joined call; otherwise the most recent one.
    const joined = calls.find((c) => c?.state?.callingState === 'joined');
    return joined || calls[0] || null;
  } catch {
    return null;
  }
}

/**
 * @param enabled   whether sync is active ("read with all")
 * @param isLeader  true for the person reading to the group
 * @param onRemote  follower callback when the leader's position arrives
 */
export function useScriptureSync(
  enabled: boolean,
  isLeader: boolean,
  onRemote: (pos: ScripturePosition) => void,
) {
  const callRef = useRef<any>(null);
  const onRemoteRef = useRef(onRemote);
  onRemoteRef.current = onRemote;

  useEffect(() => {
    if (!enabled) return;
    let unsub: (() => void) | null = null;
    let mounted = true;
    (async () => {
      const call = await getActiveCall();
      if (!mounted) return;
      callRef.current = call;
      if (!call || isLeader) return;
      try {
        unsub = call.on('custom', (event: any) => {
          const custom = event?.custom || event;
          if (!custom || custom.__type !== EVENT_TYPE) return;
          const pos = custom.pos as ScripturePosition;
          if (pos) onRemoteRef.current(pos);
        });
      } catch {
        /* older SDKs may not expose .on('custom') */
      }
    })();
    return () => {
      mounted = false;
      try {
        unsub?.();
      } catch {}
    };
  }, [enabled, isLeader]);

  const broadcast = useCallback(
    (pos: ScripturePosition) => {
      if (!enabled || !isLeader) return;
      const call = callRef.current;
      if (!call) return;
      try {
        call.sendCustomEvent({ __type: EVENT_TYPE, pos });
      } catch {
        /* best-effort */
      }
    },
    [enabled, isLeader],
  );

  return { broadcast, hasCall: !!callRef.current };
}
