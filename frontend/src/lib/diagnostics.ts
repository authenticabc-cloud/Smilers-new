/**
 * diagnostics — production-build crash visibility.
 *
 * Captures uncaught JS errors, console.error calls, and any callDebugLog
 * events, persists them to AsyncStorage so they survive an app crash, and
 * POSTs them to the FastAPI backend's `/api/diagnostic-logs` endpoint on
 * the next app launch. The main agent can then read the events from
 * supervisor logs (`grep '\[DIAG\]' /var/log/supervisor/backend.out.log`)
 * without needing the user to copy/paste anything.
 *
 * Why this exists:
 *   - The mobile app is built via Emergent's release-build pipeline (no
 *     development-profile / dev-client option), so console.log is invisible
 *     and adb logcat requires USB tooling.
 *   - CallDebugOverlay (iteration 81) helps when the call screen renders,
 *     but if the crash happens before the screen mounts, the overlay
 *     itself can't appear.
 *   - This module gives us a "black-box recorder" that ALWAYS works,
 *     regardless of whether any UI rendered.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

const STORAGE_KEY = 'smilers:diagnostic_events:v1';
const SESSION_KEY = 'smilers:diagnostic_session:v1';
const MAX_STORED = 120; // ring-buffer cap so AsyncStorage stays small
const FLUSH_ENDPOINT = `${process.env.EXPO_PUBLIC_BACKEND_URL || ''}/api/diagnostic-logs`;

export interface DiagnosticEvent {
  ts: number;
  tag: string;
  message: string;
  stack?: string | null;
  source?: string | null;
}

let installed = false;
let sessionId: string | null = null;
let currentUserId: string | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function safeRandomId(): string {
  // RFC4122-ish — good enough for a session identifier
  const rand = (n: number) =>
    Math.floor(Math.random() * Math.pow(16, n))
      .toString(16)
      .padStart(n, '0');
  return `${rand(8)}-${rand(4)}-4${rand(3)}-${rand(4)}-${rand(12)}`;
}

async function loadOrCreateSessionId(): Promise<string> {
  if (sessionId) return sessionId;
  try {
    const stored = await AsyncStorage.getItem(SESSION_KEY);
    if (stored) {
      sessionId = stored;
      return stored;
    }
  } catch {}
  sessionId = safeRandomId();
  try {
    await AsyncStorage.setItem(SESSION_KEY, sessionId);
  } catch {}
  return sessionId;
}

async function readStoredEvents(): Promise<DiagnosticEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeStoredEvents(events: DiagnosticEvent[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_STORED)));
  } catch {}
}

/**
 * Read the locally-stored diagnostic ring buffer (newest last). Exposed so
 * the on-device Call Diagnostics screen can render the last
 * [TWILIO-CALL]/[WAKE]/call events without a network round-trip.
 */
export async function getStoredDiagnostics(): Promise<DiagnosticEvent[]> {
  return readStoredEvents();
}

/** Clear the locally-stored diagnostic ring buffer. */
export async function clearStoredDiagnostics(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {}
}

/**
 * Record a diagnostic event. Persists to AsyncStorage so it survives a
 * crash. Writes are queued + serialized to avoid AsyncStorage races.
 *
 * Safe to call from any thread, in any state — never throws.
 */
export function recordDiagnostic(event: Omit<DiagnosticEvent, 'ts'>): void {
  const full: DiagnosticEvent = {
    ts: Date.now(),
    tag: String(event.tag || '').slice(0, 16),
    message: String(event.message || '').slice(0, 1000),
    stack: event.stack ? String(event.stack).slice(0, 4000) : null,
    source: event.source || null,
  };
  writeQueue = writeQueue
    .then(async () => {
      const existing = await readStoredEvents();
      existing.push(full);
      await writeStoredEvents(existing);
    })
    .catch(() => {});
}

function getDeviceMeta() {
  let platformVersion: string | undefined;
  try {
    platformVersion = String(Platform.Version);
  } catch {}
  let appVersion: string | undefined;
  try {
    appVersion =
      (Constants?.expoConfig?.version as string | undefined) ||
      (Constants as any)?.manifest?.version ||
      undefined;
  } catch {}
  let device: string | undefined;
  try {
    device = (Constants as any)?.deviceName || undefined;
  } catch {}
  return {
    platform: Platform.OS,
    platformVersion,
    appVersion,
    device,
  };
}

/**
 * Attach the active user id so subsequent flushes carry it. Optional —
 * called from AuthProvider once OIDC profile is hydrated.
 */
export function setDiagnosticUser(userId: string | null | undefined): void {
  currentUserId = userId ? String(userId) : null;
}

/**
 * Fire-and-forget single POST that includes a snapshot of any currently
 * stored events. Used on app launch to definitively confirm the
 * diagnostics module is alive in the production APK. Unlike
 * `flushDiagnostics`, this ALWAYS sends a payload — even if there are
 * zero stored events — so the backend will see at least the heartbeat
 * BOOT marker on every cold start. The payload also includes a
 * deterministic 'HB' tag so the main agent can grep for it.
 *
 * Returns `true` if the server accepted the payload; never throws.
 */
export async function sendDiagnosticHeartbeat(): Promise<boolean> {
  if (!FLUSH_ENDPOINT || FLUSH_ENDPOINT.endsWith('/api/diagnostic-logs') === false) {
    return false;
  }
  try {
    const sid = await loadOrCreateSessionId();
    const meta = getDeviceMeta();
    // Read any stored events too so the heartbeat doubles as a flush.
    let stored: DiagnosticEvent[] = [];
    try {
      stored = await readStoredEvents();
    } catch {}
    const events: DiagnosticEvent[] = [
      {
        ts: Date.now(),
        tag: 'HB',
        message: `heartbeat from ${meta.platform || '?'}/${meta.platformVersion || '?'} app=${meta.appVersion || '?'} device=${meta.device || '?'}`,
        source: 'heartbeat',
      },
      ...stored,
    ];
    const body = JSON.stringify({
      sessionId: sid,
      userId: currentUserId,
      appVersion: meta.appVersion,
      platform: meta.platform,
      platformVersion: meta.platformVersion,
      device: meta.device,
      events,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(FLUSH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        return false;
      }
    } finally {
      clearTimeout(timeout);
    }
    // Stored events were just sent piggybacked on the heartbeat — clear them.
    if (stored.length > 0) {
      try {
        await AsyncStorage.removeItem(STORAGE_KEY);
      } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * POST any stored events to the backend, then clear them. Returns the
 * number of events flushed (0 if nothing was queued). Never throws.
 */
export async function flushDiagnostics(): Promise<number> {
  if (!FLUSH_ENDPOINT || FLUSH_ENDPOINT.endsWith('/api/diagnostic-logs') === false) {
    return 0;
  }
  try {
    const events = await readStoredEvents();
    if (events.length === 0) return 0;
    const sid = await loadOrCreateSessionId();
    const meta = getDeviceMeta();
    const body = JSON.stringify({
      sessionId: sid,
      userId: currentUserId,
      appVersion: meta.appVersion,
      platform: meta.platform,
      platformVersion: meta.platformVersion,
      device: meta.device,
      events,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(FLUSH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        // Don't drop the events if the server rejected us — try again next launch.
        return 0;
      }
    } finally {
      clearTimeout(timeout);
    }
    // Server accepted — clear stored events.
    await AsyncStorage.removeItem(STORAGE_KEY);
    return events.length;
  } catch {
    return 0;
  }
}

/**
 * Install a global JS error handler that records every uncaught error +
 * promise rejection into our diagnostic buffer. Idempotent — safe to call
 * multiple times.
 *
 * This MUST be invoked as early as possible (top of _layout.tsx, before
 * any provider renders) so we catch errors during module-load too.
 */
export function installGlobalDiagnostics(): void {
  if (installed) return;
  installed = true;

  // 1) RN's `ErrorUtils.setGlobalHandler` — catches uncaught JS errors that
  //    would otherwise show the red-box / crash the app.
  try {
    const errorUtils = (globalThis as any).ErrorUtils;
    if (errorUtils && typeof errorUtils.getGlobalHandler === 'function') {
      const prev = errorUtils.getGlobalHandler();
      errorUtils.setGlobalHandler((error: Error, isFatal?: boolean) => {
        try {
          recordDiagnostic({
            tag: isFatal ? 'FATAL' : 'ERR',
            source: 'globalHandler',
            message: `${error?.name || 'Error'}: ${error?.message || String(error)}`,
            stack: error?.stack || null,
          });
        } catch {}
        // Best-effort flush (fire-and-forget) — gives us the data even if the
        // process is about to die.
        try {
          void flushDiagnostics();
        } catch {}
        // Preserve the previous handler so the red box still appears in dev.
        if (typeof prev === 'function') {
          try {
            prev(error, isFatal);
          } catch {}
        }
      });
    }
  } catch {}

  // 2) Unhandled promise rejections — RN routes these via the same global
  //    handler in newer SDKs but older SDKs may emit on the `unhandledrejection`
  //    event. Hook both for safety.
  try {
    if (typeof (globalThis as any).addEventListener === 'function') {
      (globalThis as any).addEventListener('unhandledrejection', (event: any) => {
        const reason = event?.reason;
        recordDiagnostic({
          tag: 'PROMISE',
          source: 'unhandledRejection',
          message:
            (reason && (reason.message || reason.toString?.())) || 'Unhandled promise rejection',
          stack: reason?.stack || null,
        });
      });
    }
  } catch {}

  // 3) Tee console.error so React's "Component threw an error" etc. get
  //    captured. We DON'T tee console.warn (too noisy) or console.log
  //    (would create a huge volume).
  try {
    const origError = console.error?.bind(console);
    console.error = (...args: any[]) => {
      try {
        const message = args
          .map((a) => {
            if (a && typeof a === 'object') {
              if (a instanceof Error) return `${a.name}: ${a.message}`;
              try {
                return JSON.stringify(a);
              } catch {
                return String(a);
              }
            }
            return String(a);
          })
          .join(' ');
        recordDiagnostic({
          tag: 'CONSOLE',
          source: 'console.error',
          message: message.slice(0, 1000),
        });
      } catch {}
      try {
        origError?.(...args);
      } catch {}
    };
  } catch {}

  recordDiagnostic({
    tag: 'BOOT',
    source: 'diagnostics',
    message: 'global handler installed',
  });
}

/**
 * iter-D1: Record a one-shot BOOT diagnostic capturing exactly which
 * backend URL was burned into this APK at build time + app/build
 * identifiers. The next time a `/api/register-push` 404 surfaces, one
 * grep on `[DIAG][BOOT][api]` in supervisor logs will tell us
 * instantly whether the device is on a stale URL (preview vs prod)
 * or the production backend lost a route.
 *
 * Safe to call multiple times — only the first call per session is
 * recorded so we don't flood the diagnostic ring buffer.
 */
let bootRecorded = false;
export function recordBootDiagnostic(): void {
  if (bootRecorded) return;
  bootRecorded = true;
  try {
    const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL || '(missing)';
    const webAppUrl = process.env.EXPO_PUBLIC_WEB_APP_URL || '(missing)';
    const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL || '(missing)';
    const meta = getDeviceMeta();
    // Extract just the hostname so supervisor-log greps are clean.
    let backendHost = backendUrl;
    try {
      backendHost = new URL(backendUrl).hostname;
    } catch {}
    const versionCode =
      (Constants?.expoConfig?.android?.versionCode as number | undefined) ??
      (Constants?.expoConfig?.ios?.buildNumber as string | number | undefined) ??
      '?';
    recordDiagnostic({
      tag: 'BOOT',
      source: 'api',
      message:
        `backend=${backendUrl} host=${backendHost} ` +
        `webapp=${webAppUrl} convex=${convexUrl} ` +
        `app=${meta.appVersion || '?'}/${versionCode} ` +
        `plat=${meta.platform}/${meta.platformVersion || '?'} ` +
        `device=${meta.device || '?'}`,
    });
  } catch {}
}

/**
 * iter-D1: Fire a one-shot GET against `/api/__health` on the backend
 * the APK was built against. Records a `[HEALTH]` diagnostic with the
 * outcome so we can definitively answer, after any future 404 incident:
 *
 *   - "Did the device even reach our backend?"        → HEALTH ok / UNREACHABLE
 *   - "Did the backend have register-push at boot?"   → critical_routes_missing
 *   - "Is the deployment serving a *different* app?"  → critical_routes_present
 *
 * Never throws. Safe to call once per app launch — no rate limiting
 * needed since the endpoint is sub-millisecond and unauthenticated.
 */
export async function probeBackendHealth(): Promise<void> {
  const base = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');
  if (!base) {
    recordDiagnostic({
      tag: 'HEALTH',
      source: 'probe',
      message: 'NO_BACKEND_URL — EXPO_PUBLIC_BACKEND_URL is empty in this build',
    });
    return;
  }
  const url = `${base}/api/__health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const t0 = Date.now();
    const resp = await fetch(url, { method: 'GET', signal: controller.signal });
    const ms = Date.now() - t0;
    if (!resp.ok) {
      // 404 here is the smoking gun for "wrong backend"
      let bodyHead = '';
      try {
        const text = await resp.text();
        bodyHead = text.slice(0, 160);
      } catch {}
      recordDiagnostic({
        tag: 'HEALTH',
        source: 'probe',
        message: `HTTP_${resp.status} ${ms}ms url=${url} body=${bodyHead}`,
      });
      return;
    }
    let json: any = null;
    try {
      json = await resp.json();
    } catch {}
    const missing = (json?.critical_routes_missing || []) as string[];
    const present = (json?.critical_routes_present || []) as string[];
    const tag = missing.length > 0 ? 'ROUTES_MISSING' : 'ok';
    recordDiagnostic({
      tag: 'HEALTH',
      source: 'probe',
      message:
        `${tag} ${ms}ms version=${json?.version || '?'} ` +
        `present=${present.length}/${present.length + missing.length} ` +
        `missing=[${missing.join(',')}] ` +
        `server_time=${json?.server_time || '?'}`,
    });
  } catch (errorValue: any) {
    // Network/timeout — backend is unreachable from THIS device on THIS URL.
    const msg = (errorValue && (errorValue.message || String(errorValue))) || 'unknown';
    recordDiagnostic({
      tag: 'HEALTH',
      source: 'probe',
      message: `UNREACHABLE url=${url} err=${msg}`,
    });
  } finally {
    clearTimeout(timeout);
  }
}
