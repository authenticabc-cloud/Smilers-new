#!/usr/bin/env node
/**
 * Patch expo-notifications so a MISSING iOS native module can't hard-crash the
 * whole app at launch.
 *
 * Problem (iOS only, first TestFlight build):
 *   expo-notifications' generated `*.native.js` files do a MODULE-SCOPE call:
 *     import { requireNativeModule } from 'expo-modules-core';
 *     export default requireNativeModule('ExpoPushTokenManager');
 *   `requireNativeModule` THROWS if the native module isn't registered. On the
 *   customized iOS build `ExpoPushTokenManager` isn't found, so the throw fires
 *   the moment `app/_layout.tsx` does `import * as Notifications from
 *   'expo-notifications'` — BEFORE React renders. The whole app dies on the
 *   splash screen with no crash log (verified via native + JS boot beacons:
 *     GLOBAL-ERROR fatal=true "Cannot find native module 'ExpoPushTokenManager'").
 *   Android registers every module, so Android is unaffected.
 *
 * Fix:
 *   Alias the import to the OPTIONAL variant:
 *     import { requireOptionalNativeModule as requireNativeModule } from 'expo-modules-core';
 *   `requireOptionalNativeModule` returns `null` instead of throwing. So:
 *     - Present modules (all of Android, most of iOS) behave EXACTLY as before.
 *     - A genuinely-missing iOS module resolves to `null`, degrading that one
 *       feature (e.g. push token) instead of crashing the entire app. Existing
 *       try/catch around push calls handles the null gracefully.
 *
 * Runs via the postinstall / prepare hooks so it survives node_modules rebuilds
 * on EAS and clean installs. Idempotent.
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

// Match an `import { ... } from 'expo-modules-core'` statement.
const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*(['"])expo-modules-core\2/;

let patched = 0;
let skipped = 0;

for (const file of fs.readdirSync(BUILD_DIR)) {
  if (!file.endsWith('.native.js')) continue;
  const full = path.join(BUILD_DIR, file);
  const src = fs.readFileSync(full, 'utf8');

  // Only touch files that actually call requireNativeModule at module scope.
  if (!/\brequireNativeModule\s*\(/.test(src)) continue;

  // Already aliased → idempotent no-op.
  if (src.includes('requireOptionalNativeModule as requireNativeModule')) {
    skipped++;
    continue;
  }

  const m = src.match(IMPORT_RE);
  if (!m) continue;

  const names = m[1];
  // Alias the requireNativeModule specifier inside the import braces so every
  // module-scope `requireNativeModule(...)` call becomes non-throwing.
  const newNames = names.replace(
    /\brequireNativeModule\b/,
    'requireOptionalNativeModule as requireNativeModule',
  );
  if (newNames === names) continue;

  const next = src.replace(m[0], `import {${newNames}} from 'expo-modules-core'`);
  fs.writeFileSync(full, next, 'utf8');
  patched++;
}

console.log(
  `[patch-expo-notifications] aliased requireNativeModule→requireOptionalNativeModule in ${patched} file(s) (${skipped} already patched).`,
);
