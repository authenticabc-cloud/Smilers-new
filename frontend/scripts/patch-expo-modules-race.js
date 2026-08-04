#!/usr/bin/env node
/**
 * patch-expo-modules-race.js
 *
 * Fixes an iOS-only, NON-DETERMINISTIC startup crash where the app hangs on the
 * splash screen because `requireNativeModule('ExpoLinking')` (used by
 * expo-router during its first render) throws "Cannot find native module
 * 'ExpoLinking'".
 *
 * ROOT CAUSE (device-confirmed via boot beacons):
 *   `global.expo.modules` is a LIVE JSI host object (ExpoModulesHostObject::get)
 *   that resolves a module ONLY if it is registered in the native
 *   ModuleRegistry *at the moment JS accesses it*. In the New Architecture
 *   (bridgeless) the full registration —
 *   `[_appContext useModulesProvider:@"ExpoModulesProvider"]`, which registers
 *   all ~51 modules — only runs on the async legacy-proxy `setBridge` path
 *   (ExpoBridgeModule `legacyProxyDidSetBridge:`). That races against JS
 *   startup: usually only ~6 modules are registered by the time expo-router
 *   asks for ExpoLinking, so it crashes (and occasionally wins the race and
 *   boots — hence the flakiness: present=2/20 vs 17/20 across launches).
 *
 * FIX:
 *   Register the modules provider EARLY — right before the ExpoRuntime is
 *   created (which installs `global.expo` and after which JS runs). This makes
 *   the ModuleRegistry fully populated before any JS module lookup.
 *   `ModuleRegistry.register(holder:)` is `registry[name] = holder` (a plain
 *   dictionary overwrite), so calling `useModulesProvider` an extra time is
 *   idempotent and safe; the later legacy-proxy call still runs so legacy
 *   modules keep their legacy registry linkage.
 *
 * Applied to every place ExpoBridgeModule assigns `_appContext._runtime` from
 * `runtimeFromBridge` (setBridge <0.74, setRuntimeExecutor >=0.74, and the
 * synchronous installModules fallback).
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

const MARKER = 'useModulesProvider:@"ExpoModulesProvider"';
// Insert the registration call immediately before each runtime assignment,
// unless it is already directly preceded by the marker (idempotent).
const assignRe = /([ \t]*)(_appContext\._runtime = \[EXJavaScriptRuntimeManager runtimeFromBridge:)/g;

let inserted = 0;
src = src.replace(assignRe, (match, indent) => {
  return (
    indent +
    '// [patch-expo-modules-race] register all modules before the runtime/JS starts\n' +
    indent +
    '[_appContext ' +
    MARKER +
    '];\n' +
    match
  );
});

// The regex above would double-insert if run on already-patched source, so
// guard by counting: only write if we actually changed something AND the file
// is not already patched with the same number of markers as assignments.
function count(str, sub) {
  return str.split(sub).length - 1;
}

const original = fs.readFileSync(target, 'utf8');
const assignCount = count(original, '_appContext._runtime = [EXJavaScriptRuntimeManager runtimeFromBridge:');
const alreadyPatched = count(original, MARKER) >= assignCount && assignCount > 0;

if (alreadyPatched) {
  log('already patched — skipping');
  process.exit(0);
}

if (assignCount === 0) {
  log('skip — no runtime assignment found (expo-modules-core internals changed)');
  process.exit(0);
}

fs.writeFileSync(target, src, 'utf8');
inserted = count(src, MARKER) - count(original, MARKER);
log('patched ExpoBridgeModule.mm — inserted early module registration at ' + inserted + ' site(s)');
process.exit(0);
