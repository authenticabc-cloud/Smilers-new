/**
 * friendlyConvexError — maps raw Convex/network error strings into short,
 * user-facing messages.
 *
 * Convex surfaces backend failures as opaque strings like:
 *   "[CONVEX M(conversations:getOrCreateDirect)] [Request ID: ...] Server Error"
 * Showing that verbatim in an Alert is confusing. This helper detects the
 * common failure shapes and returns a friendly sentence, falling back to the
 * caller-supplied default for anything genuinely informative.
 */
export function friendlyConvexError(error: any, fallback = 'Something went wrong. Please try again.'): string {
  const raw = String(error?.message || error || '').trim();
  if (!raw) return fallback;

  const lower = raw.toLowerCase();

  // Opaque Convex server crash — no actionable detail for the user.
  if (lower.includes('server error') || lower.includes('called by client')) {
    return "We couldn't reach the server just now. Please check your connection and try again.";
  }
  // Network / timeout conditions.
  if (
    lower.includes('network request failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('timeout') ||
    lower.includes('offline')
  ) {
    return 'No internet connection. Please check your network and try again.';
  }
  // Auth expiry.
  if (lower.includes('unauthenticated') || lower.includes('not authenticated') || lower.includes('unauthorized')) {
    return 'Your session expired. Please sign in again.';
  }

  // A ConvexError with a human message (short, no bracketed request id) is
  // usually meaningful — surface it. Otherwise use the fallback.
  if (raw.startsWith('[CONVEX') || raw.includes('Request ID:')) return fallback;
  return raw.length > 0 && raw.length <= 160 ? raw : fallback;
}
