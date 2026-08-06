#!/usr/bin/env node
/**
 * patch-expo-modules-race.js
 *
 * Patches expo-modules-core's ExpoBridgeModule.mm (iOS, New Architecture /
 * bridgeless) to fix TWO issues rooted in WHEN the modules provider is
 * registered.
 *
 * ── FIX 1: splash-screen hang ────────────────────────────────────────────────
 *   `global.expo.modules` resolves a module only if it is in the native
 *   ModuleRegistry at the moment JS accesses it. Originally the full
 *   registration ran only on the async legacy path, which races JS startup, so
 *   expo-router's `requireNativeModule('ExpoLinking')` threw and the app hung on
 *   the splash. FIX: register the provider EARLY, right before the ExpoRuntime
 *   is created (setBridge <0.74 / setRuntimeExecutor >=0.74 / installModules).
 *
 * ── FIX 3: permission requesters / Fabric views never register ───────────────
 *   `ModuleHolder.init` runs each module's `OnCreate {}` immediately. Modules
 *   register their PERMISSION REQUESTERS + native VIEWS like:
 *       OnCreate { self.appContext?.permissions?.register([...]) }
 *   `appContext.permissions` is `legacyModule(implementing: EXPermissionsInterface)`
 *   — it is NIL until the legacy module registry is fully wired
 *   (`legacyProxyDidSetBridge:`). FIX 1 runs OnCreate BEFORE that, so the `?.`
 *   short-circuits and the requesters/views are NEVER registered → at runtime
 *   iOS throws "Unrecognized requester: ExpoImagePicker.MediaLibraryPermission-
 *   Requester" and "Unimplemented component: ViewManagerAdapter_ExpoVideo_
 *   VideoView", and the app never appears in iOS Settings permission lists
 *   (Android is unaffected).
 *
 *   FIX: after the early registration, kick off a MAIN-QUEUE retry loop that
 *   waits until `_appContext.permissions` is non-nil, then re-runs
 *   `useModulesProvider` ONCE. Re-registration re-runs OnCreate WITH the
 *   permissions service available, so requesters/views land in the shared
 *   EXPermissionsService (this mirrors what Expo's own legacy-proxy path does,
 *   so the app already tolerates a runtime re-registration). NSLog diagnostics
 *   (tag "[smilers-diag]") record the timeline so it can be confirmed via
 *   Console.app if needed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const target = path.join(
  __dirname, '..', 'node_modules', 'expo-modules-core', 'ios', 'Core', 'ExpoBridgeModule.mm'
);

function log(msg) { console.log('[patch-expo-modules-race] ' + msg); }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

if (!fs.existsSync(target)) {
  log('skip — ExpoBridgeModule.mm not found (expo-modules-core layout changed?)');
  process.exit(0);
}

let src = fs.readFileSync(target, 'utf8');

const PROVIDER_CALL = '[_appContext useModulesProvider:@"ExpoModulesProvider"];';
const EARLY_MARKER = '// [patch-expo-modules-race] register all modules before the runtime/JS starts';
const DECL_MARKER = '// [patch-expo-modules-race:decl]';
const RETRY_CALL_MARKER = '// [patch-expo-modules-race:retry-kick]';
const RETRY_METHOD_MARKER = '// [patch-expo-modules-race:retry-method]';
const LEGACY_LOG_MARKER = '// [patch-expo-modules-race:legacy-log]';

let changed = false;

// ── FIX 1: early registration before every runtime assignment (idempotent) ───
const assignRe = /([ \t]*)(_appContext\._runtime = \[EXJavaScriptRuntimeManager runtimeFromBridge:)/g;
src = src.replace(assignRe, (match, indent) => {
  changed = true;
  return indent + EARLY_MARKER + '\n' + indent + PROVIDER_CALL + '\n' + match;
});
src = src.replace(
  new RegExp('(?:[ \\t]*' + escapeRe(EARLY_MARKER) + '\\n[ \\t]*' + escapeRe(PROVIDER_CALL) + '\\n)+([ \\t]*_appContext\\._runtime)', 'g'),
  (m, tail) => {
    const indent = (tail.match(/^[ \t]*/) || [''])[0];
    return indent + EARLY_MARKER + '\n' + indent + PROVIDER_CALL + '\n' + tail;
  }
);

// ── FIX 3a: private method declaration (class extension before @implementation)
if (!src.includes(DECL_MARKER)) {
  const implRe = /(@implementation ExpoBridgeModule\b)/;
  if (implRe.test(src)) {
    const decl =
      DECL_MARKER + '\n' +
      '@interface ExpoBridgeModule ()\n' +
      '- (void)__smilersRetryRegister:(NSInteger)attempt;\n' +
      '@end\n\n';
    src = src.replace(implRe, decl + '$1');
    changed = true;
  }
}

// ── FIX 3b: NSLog when the legacy registry is set (diagnostic) ───────────────
if (!src.includes(LEGACY_LOG_MARKER)) {
  const legacyRe = /([ \t]*)(_appContext\.legacyModuleRegistry = moduleRegistry;)/;
  if (legacyRe.test(src)) {
    src = src.replace(legacyRe, (m, indent, stmt) => {
      changed = true;
      return (
        indent + stmt + '\n' +
        indent + LEGACY_LOG_MARKER + '\n' +
        indent + 'NSLog(@"[smilers-diag] legacyProxyDidSetBridge fired; permissions now=%@", _appContext.legacyModuleRegistry ? @"set" : @"nil");'
      );
    });
  }
}

// ── FIX 3c: kick off the retry loop right after the >=0.74 runtime assignment ─
if (!src.includes(RETRY_CALL_MARKER)) {
  const rtRe = /([ \t]*)(_appContext\._runtime = \[EXJavaScriptRuntimeManager runtimeFromBridge:_bridge withExecutor:runtimeExecutor\];)/;
  if (rtRe.test(src)) {
    src = src.replace(rtRe, (m, indent, stmt) => {
      changed = true;
      return (
        m + '\n' +
        indent + RETRY_CALL_MARKER + '\n' +
        indent + 'NSLog(@"[smilers-diag] setRuntimeExecutor: early register done; permissions=%@", _appContext.legacyModuleRegistry ? @"set" : @"nil");\n' +
        indent + '__weak __typeof(self) __smilersWeakSelf = self;\n' +
        indent + 'dispatch_async(dispatch_get_main_queue(), ^{ [__smilersWeakSelf __smilersRetryRegister:0]; });'
      );
    });
  } else {
    log('warn — setRuntimeExecutor runtime assignment not found; FIX 3 retry NOT wired');
  }
}

// ── FIX 3d: the retry method itself, inserted before the final @end ──────────
if (!src.includes(RETRY_METHOD_MARKER)) {
  const method =
    '\n' + RETRY_METHOD_MARKER + '\n' +
    '- (void)__smilersRetryRegister:(NSInteger)attempt\n' +
    '{\n' +
    '  if (_appContext.legacyModuleRegistry != nil) {\n' +
    '    NSLog(@"[smilers-diag] retryRegister: legacy registry ready at attempt %ld — re-registering in 0.25s", (long)attempt);\n' +
    '    __weak __typeof(self) weakSelf = self;\n' +
    '    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.25 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{\n' +
    '      __typeof(self) strongSelf = weakSelf;\n' +
    '      if (strongSelf == nil) { return; }\n' +
    '      NSLog(@"[smilers-diag] retryRegister: re-registering modules now (with legacy registry)");\n' +
    '      [strongSelf->_appContext useModulesProvider:@"ExpoModulesProvider"];\n' +
    '    });\n' +
    '    return;\n' +
    '  }\n' +
    '  if (attempt >= 100) {\n' +
    '    NSLog(@"[smilers-diag] retryRegister: gave up after %ld attempts (legacy registry still nil)", (long)attempt);\n' +
    '    return;\n' +
    '  }\n' +
    '  __weak __typeof(self) weakSelf = self;\n' +
    '  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{\n' +
    '    [weakSelf __smilersRetryRegister:attempt + 1];\n' +
    '  });\n' +
    '}\n';
  // Insert before the LAST @end in the file.
  const lastEnd = src.lastIndexOf('\n@end');
  if (lastEnd !== -1) {
    src = src.slice(0, lastEnd) + '\n' + method + src.slice(lastEnd + 1);
    changed = true;
  } else {
    log('warn — could not find trailing @end; FIX 3 retry method NOT added');
  }
}

// ── FIX 4: native diagnostic capture into NSUserDefaults (JS-readable) ───────
// The `[smilers-diag]` NSLogs only reach the Xcode console. Mirror each one
// into NSUserDefaults so a committed native module (SmilersCallModule.getNativeDiag)
// can hand the timeline to JS → the on-device Diagnostic Logs screen. This is
// how we can finally SEE whether legacyProxyDidSetBridge fires / the retry
// gives up, without a Mac.
const DIAG_HELPER_MARKER = '// [patch-expo-modules-race:diag-helper]';
if (!src.includes(DIAG_HELPER_MARKER)) {
  const anchor = '#endif // React Native >=0.74\n';
  const idx = src.indexOf(anchor);
  if (idx !== -1) {
    const helper =
      '\n' + DIAG_HELPER_MARKER + '\n' +
      'static void SmilersNativeDiagAppend(NSString *label) {\n' +
      '  @try {\n' +
      '    NSUserDefaults *__d = [NSUserDefaults standardUserDefaults];\n' +
      '    NSArray *__cur = [__d arrayForKey:@"smilers_native_diag"] ?: @[];\n' +
      '    NSMutableArray *__arr = [__cur mutableCopy];\n' +
      '    NSTimeInterval __t = [[NSDate date] timeIntervalSince1970];\n' +
      '    [__arr addObject:[NSString stringWithFormat:@"%.0f %@", __t, label]];\n' +
      '    NSUInteger __n = __arr.count; if (__n > 80) { [__arr removeObjectsInRange:NSMakeRange(0, __n - 80)]; }\n' +
      '    [__d setObject:__arr forKey:@"smilers_native_diag"];\n' +
      '  } @catch (__unused NSException *__e) {}\n' +
      '}\n';
    const insertAt = idx + anchor.length;
    src = src.slice(0, insertAt) + helper + src.slice(insertAt);
    changed = true;
  }
}
// Append a capture call after each smilers-diag NSLog (idempotent via lookahead).
src = src.replace(
  /(NSLog\(@"\[smilers-diag\] ([^"]*)"[^;]*\);)(?!\s*SmilersNativeDiagAppend)/g,
  (m, full, label) => {
    changed = true;
    return full + ' SmilersNativeDiagAppend(@"' + label.replace(/"/g, '\\"') + '");';
  }
);

const fullyPatched =
  src.includes(EARLY_MARKER) && src.includes(DECL_MARKER) &&
  src.includes(RETRY_CALL_MARKER) && src.includes(RETRY_METHOD_MARKER);

if (!changed && fullyPatched) {
  log('already fully patched — skipping');
  process.exit(0);
}

fs.writeFileSync(target, src, 'utf8');
log(
  'patched ExpoBridgeModule.mm — early=' + (src.split(EARLY_MARKER).length - 1) +
  ' site(s); decl=' + (src.includes(DECL_MARKER) ? 'y' : 'n') +
  '; retry-kick=' + (src.includes(RETRY_CALL_MARKER) ? 'y' : 'n') +
  '; retry-method=' + (src.includes(RETRY_METHOD_MARKER) ? 'y' : 'n')
);
process.exit(0);
