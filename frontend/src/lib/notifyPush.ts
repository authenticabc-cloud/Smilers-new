/**
 * notifyPush (iter-198) — SENDER-side push trigger.
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
 */
import { recordDiagnostic } from './diagnostics';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL?.replace(/\/$/, '') || '';

export type NotifyEvent = 'message' | 'call' | 'missed-call';

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

/** Fire-and-forget. Never throws, never blocks the caller. */
export function notifyEventPush(opts: NotifyPushOpts): void {
  try {
    const recipients = (opts.recipients || [])
      .map((r) => (r == null ? '' : String(r).trim()))
      .filter(Boolean);
    if (!BACKEND_URL || recipients.length === 0) return;
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
      .catch((errorValue: any) => {
        try {
          recordDiagnostic({
            tag: 'NOTIFY',
            source: 'notifyPush',
            message: `notify-event POST failed: ${errorValue?.message || errorValue}`,
          });
        } catch {}
      })
      .finally(() => clearTimeout(timeoutId));
  } catch {
    /* never block the send path */
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
