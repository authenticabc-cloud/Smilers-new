/**
 * textScamScan — AI Safety Shield for text-based scams / phishing.
 * ------------------------------------------------------------------
 * Client-side cache + fetcher for the FastAPI `/api/scan-text` endpoint,
 * which classifies an incoming chat message with an LLM (conservative)
 * as a clear scam / phishing / investment-fraud message.
 *
 * The URL/file security layer (`securityScanner` + Safe Browsing) only
 * catches malicious links. This catches TEXT cons that carry no link:
 * fake prize wins, crypto/investment fraud, account-phishing, and
 * advance-fee / "send money" scams.
 *
 * Design mirrors safeBrowsing.ts:
 *   - Each message is checked AT MOST ONCE per session (in-memory cache).
 *   - Fail open: backend/LLM unreachable ⇒ treated as safe.
 *   - Only invoked for INCOMING messages (see MessageBubble).
 */

import { useEffect, useState } from 'react';
import { fetchWithRetryAfter } from './fetchWithRetryAfter';

const BACKEND_URL = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');

export type ScamCategory = 'scam' | 'phishing' | 'investment_fraud' | 'safe';

export type TextScamResult =
  | { state: 'unknown' }
  | { state: 'safe' }
  | { state: 'scam'; category: ScamCategory; reason: string };

const cache = new Map<string, TextScamResult>();
const inflight = new Map<string, Promise<TextScamResult>>();

function keyOf(text: string): string {
  return text.trim().slice(0, 4000);
}

async function fetchOne(text: string): Promise<TextScamResult> {
  if (!BACKEND_URL) return { state: 'safe' };
  try {
    const resp = await fetchWithRetryAfter(
      `${BACKEND_URL}/api/scan-text`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 4000) }),
      },
      { maxWaitMs: 8000 },
    );
    if (!resp.ok) return { state: 'safe' };
    const data = (await resp.json()) as {
      is_scam?: boolean;
      category?: string;
      reason?: string;
    };
    if (!data.is_scam) return { state: 'safe' };
    return {
      state: 'scam',
      category: (data.category as ScamCategory) || 'scam',
      reason: (data.reason || 'This message was flagged as a likely scam.').trim(),
    };
  } catch {
    // Fail open — never hide a legitimate message because the LLM is down.
    return { state: 'safe' };
  }
}

/**
 * Hook: returns the scam verdict for a message body. Pass `enabled=false`
 * (e.g. for your own outgoing messages) to skip scanning entirely.
 */
export function useTextScamScan(
  text: string | null | undefined,
  enabled: boolean,
): TextScamResult {
  const body = typeof text === 'string' ? text.trim() : '';
  // Too short / disabled ⇒ never scan.
  const shouldScan = enabled && body.length >= 12;

  const [verdict, setVerdict] = useState<TextScamResult>(() => {
    if (!shouldScan) return { state: 'safe' };
    return cache.get(keyOf(body)) || { state: 'unknown' };
  });

  useEffect(() => {
    if (!shouldScan) {
      setVerdict({ state: 'safe' });
      return;
    }
    const k = keyOf(body);
    const cached = cache.get(k);
    if (cached) {
      setVerdict(cached);
      return;
    }
    let cancelled = false;
    let promise = inflight.get(k);
    if (!promise) {
      promise = fetchOne(body).then((result) => {
        cache.set(k, result);
        inflight.delete(k);
        return result;
      });
      inflight.set(k, promise);
    }
    promise.then((result) => {
      if (!cancelled) setVerdict(result);
    });
    return () => {
      cancelled = true;
    };
  }, [shouldScan, body]);

  return verdict;
}

/** Human-readable reason fallback per category. */
export function describeScamCategory(category: ScamCategory): string {
  switch (category) {
    case 'phishing':
      return 'Flagged as a phishing attempt.';
    case 'investment_fraud':
      return 'Flagged as an investment / crypto scam.';
    case 'scam':
      return 'Flagged as a likely scam.';
    default:
      return '';
  }
}
