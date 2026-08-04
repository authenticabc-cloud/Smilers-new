/**
 * StreamCallInnerEntry (NATIVE) — re-exports the Stream 1:1 call screen.
 * The .web.tsx sibling is a no-op so the Stream Video SDK never enters the web
 * bundle (component-level platform split).
 *
 * Expo Go is ALSO a Stream-less environment, and it is easy to miss: as far as
 * Metro is concerned Expo Go is "native", so it resolves THIS file rather than
 * the .web.tsx one — but the Expo Go binary carries no Stream native module.
 * The old `export { default } from './StreamCallInner'` was a STATIC re-export,
 * so it threw during module evaluation, and because CallHost -> _layout imports
 * this at the app root it took the entire tree down: AuthProvider never
 * mounted, which is why every screen then failed with the misleading
 * "useAuth must be used within AuthProvider".
 *
 * So resolve StreamCallInner lazily and fall back to the same no-op the web
 * split already uses. Real dev/prod builds are unaffected — IS_EXPO_GO is
 * false there and the require runs exactly as the old static import did.
 */
import React from 'react';
import { IS_EXPO_GO } from '../../lib/isExpoGo';

let StreamCallInnerImpl: React.ComponentType<any> | null = null;

if (!IS_EXPO_GO) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  StreamCallInnerImpl = require('./StreamCallInner').default;
}

export default function StreamCallInnerEntry() {
  if (!StreamCallInnerImpl) return null;
  return <StreamCallInnerImpl />;
}
