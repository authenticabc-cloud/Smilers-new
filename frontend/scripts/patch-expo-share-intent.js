#!/usr/bin/env node
/* eslint-disable */
/**
 * patch-expo-share-intent.js — runs after `yarn install` / `npm install`.
 *
 * Fixes TWO bugs in expo-share-intent@5.1.1 that together break single-
 * file share-to-app on Android:
 *
 *  1. NATIVE (ExpoShareIntentModule.kt line ~146): misplaced `)` in
 *     `mapOf("files" to arrayOf(getFileInfo(uri), "type" to "file"))`
 *     produces a corrupted Array<Any> where element [1] is a stray
 *     Kotlin Pair instead of a regular file map.
 *
 *  2. JS (build/utils.js parseShareIntent): the parser calls
 *     `file.mimeType.startsWith("image/")` on EVERY element of the
 *     files array. When the array contains the stray Pair (from bug
 *     #1) — OR any other malformed entry — this throws TypeError,
 *     which `useShareIntent.js` silently catches and resets the
 *     entire share-intent state to empty. The result: the user lands
 *     on "Nothing shared yet" even though the share intent fired.
 *
 * Symptoms WITHOUT this patch (single-file share-to-Smilers on Android):
 *   "Share to Smilers" screen opens → renders "Nothing shared yet"
 *   instead of the recipient picker with the file.
 *
 * The JS patch (#2) is the critical one because it ships in OTA
 * updates and fixes the symptom even if the native APK still has
 * bug #1. The native patch (#1) is the proper fix that requires a
 * full APK rebuild.
 *
 * Idempotent: re-running on already-patched files is a no-op.
 */

const fs = require('fs');
const path = require('path');

const ANDROID_TARGET = path.resolve(
  __dirname,
  '..',
  'node_modules',
  'expo-share-intent',
  'android',
  'src',
  'main',
  'java',
  'expo',
  'modules',
  'shareintent',
  'ExpoShareIntentModule.kt',
);

const ANDROID_BAD = 'notifyShareIntent(mapOf( "files" to arrayOf(getFileInfo(uri), "type" to "file")))';
const ANDROID_GOOD = 'notifyShareIntent(mapOf( "files" to arrayOf(getFileInfo(uri)), "type" to "file"))';

const JS_TARGETS = [
  // ESM build (used when bundler picks "module" / "exports")
  path.resolve(__dirname, '..', 'node_modules', 'expo-share-intent', 'build', 'utils.js'),
];

// The two lines we need to fix in parseShareIntent (the array .filter and
// the .every check). Both are too narrow to match anything else by accident.
const JS_PATCHES = [
  {
    bad: 'const files = shareIntent?.files?.filter((file) => file.path || file.contentUri) ||\n            [];',
    good: 'const files = shareIntent?.files?.filter((file) => file && typeof file === "object" && (file.path || file.contentUri)) ||\n            [];',
    label: 'utils.js: file filter null-safety',
  },
  {
    bad: 'const isMedia = files.every((file) => file.mimeType.startsWith("image/") ||\n            file.mimeType.startsWith("video/"));',
    good: 'const isMedia = files.length > 0 && files.every((file) => typeof file?.mimeType === "string" && (file.mimeType.startsWith("image/") ||\n            file.mimeType.startsWith("video/")));',
    label: 'utils.js: isMedia mimeType null-safety (THE critical fix)',
  },
  {
    bad: 'if (!file.path && !file.contentUri)\n                        return acc;',
    good: 'if (!file || typeof file !== "object" || (!file.path && !file.contentUri))\n                        return acc;',
    label: 'utils.js: reduce null-safety',
  },
];

function patchFile(target, patches) {
  if (!fs.existsSync(target)) {
    console.log(`[patch-expo-share-intent] ${path.basename(target)} not found — skipping.`);
    return;
  }
  let src = fs.readFileSync(target, 'utf8');
  let changed = false;
  let skipped = 0;
  for (const { bad, good, label } of patches) {
    if (src.includes(good) && !src.includes(bad)) {
      skipped += 1;
      continue;
    }
    if (!src.includes(bad)) {
      console.log(`[patch-expo-share-intent] ${label}: original NOT found — skipping (upstream may have changed).`);
      continue;
    }
    src = src.replace(bad, good);
    changed = true;
    console.log(`[patch-expo-share-intent] ${label} ✓`);
  }
  if (changed) {
    fs.writeFileSync(target, src, 'utf8');
    console.log(`[patch-expo-share-intent] ${path.basename(target)} updated.`);
  } else if (skipped === patches.length) {
    console.log(`[patch-expo-share-intent] ${path.basename(target)} already patched — no-op.`);
  }
}

function main() {
  // Native (Android Kotlin)
  patchFile(ANDROID_TARGET, [
    { bad: ANDROID_BAD, good: ANDROID_GOOD, label: 'Kotlin: outer-map mis-parenthesis' },
  ]);
  // JS (works without an APK rebuild — ships in OTA updates)
  for (const target of JS_TARGETS) {
    patchFile(target, JS_PATCHES);
  }
}

try {
  main();
} catch (errorValue) {
  console.warn('[patch-expo-share-intent] Patch failed:', errorValue && errorValue.message);
  // Never fail the install over this — patch is best-effort.
  process.exit(0);
}
