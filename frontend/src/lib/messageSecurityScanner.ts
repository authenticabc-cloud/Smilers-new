/**
 * messageSecurityScanner — iter 158 security hardening.
 *
 * Pure, dependency-free heuristic scanner that flags messages whose
 * content looks like a phishing/malware vector. Designed to be cheap
 * (sync, no network) so it can be called inline on every rendered
 * message — and so that an "Auto-delete malicious links/files" policy
 * (per user PRD) can be enforced at the chat layer in a follow-up.
 *
 * Heuristics are deliberately conservative to avoid false positives:
 *   - High-risk file extensions (.exe, .bat, .scr, .vbs, .cmd, .js, .jar)
 *     — .apk is deliberately ALLOWED (user decision, WhatsApp-style policy)
 *   - URLs to bare IPs (e.g. http://192.0.2.1/file.exe)
 *   - URLs using URL-shortener domains (bit.ly, tinyurl, t.co, ow.ly, is.gd)
 *     — flagged as MEDIUM only, never auto-deleted by default
 *   - URLs with multi-level typosquatted lookalikes of common brands
 *     (googl3, faceb00k, wh4tsapp, etc.)
 *   - Unicode mixed-script tricks (Cyrillic 'a' / 'е' inside an ASCII URL)
 *
 * Heuristics that AVOID false positives (i.e., NOT flagged):
 *   - Any plain text without a URL or attachment
 *   - URLs to https + well-known TLDs (.com, .net, .org, .io, .app, etc.)
 *     served by recognised hosts
 *   - User-uploaded media (images, video, audio, pdf, docx, etc.)
 */

export type SecurityLevel = 'safe' | 'low' | 'medium' | 'high';

export interface SecurityFinding {
  level: SecurityLevel;
  reason: string;
  hint?: string;
}

export interface SecurityScanResult {
  level: SecurityLevel;
  findings: SecurityFinding[];
  shouldAutoDelete: boolean;
}

const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'msi', 'msp',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'psm1',
  // NOTE: 'apk' intentionally NOT listed — user opted to allow Android
  // package sharing (WhatsApp-style). 'ipa' and desktop installers stay blocked.
  'jar', 'ipa',
  'reg', 'cab', 'lnk', 'inf', 'cpl',
  'hta', 'iso', 'img', 'vhd',
]);

const URL_SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'ow.ly', 'is.gd', 'buff.ly',
  'goo.gl', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'rb.gy',
]);

const TYPOSQUAT_PATTERNS: { pattern: RegExp; brand: string }[] = [
  { pattern: /\bgo+g[l1]e3?\b/i, brand: 'Google' },
  { pattern: /\bfac?eb0?o?[0o]k\b/i, brand: 'Facebook' },
  { pattern: /\bwh[a4]ts[a4]pp/i, brand: 'WhatsApp' },
  { pattern: /\binsta[g9]ram?\b/i, brand: 'Instagram' },
  { pattern: /\bpa[yi]p[a4]l\b/i, brand: 'PayPal' },
  { pattern: /\bm[i1]cros[o0]ft\b/i, brand: 'Microsoft' },
  { pattern: /\bapp[l1]e[i1]d?\b/i, brand: 'Apple' },
  { pattern: /\bsmi?lerss?\b/i, brand: 'Smilers' },
];

const URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const BARE_IP_REGEX = /\b(?:https?:\/\/)?(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/[^\s]*)?/i;

function extractDomain(url: string): string {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

function fileExtensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function hasMixedScript(s: string): boolean {
  // Latin + Cyrillic/Greek mixing is a classic homograph attack signature.
  // We flag if the URL contains BOTH ASCII letters and one of these script
  // ranges within the SAME hostname.
  const hasLatin = /[A-Za-z]/.test(s);
  const hasCyrillic = /[\u0400-\u04FF]/.test(s);
  const hasGreek = /[\u0370-\u03FF]/.test(s);
  return hasLatin && (hasCyrillic || hasGreek);
}

function scanUrl(rawUrl: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const domain = extractDomain(rawUrl);
  if (!domain) return findings;

  if (BARE_IP_REGEX.test(rawUrl)) {
    findings.push({
      level: 'high',
      reason: 'Link points to a raw IP address',
      hint: 'Reputable sites use a domain name, not a numeric address.',
    });
  }

  if (URL_SHORTENERS.has(domain)) {
    findings.push({
      level: 'medium',
      reason: `Shortened link via ${domain}`,
      hint: 'You can\u2019t see where this leads — preview before tapping.',
    });
  }

  for (const ts of TYPOSQUAT_PATTERNS) {
    if (ts.pattern.test(domain) && !domain.includes(ts.brand.toLowerCase())) {
      findings.push({
        level: 'high',
        reason: `Looks like a fake ${ts.brand} domain`,
        hint: `The real ${ts.brand} site does NOT use this spelling.`,
      });
      break;
    }
  }

  if (hasMixedScript(domain)) {
    findings.push({
      level: 'high',
      reason: 'Link uses look-alike characters from another alphabet',
      hint: 'A common phishing trick — open with caution.',
    });
  }

  const ext = fileExtensionOf(rawUrl.split('?')[0].split('#')[0]);
  if (ext && DANGEROUS_EXTENSIONS.has(ext)) {
    findings.push({
      level: 'high',
      reason: `Link to a .${ext} file`,
      hint: 'This file type can run code on your device.',
    });
  }

  return findings;
}

function scanAttachment(name: string, mimeType?: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const ext = fileExtensionOf(name);
  if (ext && DANGEROUS_EXTENSIONS.has(ext)) {
    findings.push({
      level: 'high',
      reason: `Attached .${ext} file`,
      hint: 'This file type can run code on your device.',
    });
  }
  if (mimeType === 'application/x-msdownload' || mimeType === 'application/x-msdos-program') {
    findings.push({
      level: 'high',
      reason: 'Windows executable attachment',
    });
  }
  return findings;
}

function highestLevel(findings: SecurityFinding[]): SecurityLevel {
  if (findings.some((f) => f.level === 'high')) return 'high';
  if (findings.some((f) => f.level === 'medium')) return 'medium';
  if (findings.some((f) => f.level === 'low')) return 'low';
  return 'safe';
}

export interface ScanInput {
  text?: string;
  fileName?: string;
  mimeType?: string;
}

/**
 * Scan a message (text + optional attachment) and decide whether
 * to mark it suspicious and whether to auto-delete it.
 *
 * `shouldAutoDelete` is ONLY true at level 'high' so we never silently
 * remove a borderline message. The chat layer decides whether to act on
 * this based on the user's "Auto-delete malicious content" preference.
 */
export function scanMessage(input: ScanInput): SecurityScanResult {
  const findings: SecurityFinding[] = [];

  const text = input?.text || '';
  if (text) {
    const urls = text.match(URL_REGEX) || [];
    for (const u of urls) {
      findings.push(...scanUrl(u));
    }
    // Second pass: also detect bare-domain shortener / typosquat references
    // that didn't include http(s):// or www. (very common in real chats).
    const bareTokens = text.match(/\b[a-z0-9-]{2,}\.[a-z]{2,6}\b(?:\/[^\s]*)?/gi) || [];
    for (const tok of bareTokens) {
      // Skip if already covered by URL_REGEX above.
      if (urls.some((u) => u.includes(tok))) continue;
      const findingsForToken = scanUrl(tok);
      for (const f of findingsForToken) {
        // Only carry forward shortener + typosquat signals from bare matches.
        if (
          f.reason.startsWith('Shortened link') ||
          f.reason.startsWith('Looks like a fake')
        ) {
          findings.push(f);
        }
      }
    }
  }

  if (input?.fileName) {
    findings.push(...scanAttachment(input.fileName, input.mimeType));
  }

  const level = highestLevel(findings);
  return {
    level,
    findings,
    shouldAutoDelete: level === 'high',
  };
}

/** True when a message should be flagged at all (non-`safe`). */
export function isSuspicious(input: ScanInput): boolean {
  return scanMessage(input).level !== 'safe';
}
