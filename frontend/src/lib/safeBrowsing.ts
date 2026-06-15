/**
 * safeBrowsing (iter-218)
 * ------------------------------------------------------------------
 * Client-side cache + fetcher for the FastAPI `/api/safe-browsing/check`
 * endpoint, which itself wraps Google Safe Browsing v4.
 *
 * Design goals:
 *   - URL is checked AT MOST ONCE per app session (kept in an in-memory
 *     Map). Repeated renders of the same bubble don't re-hit the network.
 *   - Fail open: if the backend / Google is unreachable, we treat the
 *     URL as safe. We never want to false-positive and hide a legitimate
 *     message.
 *   - The hook returns three states: `unknown` (still checking),
 *     `safe`, and `malicious` (with the threat type so the bubble can
 *     show a more specific warning if it wants).
 */

import { useEffect, useState } from 'react';

const BACKEND_URL = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');

export type ThreatType =
  | 'MALWARE'
  | 'SOCIAL_ENGINEERING'
  | 'UNWANTED_SOFTWARE'
  | 'POTENTIALLY_HARMFUL_APPLICATION'
  | 'UNKNOWN';

export type SafeBrowsingResult =
  | { state: 'unknown' }
  | { state: 'safe' }
  | { state: 'malicious'; threat: ThreatType };

const cache = new Map<string, SafeBrowsingResult>();
const inflight = new Map<string, Promise<SafeBrowsingResult>>();

async function fetchOne(url: string): Promise<SafeBrowsingResult> {
  if (!BACKEND_URL) return { state: 'safe' };
  try {
    const resp = await fetch(`${BACKEND_URL}/api/safe-browsing/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [url] }),
    });
    if (!resp.ok) return { state: 'safe' };
    const data = (await resp.json()) as { matches?: Array<{ url: string; threat_type?: string }> };
    const match = (data.matches || []).find((m) => m.url === url);
    if (!match) return { state: 'safe' };
    return {
      state: 'malicious',
      threat: (match.threat_type as ThreatType) || 'UNKNOWN',
    };
  } catch {
    // Fail open — never block messages because Google is unreachable.
    return { state: 'safe' };
  }
}

/**
 * Get the cached safety verdict, returning `unknown` if we haven't
 * checked yet. Use the React hook below if you want auto-refresh.
 */
export function getCachedSafety(url: string): SafeBrowsingResult {
  return cache.get(url) || { state: 'unknown' };
}

/**
 * Hook used by LinkPreviewMessage / RichMessageText to gate rendering
 * of a URL on its safety verdict. While `state === 'unknown'` callers
 * can either render the URL (preserving feed responsiveness) or render
 * a loading state — up to them.
 */
export function useUrlSafety(url: string | null | undefined): SafeBrowsingResult {
  const safeUrl = url && url.startsWith('http') ? url : '';
  const [verdict, setVerdict] = useState<SafeBrowsingResult>(() =>
    safeUrl ? cache.get(safeUrl) || { state: 'unknown' } : { state: 'safe' },
  );

  useEffect(() => {
    if (!safeUrl) {
      setVerdict({ state: 'safe' });
      return;
    }
    const cached = cache.get(safeUrl);
    if (cached) {
      setVerdict(cached);
      return;
    }
    let cancelled = false;
    let promise = inflight.get(safeUrl);
    if (!promise) {
      promise = fetchOne(safeUrl).then((result) => {
        cache.set(safeUrl, result);
        inflight.delete(safeUrl);
        return result;
      });
      inflight.set(safeUrl, promise);
    }
    promise.then((result) => {
      if (!cancelled) setVerdict(result);
    });
    return () => {
      cancelled = true;
    };
  }, [safeUrl]);

  return verdict;
}

/**
 * Human-readable label for a threat type, for use in warning bubbles.
 */
export function describeThreat(threat: ThreatType): string {
  switch (threat) {
    case 'MALWARE':
      return 'malware';
    case 'SOCIAL_ENGINEERING':
      return 'phishing / scam';
    case 'UNWANTED_SOFTWARE':
      return 'unwanted software';
    case 'POTENTIALLY_HARMFUL_APPLICATION':
      return 'potentially harmful app';
    default:
      return 'unsafe content';
  }
}

/**
 * iter-219 — DANGEROUS-FILE TYPES.
 *
 * Google Safe Browsing only flags URLs, not file contents — so a
 * malicious APK uploaded to our own Convex storage would pass a URL
 * check trivially. The pragmatic security path is to refuse to render
 * file types that are essentially never legitimate to receive from a
 * chat: APKs, EXEs, batch / shell scripts, JARs, etc.
 *
 * Photos, videos, audio, PDFs, images, office docs etc. are deliberately
 * NOT in this list — modern Android sandboxes media decoders and these
 * file types have legitimate sharing use cases. The list focuses on
 * EXECUTABLE / installer types.
 */
const DANGEROUS_EXTENSIONS = new Set([
  'apk', // Android installer
  'exe', // Windows executable
  'bat', // Windows batch
  'cmd', // Windows command
  'com', // Old DOS executable
  'msi', // Windows installer
  'scr', // Windows screensaver (often malware)
  'sh', // Unix shell script
  'bash', // Unix shell script
  'zsh', // Unix shell script
  'vbs', // VBScript
  'vbe', // VBScript encoded
  'wsf', // Windows script
  'wsh', // Windows script host
  'jar', // Java archive (can be executable)
  'jse', // JScript encoded
  'js', // JavaScript file standalone — risky as attachment
  'lnk', // Windows shortcut (often used to launch hidden payloads)
  'pif', // Program info file (legacy malware vector)
  'reg', // Registry script
  'app', // macOS app bundle
  'dmg', // macOS disk image (installer)
  'pkg', // macOS installer
  'deb', // Debian package
  'rpm', // Red Hat package
  'ipa', // iOS app
  'msix', // Windows app package
  'appx', // Windows app package
]);

const DANGEROUS_MIME_TYPES = new Set([
  'application/vnd.android.package-archive', // APK
  'application/x-msdownload', // EXE
  'application/x-msi', // MSI
  'application/x-bat',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-java-archive',
  'application/javascript', // standalone JS attachment
  'application/x-apple-diskimage', // DMG
]);

export function isDangerousFile(opts: {
  fileName?: string | null;
  mimeType?: string | null;
}): { dangerous: boolean; reason?: 'apk' | 'executable' | 'script' } {
  const fileName = (opts.fileName || '').trim().toLowerCase();
  const mime = (opts.mimeType || '').trim().toLowerCase();

  if (mime && DANGEROUS_MIME_TYPES.has(mime)) {
    if (mime.includes('android')) return { dangerous: true, reason: 'apk' };
    if (mime.includes('script') || mime.includes('javascript') || mime.includes('sh'))
      return { dangerous: true, reason: 'script' };
    return { dangerous: true, reason: 'executable' };
  }

  // Match against last extension only — `vacation.jpg.exe` correctly
  // detects `exe`, not `jpg`.
  const dot = fileName.lastIndexOf('.');
  if (dot >= 0) {
    const ext = fileName.slice(dot + 1);
    if (DANGEROUS_EXTENSIONS.has(ext)) {
      if (ext === 'apk') return { dangerous: true, reason: 'apk' };
      if (['sh', 'bash', 'zsh', 'js', 'vbs', 'vbe', 'wsf', 'wsh', 'jse', 'bat', 'cmd'].includes(ext))
        return { dangerous: true, reason: 'script' };
      return { dangerous: true, reason: 'executable' };
    }
  }

  return { dangerous: false };
}
