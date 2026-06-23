// ICE server configuration for Smilers WebRTC calls.
//
// Credentials are read from EXPO_PUBLIC_* environment variables so they can be
// rotated WITHOUT shipping a new app build. We keep a small set of hardcoded
// fallbacks as a last-resort safety net (a hard-coded relay is better than no
// relay at all on a corporate NAT) — but if you intentionally clear the env
// vars, the fallback ensures calls still complete instead of failing silently.
//
// Required env vars (defined in /app/frontend/.env):
//   EXPO_PUBLIC_TURN_URLS        — pipe-separated TURN urls
//   EXPO_PUBLIC_TURN_USERNAME    — TURN username
//   EXPO_PUBLIC_TURN_CREDENTIAL  — TURN password
//   EXPO_PUBLIC_STUN_URLS        — optional, pipe-separated STUN urls
//
// Notes:
//   1) `process.env.EXPO_PUBLIC_*` is statically inlined by Metro at build
//      time, so the values are baked into the bundle (not fetched at runtime).
//      This is the standard Expo pattern — see Expo docs on env variables.
//   2) Pipe `|` is used as the URL separator because TURN URLs themselves can
//      legitimately contain commas (e.g. `?transport=tcp,udp`).

const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
];

const DEFAULT_TURN_URLS = [
  'turn:a.relay.metered.ca:80',
  'turn:a.relay.metered.ca:80?transport=tcp',
  'turn:a.relay.metered.ca:443',
  'turn:a.relay.metered.ca:443?transport=tcp',
];

// Fallback credentials are kept here so that calls keep working if a developer
// pulls the repo without copying `.env`. These should be considered "shared
// public test credentials" — production TURN secrets MUST be set via env.
const DEFAULT_TURN_USERNAME = 'e8dd65b92c62d5e868a8c006';
const DEFAULT_TURN_CREDENTIAL = 'RiesKOMPpnBVm5RD';

function splitPipeList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw || typeof raw !== 'string') return fallback;
  const items = raw
    .split('|')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : fallback;
}

const stunUrls = splitPipeList(process.env.EXPO_PUBLIC_STUN_URLS, DEFAULT_STUN_URLS);
const turnUrls = splitPipeList(process.env.EXPO_PUBLIC_TURN_URLS, DEFAULT_TURN_URLS);
const turnUsername =
  (process.env.EXPO_PUBLIC_TURN_USERNAME && process.env.EXPO_PUBLIC_TURN_USERNAME.trim()) ||
  DEFAULT_TURN_USERNAME;
const turnCredential =
  (process.env.EXPO_PUBLIC_TURN_CREDENTIAL && process.env.EXPO_PUBLIC_TURN_CREDENTIAL.trim()) ||
  DEFAULT_TURN_CREDENTIAL;

type IceServer = {
  urls: string;
  username?: string;
  credential?: string;
};

const stunServers: IceServer[] = stunUrls.map((urls) => ({ urls }));
const turnServers: IceServer[] = turnUrls.map((urls) => ({
  urls,
  username: turnUsername,
  credential: turnCredential,
}));

export const ICE_SERVERS: IceServer[] = [...stunServers, ...turnServers];

export const PEER_CONNECTION_CONFIG = {
  iceServers: ICE_SERVERS as unknown as RTCIceServer[],
  iceTransportPolicy: 'all' as const,
  bundlePolicy: 'max-bundle' as const,
  rtcpMuxPolicy: 'require' as const,
};

// Exported for diagnostics — used by the Push/Call diagnostics screens to show
// whether TURN credentials are coming from env vars or the hardcoded fallback.
export const ICE_SERVER_SOURCE = {
  turnUrlsFromEnv: Boolean(process.env.EXPO_PUBLIC_TURN_URLS),
  turnUsernameFromEnv: Boolean(process.env.EXPO_PUBLIC_TURN_USERNAME),
  turnCredentialFromEnv: Boolean(process.env.EXPO_PUBLIC_TURN_CREDENTIAL),
  stunUrlsFromEnv: Boolean(process.env.EXPO_PUBLIC_STUN_URLS),
  turnUrlCount: turnUrls.length,
  stunUrlCount: stunUrls.length,
};

// ---------------------------------------------------------------------------
// Dynamic TURN credentials (web parity)
//
// The web app does NOT bake TURN secrets into its bundle — it fetches fresh,
// short-lived (≈1 h) Twilio relay credentials at call time from the Convex
// HTTP endpoint  GET {CONVEX_SITE_URL}/turn-credentials  (returns a JSON array
// of standard RTCIceServer objects). Ephemeral credentials are more reliable
// than the static metered.ca fallback above (which can be rate-limited/expire),
// so mobile now fetches the same way and only falls back to the static list on
// network error. This is also the prerequisite for multi-party (mesh) calling.
// ---------------------------------------------------------------------------

function deriveConvexSiteUrl(): string | null {
  const cloud = process.env.EXPO_PUBLIC_CONVEX_URL;
  if (!cloud || typeof cloud !== 'string') return null;
  // e.g. https://aware-newt-456.convex.cloud  ->  https://aware-newt-456.convex.site
  return cloud.trim().replace(/\.convex\.cloud\/?$/, '.convex.site');
}

let cachedDynamicServers: IceServer[] | null = null;
let cachedAt = 0;
// Twilio relay credentials are valid ~1 h; refresh well before expiry.
const DYNAMIC_TTL_MS = 50 * 60 * 1000;

/**
 * Fetch ephemeral TURN/STUN servers from the Convex backend (same source the
 * web app uses). Caches the result for ~50 min. Always degrades to the static
 * `ICE_SERVERS` list on any error so calls never fail to start.
 */
export async function fetchTurnServers(force = false): Promise<IceServer[]> {
  const now = Date.now();
  if (!force && cachedDynamicServers && now - cachedAt < DYNAMIC_TTL_MS) {
    return cachedDynamicServers;
  }
  const site = deriveConvexSiteUrl();
  if (!site) return ICE_SERVERS;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${site}/turn-credentials`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`turn-credentials HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json) || json.length === 0) throw new Error('empty turn-credentials');
    const servers: IceServer[] = json
      .filter((s: any) => s && typeof s.urls === 'string' && s.urls.length > 0)
      .map((s: any) => ({
        urls: s.urls,
        ...(s.username ? { username: s.username } : {}),
        ...(s.credential ? { credential: s.credential } : {}),
      }));
    if (servers.length === 0) throw new Error('no valid ice servers in response');
    // Keep our Google STUN fallback alongside the fetched relays for redundancy.
    cachedDynamicServers = [...stunServers, ...servers];
    cachedAt = now;
    return cachedDynamicServers;
  } catch {
    // Network/parse failure → reuse last good fetch if we have one, else static.
    return cachedDynamicServers || ICE_SERVERS;
  }
}

/**
 * Async variant of `PEER_CONNECTION_CONFIG` that uses freshly-fetched dynamic
 * ICE servers. Falls back to the static config's servers on error.
 */
export async function getPeerConnectionConfig(): Promise<typeof PEER_CONNECTION_CONFIG> {
  const iceServers = await fetchTurnServers();
  return {
    ...PEER_CONNECTION_CONFIG,
    iceServers: iceServers as unknown as RTCIceServer[],
  };
}
