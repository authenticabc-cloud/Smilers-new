#!/usr/bin/env node
/**
 * Patch react-native-webrtc to fix bundling for `expo export` (EAS Update).
 *
 * Problem:
 *   react-native-webrtc@124.x imports `event-target-shim/index` from many
 *   source files, but the installed `event-target-shim@6` has a strict
 *   `exports` field that does not expose that subpath. Local Metro dev mode
 *   is lenient; `expo export` uses strict ESM resolution and fails to
 *   bundle for iOS/Android.
 *
 * Fix:
 *   Recursively replace `event-target-shim/index` with `event-target-shim`
 *   inside react-native-webrtc's `src/` and `lib/` directories. The
 *   package's main entry resolves to the same EventTarget /
 *   defineEventAttribute exports, so this is a runtime-safe edit.
 *
 * Runs on every `yarn install` via the postinstall hook, so the patch
 * survives node_modules rebuilds on the deployer.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'node_modules', 'react-native-webrtc');
const DIRS = ['src', 'lib'];
const EXT_REGEX = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && EXT_REGEX.test(entry.name)) {
      out.push(full);
    }
  }
}

if (!fs.existsSync(ROOT)) {
  console.log('[patch-rn-webrtc] react-native-webrtc not installed — skipping');
  process.exit(0);
}

const files = [];
for (const dir of DIRS) walk(path.join(ROOT, dir), files);

const FROM_SQ = /'event-target-shim\/index'/g;
const FROM_DQ = /"event-target-shim\/index"/g;

let patchedCount = 0;
let scannedCount = 0;

for (const filePath of files) {
  scannedCount++;
  try {
    const original = fs.readFileSync(filePath, 'utf8');
    if (!original.includes('event-target-shim/index')) continue;
    const patched = original.replace(FROM_SQ, "'event-target-shim'").replace(FROM_DQ, '"event-target-shim"');
    if (patched !== original) {
      fs.writeFileSync(filePath, patched, 'utf8');
      patchedCount++;
    }
  } catch (err) {
    console.warn(`[patch-rn-webrtc] Skipped ${path.relative(ROOT, filePath)}: ${err.message}`);
  }
}

if (patchedCount > 0) {
  console.log(`[patch-rn-webrtc] Patched ${patchedCount} file(s) in react-native-webrtc (scanned ${scannedCount}).`);
} else {
  console.log(`[patch-rn-webrtc] Nothing to patch (already up to date, scanned ${scannedCount}).`);
}
