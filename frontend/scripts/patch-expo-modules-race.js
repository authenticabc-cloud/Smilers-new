#!/usr/bin/env node
/**
 * patch-expo-modules-race.js
 *
 * Fixes TWO related iOS-only (New Architecture / bridgeless) startup problems in
 * expo-modules-core's ExpoBridgeModule.mm. Both stem from WHEN the modules
 * provider is registered relative to (a) the JS runtime starting and (b) the
 * legacy module registry being wired up.
 *
 * ── Problem 1: splash-screen hang ────────────────────────────────────────────
 *   `global.expo.modules` is a LIVE JSI host object that resolves a module only
 *   if it is registered in the native ModuleRegistry AT THE MOMENT JS accesses
 *   it. In bridgeless the full registration (`useModulesProvider:`) originally
 *   ran only on the async legacy-proxy path, which races JS startup, so
 *   expo-router's `requireNativeModule('ExpoLinking')` often threw and the app
 *   hung on the splash screen.
 *   FIX 1: register the provider EARLY — right before the ExpoRuntime is created
 *   (setBridge <0.74 / setRuntimeExecutor >=0.74 / the installModules fallback).
 *   The registry is fully populated before any JS module lookup.
 *
 * ── Problem 2: permission requesters / Fabric views never register ───────────
 *   `ModuleHolder.init` runs each module's `OnCreate { }` immediately. Several
 *   modules register their PERMISSION REQUESTERS (e.g.
 *   ExpoImagePicker.MediaLibraryPermissionRequester) and native VIEW components
 *   into the LEGACY registry (EXPermissionsService) during `OnCreate`. But
 *   FIX 1 runs `OnCreate` in `setRuntimeExecutor`, which happens BEFORE
 *   `legacyProxyDidSetBridge:` sets `_appContext.legacyModuleRegistry`. So those
 *   OnCreate registrations hit a `nil` legacy registry and silently no-op →
 *   at runtime iOS throws "Unrecognized requester: …" and
 *   "Unimplemented component: ViewManagerAdapter_ExpoVideo_VideoView", and the
 *   app never even appears in iOS Settings' permission lists (Android is fine).
 *   FIX 2: add a FINAL authoritative registration pass at the top of
 *   `installModules` — the RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD that JS calls
 *   synchronously BEFORE requiring any module. By that point all native bridge
 *   modules (incl. the legacy proxy) are set up, so `legacyModuleRegistry` is
 *   available. Re-running `useModulesProvider` there re-creates the holders and
 *   re-runs `OnCreate` WITH the legacy registry set, so requesters/views
 *   register. Gated on `legacyModuleRegistry != nil` so it only runs the extra
 *   pass when it can actually help.
 *
 * `ModuleRegistry.register` is a plain dictionary overwrite, so extra
 * `useModulesProvider` calls are safe/idempotent for registration.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const target = path.join(
  __dirname,
  '..',
  'node_modules',
  'expo-modules-core',
  'ios',
  'Core',
  'ExpoBridgeModule.mm'
);

function log(msg) {
  console.log('[patch-expo-modules-race] ' + msg);
}

if (!fs.existsSync(target)) {
  log('skip — ExpoBridgeModule.mm not found (expo-modules-core layout changed?)');
  process.exit(0);
}

let src = fs.readFileSync(target, 'utf8');

const PROVIDER_CALL = '[_appContext useModulesProvider:@"ExpoModulesProvider"];';
const EARLY_MARKER = '// [patch-expo-modules-race] register all modules before the runtime/JS starts';
const LATE_MARKER = '// [patch-expo-modules-race:onCreate-legacy] final pass with legacy registry';

let changed = false;

// ── FIX 1: early registration before every runtime assignment ────────────────
// Insert naively, then collapse any duplicate (marker + call) runs that
// directly precede a runtime assignment down to one — idempotent for both
// pristine and already-patched sources.
const assignRe = /([ \t]*)(_appContext\._runtime = \[EXJavaScriptRuntimeManager runtimeFromBridge:)/g;
src = src.replace(assignRe, (match, indent) => {
  changed = true;
  return indent + EARLY_MARKER + '\n' + indent + PROVIDER_CALL + '\n' + match;
});

src = src.replace(
  new RegExp(
    '(?:[ \\t]*' + escapeRe(EARLY_MARKER) + '\\n[ \\t]*' + escapeRe(PROVIDER_CALL) + '\\n)+([ \\t]*_appContext\\._runtime)',
    'g'
  ),
  (m, tail) => {
    const indent = (tail.match(/^[ \t]*/) || [''])[0];
    return indent + EARLY_MARKER + '\n' + indent + PROVIDER_CALL + '\n' + tail;
  }
);

// ── FIX 2: final authoritative pass at the top of installModules ─────────────
if (!src.includes(LATE_MARKER)) {
  const installRe = /(RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD\(installModules\)\s*\n\{\n)/;
  if (installRe.test(src)) {
    src = src.replace(installRe, (m) => {
      changed = true;
      return (
        m +
        '  ' + LATE_MARKER + '\n' +
        '  // Re-register now that the legacy module registry is available so\n' +
        '  // permission requesters / Fabric views actually register in OnCreate.\n' +
        '  if (_appContext.legacyModuleRegistry != nil) {\n' +
        '    ' + PROVIDER_CALL + '\n' +
        '  }\n'
      );
    });
  } else {
    log('warn — installModules method not found; FIX 2 (permission requesters) NOT applied');
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (!changed && src.includes(LATE_MARKER)) {
  log('already fully patched — skipping');
  process.exit(0);
}

fs.writeFileSync(target, src, 'utf8');
const earlyCount = src.split(EARLY_MARKER).length - 1;
const lateApplied = src.includes(LATE_MARKER);
log(
  'patched ExpoBridgeModule.mm — early registration at ' +
    earlyCount +
    ' site(s); legacy-registry final pass ' +
    (lateApplied ? 'applied' : 'NOT applied')
);
process.exit(0);
