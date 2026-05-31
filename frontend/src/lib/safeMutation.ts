/**
 * safeMutation — wraps a Convex mutation/action call to capture rich
 * diagnostic detail in the on-device diagnostic logger.
 *
 * Why this exists:
 * The default Convex client only console.error's a one-line message like:
 *   "[CONVEX M(users:updateProfile)] [Request ID: ...] Server Error"
 * That's what shows up in our diagnostic logs — but it doesn't tell us
 * which payload was sent, which field is malformed, or whether the
 * server returned a ConvexError with structured `.data` we could read.
 *
 * Wrapping the mutation through this helper records:
 *   • function path (api.users.updateProfile)
 *   • payload sent (truncated to 800 chars for safety)
 *   • full error object inspection (name, message, code, data, stack)
 * before re-throwing so callers keep their existing try/catch behaviour.
 */

import { recordDiagnostic } from './diagnostics';
import { sentry } from './sentry';

type AnyArgs = Record<string, unknown>;

/**
 * Run a Convex mutation/action with full diagnostic capture.
 *
 * @param label   Short human label, e.g. 'users.updateProfile'.
 * @param run     Async function that performs the actual mutation call.
 * @param payload The payload sent — recorded for diagnostics.
 */
export async function safeMutation<T>(
  label: string,
  run: () => Promise<T>,
  payload?: AnyArgs,
): Promise<T> {
  // Add Sentry breadcrumb before the call so even if the call crashes
  // natively, the crash report shows what we were trying to do.
  try {
    sentry.addBreadcrumb({
      category: 'convex.mutation',
      message: label,
      level: 'info',
      data: payload ? truncateForBreadcrumb(payload) : undefined,
    });
  } catch {}

  try {
    return await run();
  } catch (errorValue: any) {
    // Convex client error introspection. ConvexError has these fields:
    //   .name, .message, .data, .code, possibly .stack
    const errName = errorValue?.name || 'Error';
    const errMessage = errorValue?.message || String(errorValue);
    const errCode = errorValue?.code || errorValue?.data?.code || '';
    const errData = errorValue?.data || errorValue?.cause || null;
    const errStack = errorValue?.stack || null;

    let errDataStr = '';
    if (errData) {
      try {
        errDataStr = typeof errData === 'string' ? errData : JSON.stringify(errData);
      } catch {
        errDataStr = String(errData);
      }
    }

    let payloadStr = '';
    if (payload) {
      try {
        payloadStr = JSON.stringify(payload);
      } catch {
        payloadStr = '[unserializable payload]';
      }
    }

    // Record full error context to the diagnostic logger AsyncStorage —
    // user can later upload via the Diagnostic Logs screen.
    try {
      recordDiagnostic({
        tag: 'CVXERR',
        source: label,
        message: [
          `${label} FAILED`,
          `name=${errName}`,
          `code=${errCode || '(none)'}`,
          `msg=${errMessage}`,
          payloadStr ? `payload=${payloadStr.slice(0, 600)}` : '',
          errDataStr ? `data=${errDataStr.slice(0, 400)}` : '',
        ]
          .filter(Boolean)
          .join(' | '),
        stack: errStack,
      });
    } catch {}

    // Also push to Sentry as a captured exception, with payload context.
    try {
      sentry.captureException(errorValue, {
        tags: { convex_function: label },
        extra: {
          payload: payloadStr,
          convex_error_data: errDataStr,
          convex_error_code: errCode,
        },
      });
    } catch {}

    // Re-throw so the caller's existing catch handlers (e.g. Alert.alert)
    // still fire. We just intercepted to record more detail.
    throw errorValue;
  }
}

function truncateForBreadcrumb(obj: AnyArgs): AnyArgs {
  const out: AnyArgs = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      out[key] = value.length > 80 ? value.slice(0, 80) + '…' : value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (value === null || value === undefined) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = `[array len=${value.length}]`;
    } else if (typeof value === 'object') {
      out[key] = `[object keys=${Object.keys(value).length}]`;
    } else {
      out[key] = String(value).slice(0, 80);
    }
  }
  return out;
}
