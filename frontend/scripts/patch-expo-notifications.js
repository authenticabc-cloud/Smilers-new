#!/usr/bin/env node
/**
 * Patch expo-notifications so its native modules being UNREGISTERED on iOS
 * cannot hard-crash the whole app at launch.
 *
 * Root cause (iOS only — verified via native + JS boot beacons):
 *   The entire expo-notifications iOS native module set is not registered in
 *   this customized iOS build. Its generated `*.native.js` files do a
 *   MODULE-SCOPE `requireNativeModule('X')` which THROWS when the module is
 *   missing -> fatal the instant `app/_layout.tsx` imports 'expo-notifications',
 *   before React renders -> app frozen on the splash, no crash log.
 *   Beacons captured, in order:
 *     1) "Cannot find native module 'ExpoPushTokenManager'"
 *     2) "Cannot read property 'getRegistrationInfoAsync' of null"
 *        (a module-scope method call on the now-null module)
 *
 * Fix:
 *   Rewrite each `requireNativeModule('X')` to
 *     (requireOptionalNativeModule('X') || __exNotifStub)
 *   where __exNotifStub is a harmless object exposing no-op event-emitter
 *   methods. This means:
 *     - Present modules (all of Android, most of iOS) are returned unchanged.
 *     - Missing modules resolve to a stub, so:
 *         * `new LegacyEventEmitter(stub)` (module-scope, NotificationsEmitter)
 *           does not throw — stub has addListener/removeListeners/etc.
 *         * `if (module.someOtherMethod)` guards (e.g. getRegistrationInfoAsync)
 *           see `undefined` and fall through to expo-notifications' OWN built-in
 *           graceful fallbacks instead of crashing.
 *   Net effect: the app boots; push features simply degrade where the native
 *   module is genuinely absent (existing try/catch around push handles it).
 *
 * Runs via the postinstall / prepare hooks so it survives clean installs on EAS.
 * Idempotent (safe to run repeatedly; upgrades any earlier `|| {}` form).
 */
const fs = require('fs');
const path = require('path');

const BUILD_DIR = path.join(
  __dirname,
  '..',
  'node_modules',
  'expo-notifications',
  'build',
);

if (!fs.existsSync(BUILD_DIR)) {
  console.log('[patch-expo-notifications] expo-notifications not installed — skipping');
  process.exit(0);
}

const STUB_DECL =
  'const __exNotifStub = { addListener: () => ({ remove: () => {} }), ' +
  'removeListeners: () => {}, removeAllListeners: () => {}, ' +
  'startObserving: () => {}, stopObserving: () => {} };';

const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*(['"])expo-modules-core\2/;

let patched = 0;
let skipped = 0;

for (const file of fs.readdirSync(BUILD_DIR)) {
  if (!file.endsWith('.native.js')) continue;
  const full = path.join(BUILD_DIR, file);
  let src = fs.readFileSync(full, 'utf8');

  if (!/require(?:Optional)?NativeModule\s*\(/.test(src)) continue;
  if (src.includes('|| __exNotifStub')) {
    skipped++;
    continue;
  }

  const before = src;

  // 1) Ensure requireOptionalNativeModule is imported from expo-modules-core
  //    (handles pristine `requireNativeModule` and a prior alias form).
  const m = src.match(IMPORT_RE);
  if (m) {
    let names = m[1]
      .replace(/requireOptionalNativeModule\s+as\s+requireNativeModule/g, 'requireOptionalNativeModule')
      .replace(/\brequireNativeModule\b/g, 'requireOptionalNativeModule');
    const seen = new Set();
    const deduped = names
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
    src = src.replace(m[0], `import { ${deduped.join(', ')} } from 'expo-modules-core'`);
  }

  // 2) Inject the stub declaration once (right after the import block).
  if (!src.includes('__exNotifStub')) {
    const importMatch = src.match(/^(import[^\n]*\n)+/);
    if (importMatch) {
      const idx = importMatch[0].length;
      src = src.slice(0, idx) + STUB_DECL + '\n' + src.slice(idx);
    } else {
      src = STUB_DECL + '\n' + src;
    }
  }

  // 3) Upgrade an earlier simple `|| {}` fallback to the stub.
  src = src.replace(
    /require(?:Optional)?NativeModule\((['"][^'"]+['"])\)\s*\|\|\s*\{\}/g,
    'requireOptionalNativeModule($1) || __exNotifStub',
  );

  // 4) Wrap any remaining bare require(Optional)NativeModule('X') calls.
  src = src.replace(
    /require(?:Optional)?NativeModule\((['"][^'"]+['"])\)(?!\s*\|\|)/g,
    'requireOptionalNativeModule($1) || __exNotifStub',
  );

  if (src !== before) {
    fs.writeFileSync(full, src, 'utf8');
    patched++;
  } else {
    skipped++;
  }
}

console.log(
  `[patch-expo-notifications] hardened ${patched} native module file(s) with stub fallback (${skipped} already patched/none).`,
);
