/**
 * notifyPush (iter-198 / hardened iter-210) — SENDER-side push trigger.
 *
 * WHY THIS EXISTS: live diagnosis on 2026-06-12 proved that the Convex
 * backend was NOT firing /api/send-push-internal for real messages and
 * calls (the trigger log stayed empty during the user's killed-app
 * tests), while direct FCM sends from our FastAPI backend DID ring the
 * killed phone. Rather than depend on the web team's Convex triggers,
 * the sender's own device now fires the push immediately after a
 * successful `api.messages.send` / `api.calls.initiateCall`.
 *
 * The backend dedupes (idempotency key + content hash), so if/when the
 * Convex triggers come back, recipients still get exactly ONE
 * notification.
 *
 * Recipients are CONVEX user ids — the backend matches them against the
 * `convex_user_id` captured during push registration (useEmergentPush).
 *
 * Fire-and-forget by design: push failures must NEVER block or slow the
 * actual send.
 *
 * iter-210 OBSERVABILITY UPGRADE: previous version was silently
 * fire-and-forget — when the user reported "push not rendering" we had
 * NO way to see whether the sender device even attempted a notify-event
 * call, let alone what response the backend gave. We now:
 *   - Record a diagnostic on every attempt (skip / start / success / fail).
 *   - Log to console with a stable prefix [NOTIFY-PUSH] so logcat searches
 *     work.
 *   - Capture HTTP status and short response body on non-2xx.
 *   - Capture the skip REASON when recipients/BACKEND_URL are missing.
 */
import { recordDiagnostic } from './diagnostics';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL?.replace(/\/$/, '') || '';

export type NotifyEvent = 'message' | 'call' | 'missed-call' | 'call-cancelled' | 'call-declined';

export interface NotifyPushOpts {
  /** Convex user ids of the recipients (NOT the sender). */
  recipients: Array<string | null | undefined>;
  event: NotifyEvent;
  /** Notification title — normally the sender's display name. */
  title: string;
  /** Notification body — message preview or "Incoming voice call…". */
  message: string;
  conversationId?: string | null;
  callId?: string | null;
  callType?: 'voice' | 'video' | null;
  /** Caller display name for the incoming-call screen deep link. */
  displayName?: string | null;
  /** Convex message/call id — lets the backend dedupe against Convex triggers. */
  idempotencyKey?: string | null;
}

function safeRecord(message: string) {
  try {
    recordDiagnostic({ tag: 'NOTIFY', source: 'notifyPush', message });
  } catch {
    /* never block the send path */
  }
  try {
    // eslint-disable-next-line no-console
    console.log(`[NOTIFY-PUSH] ${message}`);
  } catch {
    /* swallow */
  }
}

/** Fire-and-forget. Never throws, never blocks the caller. */
export function notifyEventPush(opts: NotifyPushOpts): void {
  try {
    const rawRecipients = opts.recipients || [];
    const recipients = rawRecipients
      .map((r) => (r == null ? '' : String(r).trim()))
      .filter(Boolean);

    if (!BACKEND_URL) {
      safeRecord(
        `skip: event=${opts.event} reason=no-backend-url raw=${rawRecipients.length}`,
      );
      return;
    }
    if (recipients.length === 0) {
      safeRecord(
        `skip: event=${opts.event} reason=no-recipients raw=${rawRecipients.length}`,
      );
      return;
    }

    safeRecord(
      `start: event=${opts.event} recipients=${recipients.length} convId=${opts.conversationId || '∅'} idem=${opts.idempotencyKey || '∅'}`,
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    void fetch(`${BACKEND_URL}/api/notify-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipients,
        event: opts.event,
        title: opts.title,
        message: opts.message,
        conversation_id: opts.conversationId || null,
        call_id: opts.callId || null,
        call_type: opts.callType || null,
        display_name: opts.displayName || null,
        idempotency_key: opts.idempotencyKey || null,
      }),
      signal: controller.signal,
    })
      .then(async (resp) => {
        if (!resp.ok) {
          let detail = '';
          try {
            detail = (await resp.text()).slice(0, 200);
          } catch {}
          safeRecord(
            `fail: event=${opts.event} HTTP ${resp.status} detail=${detail || 'n/a'}`,
          );
          return;
        }
        safeRecord(`ok: event=${opts.event} HTTP ${resp.status}`);
      })
      .catch((errorValue: any) => {
        safeRecord(
          `fail: event=${opts.event} fetch error=${errorValue?.message || errorValue}`,
        );
      })
      .finally(() => clearTimeout(timeoutId));
  } catch (errorValue: any) {
    safeRecord(`fail: event=${opts.event} unexpected error=${errorValue?.message || errorValue}`);
  }
}

/** Human label for a non-text message type, used as the push preview. */
export function previewForMessageType(type: string | undefined, text?: string | null): string {
  const trimmed = (text || '').trim();
  if (trimmed) return trimmed.slice(0, 120);
  switch (type) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎥 Video';
    case 'audio':
    case 'voice':
      return '🎤 Voice message';
    case 'file':
      return '📎 Attachment';
    default:
      return 'New message';
  }
}
