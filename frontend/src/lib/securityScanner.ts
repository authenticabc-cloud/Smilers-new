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
 * Plug-in seam for a remote URL-reputation API.
 *
 * USAGE (future):
 *   const result = scanMessage({ body, attachment });
 *   if (result.severity !== 'block') {
 *     const enriched = await enrichScanWithRemoteAPI(extractUrls(body));
 *     if (enriched.severity === 'block') return enriched;
 *   }
 *
 * Today it's a no-op so the heuristic-only path stays fast and offline-
 * friendly. Set EXPO_PUBLIC_GOOGLE_SAFE_BROWSING_API_KEY in your .env
 * to activate (you'll also need to flip the `enabled` check inside).
 */
export async function enrichScanWithRemoteAPI(urls: string[]): Promise<ScanResult> {
  // Placeholder — returns "safe" until the API key is wired up.
  void urls;
  const apiKey = (process as any)?.env?.EXPO_PUBLIC_GOOGLE_SAFE_BROWSING_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10) {
    return { severity: 'safe', findings: [], shouldHide: false };
  }
  // TODO: implement POST to https://safebrowsing.googleapis.com/v4/threatMatches:find
  // with retries + timeout. Returning safe for now to keep the heuristic
  // path purely synchronous; the renderer can still call this in a
  // useEffect to upgrade a warn → block.
  return { severity: 'safe', findings: [], shouldHide: false };
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
