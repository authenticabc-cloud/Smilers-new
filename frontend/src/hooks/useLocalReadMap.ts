/**
 * useLocalReadMap — reactive access to the on-device local-read overlay
 * (see src/lib/localReadState). Re-renders the consumer whenever any
 * conversation is locally marked read / unread, so list badges update
 * instantly when returning from a chat.
 */
import { useEffect, useState } from 'react';
import { getLocalReadMap, loadLocalRead, subscribeLocalRead } from '../lib/localReadState';

export function useLocalReadMap(): Record<string, number> {
  const [map, setMap] = useState<Record<string, number>>(getLocalReadMap());
  useEffect(() => {
    let alive = true;
    void loadLocalRead().then((m) => {
      if (alive) setMap({ ...m });
    });
    const unsub = subscribeLocalRead(() => setMap({ ...getLocalReadMap() }));
    return () => {
      alive = false;
      unsub();
    };
  }, []);
  return map;
}
