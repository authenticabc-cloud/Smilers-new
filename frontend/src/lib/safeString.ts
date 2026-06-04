/**
 * safeString — null-safe / Hermes-safe value-to-string coercion.
 *
 * Why this exists:
 *   Hermes (RN's default JS engine on Android) throws
 *   `TypeError: Cannot determine default value of object` when you call
 *   `String(obj)` and `obj`'s `Symbol.toPrimitive` / `valueOf` / `toString`
 *   chain doesn't yield a primitive. This happens with:
 *
 *     • Convex error objects whose `.message` is itself a structured error.
 *     • Proxies returned by `anyApi` (the catch-all proxy in src/convexApi.ts) —
 *       any property access returns another proxy, including `.toString`.
 *     • Some `Id<'table'>` instances depending on Convex client version.
 *     • React component-stack arrays / arbitrary objects without a proper
 *       toString implementation.
 *
 *   The crash we saw on the user's device:
 *     [ERR] (devotionals-stack) [DevotionalsErrorBoundary]
 *       Cannot determine default value of object
 *     TypeError: Cannot determine default value of object
 *         at String (native)
 *         at anonymous (...)
 *         at commitHookEffectListMount
 *
 *   Root cause was `useReactiveSafeConvexQuery.ts` calling `String(...)` on
 *   Convex result.error and on anyApi `queryRef.udfPath` from inside a
 *   useEffect — both unguarded.
 *
 * Behaviour:
 *   • Returns the empty string for null / undefined.
 *   • Returns the value as-is when it's already a string.
 *   • Converts numbers / booleans / bigints with their native toString.
 *   • For objects, prefers an existing string `.message`, then `.name`,
 *     then `.path`, then `.udfPath`, then JSON.stringify (length-capped),
 *     then a constant fallback.
 *   • NEVER throws — wraps every step in try/catch and falls back to
 *     `defaultValue` (default '[unstringifiable]') if all attempts fail.
 *
 * Use this instead of bare `String(x)` whenever `x` could be a Convex
 * error, an anyApi reference, a proxy, or any value not strictly typed
 * as `string` in your TS.
 */
export function safeString(value: unknown, defaultValue = '[unstringifiable]'): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    try {
      return value.toString();
    } catch {
      return defaultValue;
    }
  }
  if (typeof value === 'symbol') {
    try {
      return value.toString();
    } catch {
      return defaultValue;
    }
  }
  if (typeof value === 'function') {
    try {
      return value.name || defaultValue;
    } catch {
      return defaultValue;
    }
  }
  // ───── Object branch — the dangerous one on Hermes ─────
  try {
    const obj = value as any;
    // Prefer common message-bearing fields BEFORE trying generic coercion
    // — these are typed-as-string on every Convex error / Error subclass
    // we care about, so they sidestep the Hermes toPrimitive trap entirely.
    if (typeof obj.message === 'string' && obj.message) return obj.message;
    if (typeof obj.name === 'string' && obj.name) return obj.name;
    if (typeof obj.path === 'string' && obj.path) return obj.path;
    if (typeof obj.udfPath === 'string' && obj.udfPath) return obj.udfPath;
    if (typeof obj.error === 'string' && obj.error) return obj.error;
    if (typeof obj.code === 'string' && obj.code) return obj.code;
    // Try `toString` only if it's the object's own (not inherited) method
    // AND only if it's NOT Object.prototype.toString (which returns
    // '[object Object]' uselessly). Some custom errors override it.
    try {
      const own = Object.prototype.hasOwnProperty.call(obj, 'toString');
      if (own && typeof obj.toString === 'function') {
        const s = obj.toString();
        if (typeof s === 'string' && !s.startsWith('[object ')) return s;
      }
    } catch {
      /* swallow */
    }
    // Last resort: JSON-stringify. Cap length to keep diagnostic logs sane.
    try {
      const json = JSON.stringify(obj);
      if (typeof json === 'string') return json.length > 240 ? `${json.slice(0, 237)}...` : json;
    } catch {
      /* swallow — circular ref / unstringifiable */
    }
  } catch {
    /* swallow — even property reads can throw on a hostile proxy */
  }
  return defaultValue;
}

/**
 * Convenience helper for capturing a Convex / generic error's message
 * safely. Returns '' when nothing useful can be extracted.
 */
export function errorToMessage(err: unknown): string {
  if (err === null || err === undefined) return '';
  if (typeof err === 'string') return err;
  try {
    const e = err as any;
    if (typeof e.message === 'string' && e.message) return e.message;
    if (typeof e.error === 'string' && e.error) return e.error;
    if (typeof e.toString === 'function') {
      const s = e.toString();
      if (typeof s === 'string' && !s.startsWith('[object ')) return s;
    }
  } catch {
    /* swallow */
  }
  return safeString(err);
}
