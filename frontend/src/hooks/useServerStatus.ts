import { useEffect, useState } from 'react';

const BACKEND_URL = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');

export interface ServerStatus {
  status: 'ok' | 'degraded';
  degraded: string[];
}

/**
 * Lightweight one-shot fetch of GET /api/health. Used to surface a proactive
 * "some services are degraded" notice. Fails silent (returns null) so a
 * transient network blip never shows a false alarm.
 */
export function useServerStatus(): { status: ServerStatus | null; loading: boolean } {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${BACKEND_URL}/api/health`);
        if (!resp.ok) throw new Error(String(resp.status));
        const data = await resp.json();
        if (!cancelled) {
          setStatus({ status: data.status, degraded: Array.isArray(data.degraded) ? data.degraded : [] });
        }
      } catch {
        if (!cancelled) setStatus(null); // fail silent — no false alarm
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { status, loading };
}
