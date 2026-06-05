/**
 * securityScanner — heuristic-only content safety scanner.
 *
 * Goal: identify obviously-dangerous URLs or files in incoming messages
 * BEFORE they're shown to the user, and replace them with a "Deleted
 * for security reasons" placeholder. The original message is left
 * untouched in the database — only the user-facing render is hidden.
 *
 * This file is intentionally an ISLAND: it has zero React / Convex
 * imports so it can be invoked from anywhere (chat renderer,
 * notification body, channel feeds, etc.). All checks are PURE
 * functions — no side effects, no network calls.
 *
 * ── Plug-in seam ─────────────────────────────────────────────────
 * `enrichScanWithRemoteAPI` is a placeholder for a future Google
 * Safe Browsing / VirusTotal lookup. Today it's a no-op; once a
 * GOOGLE_SAFE_BROWSING_API_KEY is added to .env it can be wired up
 * without changing any call site.
 * ─────────────────────────────────────────────────────────────────
 *
 * Heuristic categories implemented:
 *   - URL with raw IPv4/IPv6 in the authority
 *   - URL with '@' in the authority (RFC 3986 deceptive user-info)
 *   - URL whose host is a Punycode-decoded look-alike (xn-- with
 *     ASCII brand keyword nearby)
 *   - URL with typosquatted brand (paypa1, micros0ft, g00gle, …)
 *   - URL with phishing keyword in path AND a non-brand host
 *   - URL using a TLD that's high-abuse in modern abuse reports
 *   - File whose extension is in the dangerous executable list
 *
 * Each finding has a `severity` so the renderer can pick between
 * BLOCK (replace) and WARN (badge but show) — currently only the
 * BLOCK class is used by the UI.
 */

export type ScanSeverity = 'block' | 'warn' | 'safe';

export interface ScanFinding {
  severity: ScanSeverity;
  code: string;
  category: 'url' | 'file' | 'other';
  reason: string;
  /** The exact substring/extension that triggered the rule, redacted to ≤80 chars. */
  evidence: string;
}

export interface ScanResult {
  severity: ScanSeverity;
  findings: ScanFinding[];
  /** Should the renderer hide the content? `block` ⇒ true. */
  shouldHide: boolean;
}

const URL_REGEX =
  /(?:https?:\/\/|www\.)[^\s<>"']+/gi;

const IPV4_HOST = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/;
const IPV6_HOST_BRACKETED = /^\[[0-9a-fA-F:]+\](?::\d+)?$/;

// Single source of truth — brands we've seen frequently typosquatted.
const BRAND_TYPOSQUAT_PATTERNS: Array<{ brand: string; pattern: RegExp }> = [
  { brand: 'paypal',     pattern: /\b(?:paypa[l1]|paypa[l1][\-_]?secure|pay-pal)\.[a-z]{2,}/i },
  { brand: 'google',     pattern: /\b(?:g[o0]{2}gle|goog[l1]e|google[\-_]?(?:verify|secure|update|signin))\.[a-z]{2,}/i },
  { brand: 'microsoft',  pattern: /\b(?:micr[o0]s[o0]ft|microsoft[\-_]?(?:login|verify|secure|account))\.[a-z]{2,}/i },
  { brand: 'apple',      pattern: /\b(?:app[l1]e[\-_]?(?:id|verify|secure|login)|app1e)\.[a-z]{2,}/i },
  { brand: 'amazon',     pattern: /\b(?:amaz[o0]n[\-_]?(?:verify|secure|login|account))\.[a-z]{2,}/i },
  { brand: 'facebook',   pattern: /\b(?:faceb[o0]{2}k[\-_]?(?:security|login|verify|recover))\.[a-z]{2,}/i },
  { brand: 'whatsapp',   pattern: /\b(?:whats[\-_]?app[\-_]?(?:verify|secure|login))\.[a-z]{2,}/i },
  { brand: 'instagram',  pattern: /\b(?:instagram[\-_]?(?:verify|secure|login|recover))\.[a-z]{2,}/i },
  { brand: 'bank',       pattern: /\b(?:bank|chase|hsbc|barclays|wells[\-_]?fargo|santander)[\-_]?(?:secure|verify|login|update)\.[a-z]{2,}/i },
];

// Phishing-y path keywords. Only fires when combined with a non-brand
// host so we don't false-positive on the real google.com/recover etc.
const PHISHING_PATH_KEYWORDS = [
  'verify-your-account',
  'account-suspended',
  'reset-password-now',
  'confirm-identity',
  'unlock-account',
  'login-issue',
  'security-alert',
  'urgent-action-required',
  'wallet-recovery',
  'crypto-airdrop-claim',
  'free-gift-card',
];

// TLDs that show up disproportionately often in abuse reports per recent
// (2024-2025) Spamhaus, Cloudflare-Radar and Interisle reports. We DON'T
// auto-block on TLD alone — it must be paired with another signal.
const HIGH_ABUSE_TLDS = new Set([
  '.xyz', '.top', '.click', '.zip', '.mov', '.bid', '.work',
  '.online', '.site', '.live', '.fit', '.review', '.fit',
  '.cyou', '.country', '.kim', '.support', '.tk', '.gq',
  '.ml', '.cf', '.ga', '.icu',
]);

// Executables / scripts that no chat application has any reason to
// auto-execute or even tempt the user to open. Lower-case, no dot.
const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'msi', 'jar',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'psm1',
  'cpl', 'msc', 'reg', 'lnk', 'inf', 'dll',
  'iso', 'img', 'vhd',          // commonly used to bypass MOTW on Windows
  'hta', 'sct',
  'apk',                         // Android sideload package
  'ipa',                         // iOS sideload package
  'dmg', 'pkg',                  // macOS installers
  'app',                         // macOS app bundle
  'sh', 'bash', 'zsh',           // Unix shells
]);

// Files we explicitly mark SAFE so future code doesn't accidentally
// false-positive on them via partial-extension match. Not used yet
// (we whitelist by negative — only block when the ext is in DANGEROUS_
// EXTENSIONS) but kept for readability.
export const COMMON_SAFE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'svg',
  'mp4', 'mov', 'webm', 'mkv', 'avi',
  'mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf',
  'csv', 'json', 'xml',
]);

function redact(s: string, max = 80): string {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Try to parse a URL and return its host part (without userinfo, with port).
 * Returns null on completely unparseable input.
 */
function safeHost(url: string): { host: string; userInfo: string; full: string } | null {
  try {
    // Prepend a scheme so the URL constructor accepts host-only inputs.
    const normalised = /^https?:\/\//i.test(url) ? url : `http://${url}`;
    const u = new URL(normalised);
    return {
      host: u.host.toLowerCase(),
      userInfo: u.username,
      full: normalised,
    };
  } catch {
    return null;
  }
}

function lastTwoLabels(host: string): string {
  // strip port
  const noPort = host.split(':')[0];
  const labels = noPort.split('.');
  if (labels.length < 2) return noPort;
  return `.${labels.slice(-1)[0]}`;
}

/**
 * Run all heuristic URL checks on a single URL string. Returns findings
 * sorted by severity (highest first).
 */
export function scanUrl(rawUrl: string): ScanFinding[] {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return [];
  const findings: ScanFinding[] = [];
  const parsed = safeHost(rawUrl);
  const host = parsed?.host || '';
  const userInfo = parsed?.userInfo || '';

  // 1) Raw IP authority — almost always either phishing or an internal
  //    scan probe. Block.
  if (host && (IPV4_HOST.test(host) || IPV6_HOST_BRACKETED.test(host))) {
    findings.push({
      severity: 'block',
      code: 'URL_RAW_IP_HOST',
      category: 'url',
      reason: 'Link points to a raw IP address — typical of phishing or malware C2.',
      evidence: redact(host),
    });
  }

  // 2) Deceptive user-info segment — http://bank.com@evil.com/...
  if (userInfo && userInfo.length > 0) {
    findings.push({
      severity: 'block',
      code: 'URL_DECEPTIVE_USERINFO',
      category: 'url',
      reason: 'Link contains a username segment (the part before "@") which is commonly used to make a malicious site look like a trusted one.',
      evidence: redact(rawUrl),
    });
  }

  // 3) Brand typosquat
  for (const { brand, pattern } of BRAND_TYPOSQUAT_PATTERNS) {
    if (pattern.test(rawUrl)) {
      findings.push({
        severity: 'block',
        code: 'URL_BRAND_TYPOSQUAT',
        category: 'url',
        reason: `Link looks like it's trying to impersonate ${brand}.`,
        evidence: redact(host || rawUrl),
      });
      break; // one match is enough
    }
  }

  // 4) Punycode look-alike. Block when xn-- is in the host AND any
  //    brand name appears in the URL string.
  if (host.includes('xn--')) {
    const lookingLikeBrand = BRAND_TYPOSQUAT_PATTERNS.some(({ brand }) =>
      rawUrl.toLowerCase().includes(brand),
    );
    if (lookingLikeBrand) {
      findings.push({
        severity: 'block',
        code: 'URL_PUNYCODE_LOOKALIKE',
        category: 'url',
        reason: 'Link uses a Punycode-encoded domain that visually mimics a well-known brand.',
        evidence: redact(host),
      });
    } else {
      findings.push({
        severity: 'warn',
        code: 'URL_PUNYCODE_GENERIC',
        category: 'url',
        reason: 'Link uses a Punycode-encoded internationalized domain (uncommon for normal websites).',
        evidence: redact(host),
      });
    }
  }

  // 5) Phishing path keyword + non-trusted host
  const lower = rawUrl.toLowerCase();
  for (const kw of PHISHING_PATH_KEYWORDS) {
    if (lower.includes(kw)) {
      const looksLikeRealBrand = ['google.com', 'apple.com', 'paypal.com', 'microsoft.com', 'amazon.com'].some((b) =>
        host.endsWith(b),
      );
      if (!looksLikeRealBrand) {
        findings.push({
          severity: 'block',
          code: 'URL_PHISHING_PATH',
          category: 'url',
          reason: `Link contains the phishing keyword "${kw}" outside of a trusted host.`,
          evidence: redact(rawUrl),
        });
      }
      break;
    }
  }

  // 6) High-abuse TLD — warn only. Paired with another signal it
  //    becomes block in `scanText` (we promote two warns → block).
  if (host) {
    const tld = lastTwoLabels(host);
    if (HIGH_ABUSE_TLDS.has(tld)) {
      findings.push({
        severity: 'warn',
        code: 'URL_HIGH_ABUSE_TLD',
        category: 'url',
        reason: `Link uses a top-level domain (${tld}) that has a high rate of abuse reports.`,
        evidence: redact(host),
      });
    }
  }

  return findings;
}

/**
 * Scan a piece of free-form text (chat message body) for ALL URLs it
 * contains and aggregate findings. Hides on any `block` finding OR on
 * 2+ `warn` findings (escalation).
 */
export function scanText(text: string): ScanResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { severity: 'safe', findings: [], shouldHide: false };
  }
  const all: ScanFinding[] = [];
  const matches = text.match(URL_REGEX) || [];
  for (const m of matches) {
    all.push(...scanUrl(m));
  }
  return summarise(all);
}

function summarise(findings: ScanFinding[]): ScanResult {
  let severity: ScanSeverity = 'safe';
  let warnCount = 0;
  for (const f of findings) {
    if (f.severity === 'block') {
      severity = 'block';
      break;
    }
    if (f.severity === 'warn') warnCount += 1;
  }
  if (severity !== 'block' && warnCount >= 2) severity = 'block';
  else if (severity !== 'block' && warnCount === 1) severity = 'warn';
  return {
    severity,
    findings,
    shouldHide: severity === 'block',
  };
}

/**
 * Scan a single file metadata blob (mimeType, fileName, size, etc.).
 * Currently looks only at the extension — future expansion can check
 * mime / signature bytes.
 */
export function scanFile(metadata: {
  fileName?: string | null;
  mimeType?: string | null;
  storageId?: string | null;
}): ScanResult {
  const name = metadata?.fileName || '';
  if (!name || typeof name !== 'string') {
    return { severity: 'safe', findings: [], shouldHide: false };
  }
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) {
    return { severity: 'safe', findings: [], shouldHide: false };
  }
  const ext = name.slice(dot + 1).toLowerCase();
  if (DANGEROUS_EXTENSIONS.has(ext)) {
    const finding: ScanFinding = {
      severity: 'block',
      code: 'FILE_DANGEROUS_EXTENSION',
      category: 'file',
      reason: `File extension ".${ext}" can execute code on your device — Smilers blocks these by default.`,
      evidence: redact(name),
    };
    return { severity: 'block', findings: [finding], shouldHide: true };
  }
  return { severity: 'safe', findings: [], shouldHide: false };
}

/**
 * High-level convenience — scan an entire message in one shot.
 * `body` is the visible text (may be undefined for media-only msgs).
 * `attachment` is the optional file/media metadata.
 */
export function scanMessage(input: {
  body?: string | null;
  attachment?: {
    fileName?: string | null;
    mimeType?: string | null;
    storageId?: string | null;
  } | null;
}): ScanResult {
  const merged: ScanFinding[] = [];
  if (typeof input?.body === 'string' && input.body.length > 0) {
    merged.push(...scanText(input.body).findings);
  }
  if (input?.attachment) {
    merged.push(...scanFile(input.attachment).findings);
  }
  return summarise(merged);
}

/**
 * Extract URLs from a free-form text. Exported for callers that want to
 * pass URLs into `enrichScanWithRemoteAPI` themselves.
 */
export function extractUrls(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const matches = text.match(URL_REGEX) || [];
  // Normalise: strip trailing punctuation that frequently glues to URLs
  // in chat ("hey http://x.com." or "see http://x.com,?"). Keeps the URL
  // recognisable to Safe Browsing's matcher.
  const cleaned = matches.map((m) => m.replace(/[.,;:!?)\]>}'"]+$/, ''));
  // De-dup
  return Array.from(new Set(cleaned));
}

// ─── Google Safe Browsing v4 integration ──────────────────────────────
//
// iter-121: replaced the no-op stub with a real Lookup-API call.
// The free tier gives 10k requests/day per API key, auto-resets at
// midnight Pacific. We aggressively cache results for 10 minutes to
// stay well under quota even on a chatty user — same URL won't be
// re-queried within a session.
//
// Key restrictions are configured server-side via Google Cloud Console
// (Smilers Safe Browsing key, restricted to Safe Browsing API only).
// If the key is invalid, missing, or quota is exceeded, we silently
// fall back to "safe" — the heuristic layer in `scanText` / `scanUrl`
// is still authoritative for offline correctness.

const SAFE_BROWSING_ENDPOINT =
  'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const SAFE_BROWSING_CLIENT_ID = 'smilers-mobile';
const SAFE_BROWSING_CLIENT_VERSION = '1.0.0';
const SAFE_BROWSING_TIMEOUT_MS = 5_000;
const SAFE_BROWSING_CACHE_TTL_MS = 10 * 60 * 1_000; // 10 minutes
const SAFE_BROWSING_CACHE_MAX_ENTRIES = 500;

// Diagnostic counters — surfaced via `getSafeBrowsingStats()` so the
// chat-debug overlay can show how many calls succeeded / were cached /
// returned a threat / failed open.
const sbStats = {
  hits: 0,        // returned from in-memory cache
  ok: 0,          // successful HTTP 200 from Google
  blocked: 0,    // total threat matches reported
  skipped: 0,    // no key configured, skipped
  errors: 0,     // HTTP error / timeout / parse error
};

// In-memory LRU cache: URL → { result, expiresAt }.
// Map preserves insertion order so we can evict the oldest entry when
// we hit `SAFE_BROWSING_CACHE_MAX_ENTRIES`.
type SbCacheValue = { result: ScanFinding | null; expiresAt: number };
const sbCache = new Map<string, SbCacheValue>();

function sbCacheGet(url: string): SbCacheValue | undefined {
  const entry = sbCache.get(url);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    sbCache.delete(url);
    return undefined;
  }
  // Touch (move to most-recently-used end of the Map).
  sbCache.delete(url);
  sbCache.set(url, entry);
  return entry;
}

function sbCacheSet(url: string, value: SbCacheValue): void {
  if (sbCache.has(url)) sbCache.delete(url);
  sbCache.set(url, value);
  // Evict oldest if over cap.
  while (sbCache.size > SAFE_BROWSING_CACHE_MAX_ENTRIES) {
    const firstKey = sbCache.keys().next().value;
    if (firstKey === undefined) break;
    sbCache.delete(firstKey);
  }
}

/** Expose counters so the diagnostic UI can render them. */
export function getSafeBrowsingStats(): Readonly<typeof sbStats> & {
  cacheSize: number;
} {
  return { ...sbStats, cacheSize: sbCache.size };
}

/** Test-only: clear the in-memory cache + counters. */
export function _resetSafeBrowsingForTesting(): void {
  sbCache.clear();
  sbStats.hits = 0;
  sbStats.ok = 0;
  sbStats.blocked = 0;
  sbStats.skipped = 0;
  sbStats.errors = 0;
}

/**
 * Map Google's threatType strings to a human-readable reason that
 * matches the tone of our local heuristic findings.
 */
function reasonForThreatType(threatType: string): string {
  switch (threatType) {
    case 'MALWARE':
      return 'Google Safe Browsing flagged this link as a known malware-distribution site.';
    case 'SOCIAL_ENGINEERING':
      return 'Google Safe Browsing flagged this link as a known phishing / social-engineering site.';
    case 'UNWANTED_SOFTWARE':
      return 'Google Safe Browsing flagged this link as a known unwanted-software / scareware site.';
    case 'POTENTIALLY_HARMFUL_APPLICATION':
      return 'Google Safe Browsing flagged this link as a known harmful-app distribution site.';
    default:
      return `Google Safe Browsing flagged this link as a threat (${threatType}).`;
  }
}

/**
 * Plug-in seam for a remote URL-reputation API.
 *
 * Sends a `threatMatches:find` request to Google Safe Browsing v4 with
 * all the provided URLs. Returns an aggregated ScanResult where every
 * matched URL contributes a `block`-severity finding. If the API key
 * isn't configured, the call short-circuits to "safe".
 *
 * NEVER throws — failures degrade silently to "safe" so the caller
 * always gets a usable result.
 */
export async function enrichScanWithRemoteAPI(urls: string[]): Promise<ScanResult> {
  if (!Array.isArray(urls) || urls.length === 0) {
    return { severity: 'safe', findings: [], shouldHide: false };
  }

  const apiKey = (process as any)?.env?.EXPO_PUBLIC_GOOGLE_SAFE_BROWSING_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10) {
    sbStats.skipped += urls.length;
    return { severity: 'safe', findings: [], shouldHide: false };
  }

  // 1) Partition URLs into cached vs. needs-lookup.
  const findings: ScanFinding[] = [];
  const needsLookup: string[] = [];
  for (const u of urls) {
    const cached = sbCacheGet(u);
    if (cached) {
      sbStats.hits += 1;
      if (cached.result) findings.push(cached.result);
    } else {
      needsLookup.push(u);
    }
  }

  if (needsLookup.length === 0) {
    return summarise(findings);
  }

  // 2) Build the API request body. Google accepts up to 500 URLs per
  //    call; we have a much smaller batch in practice.
  const requestBody = {
    client: {
      clientId: SAFE_BROWSING_CLIENT_ID,
      clientVersion: SAFE_BROWSING_CLIENT_VERSION,
    },
    threatInfo: {
      threatTypes: [
        'MALWARE',
        'SOCIAL_ENGINEERING',
        'UNWANTED_SOFTWARE',
        'POTENTIALLY_HARMFUL_APPLICATION',
      ],
      platformTypes: ['ANY_PLATFORM'],
      threatEntryTypes: ['URL'],
      threatEntries: needsLookup.map((url) => ({ url })),
    },
  };

  // 3) Fire with 5s timeout. AbortController works in RN 0.71+.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SAFE_BROWSING_TIMEOUT_MS);
  let json: any = null;
  try {
    const res = await fetch(
      `${SAFE_BROWSING_ENDPOINT}?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      sbStats.errors += 1;
      // Cache the "safe" result for failures too so we don't hammer
      // a 4xx-returning endpoint on every keystroke.
      const expiresAt = Date.now() + SAFE_BROWSING_CACHE_TTL_MS;
      for (const u of needsLookup) sbCacheSet(u, { result: null, expiresAt });
      return summarise(findings);
    }
    json = await res.json();
    sbStats.ok += 1;
  } catch {
    sbStats.errors += 1;
    return summarise(findings);
  } finally {
    clearTimeout(timeoutId);
  }

  // 4) Process matches. Google returns `{ matches: [{threat: {url}, threatType}, ...] }`
  //    OR `{}` (no key in the response) when there are no matches.
  const matches: any[] = Array.isArray(json?.matches) ? json.matches : [];
  const matchedUrls = new Map<string, string>(); // url → threatType
  for (const m of matches) {
    const matchedUrl = m?.threat?.url;
    const threatType = String(m?.threatType || 'UNKNOWN');
    if (typeof matchedUrl === 'string' && matchedUrl.length > 0) {
      matchedUrls.set(matchedUrl, threatType);
    }
  }

  const expiresAt = Date.now() + SAFE_BROWSING_CACHE_TTL_MS;
  for (const u of needsLookup) {
    const threatType = matchedUrls.get(u);
    if (threatType) {
      const finding: ScanFinding = {
        severity: 'block',
        code: 'URL_GOOGLE_SAFE_BROWSING',
        category: 'url',
        reason: reasonForThreatType(threatType),
        evidence: redact(u),
      };
      sbCacheSet(u, { result: finding, expiresAt });
      findings.push(finding);
      sbStats.blocked += 1;
    } else {
      sbCacheSet(u, { result: null, expiresAt });
    }
  }

  return summarise(findings);
}

/**
 * Helper for the renderer — returns the explanation string we want to
 * show in the "deleted for security reasons" bubble's tooltip / "Why?"
 * sheet. Joins all unique reasons with semicolons and caps length.
 */
export function explainScanResult(result: ScanResult, max = 240): string {
  if (!result || !result.findings || result.findings.length === 0) return '';
  const reasons = Array.from(new Set(result.findings.map((f) => f.reason)));
  const joined = reasons.join(' · ');
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined;
}
