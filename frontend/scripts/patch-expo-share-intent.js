#!/usr/bin/env node
/* eslint-disable */
/**
 * patch-expo-share-intent.js — runs after `yarn install` / `npm install`.
 *
 * Fixes upstream bug in expo-share-intent@5.1.1 where single-file SEND
 * intents on Android produce a corrupted payload (misplaced `)` in
 * `ExpoShareIntentModule.kt`). Symptom: tapping "Smilers" in the Android
 * share sheet when sharing 1 file lands the user on the share-receiver
 * screen with "Nothing shared yet" because `files[]` arrives as a
 * malformed array containing a stray `Pair("type","file")` element.
 *
 * Bug (line ~146):
 *   notifyShareIntent(mapOf( "files" to arrayOf(getFileInfo(uri), "type" to "file")))
 * Fixed:
 *   notifyShareIntent(mapOf( "files" to arrayOf(getFileInfo(uri)), "type" to "file"))
 *
 * Idempotent: re-running on an already-patched file is a no-op.
 */

const fs = require('fs');
const path = require('path');

const TARGET = path.resolve(
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

const BAD = 'notifyShareIntent(mapOf( "files" to arrayOf(getFileInfo(uri), "type" to "file")))';
const GOOD = 'notifyShareIntent(mapOf( "files" to arrayOf(getFileInfo(uri)), "type" to "file"))';

function main() {
  if (!fs.existsSync(TARGET)) {
    console.log('[patch-expo-share-intent] File not found — skipping (lib not installed).');
    return;
  }
  let src = fs.readFileSync(TARGET, 'utf8');
  if (src.includes(GOOD) && !src.includes(BAD)) {
    console.log('[patch-expo-share-intent] Already patched — no changes needed.');
    return;
  }
  if (!src.includes(BAD)) {
    console.log('[patch-expo-share-intent] Original bad line NOT found — upstream may have fixed this. Skipping.');
    return;
  }
  src = src.replace(BAD, GOOD);
  fs.writeFileSync(TARGET, src, 'utf8');
  console.log('[patch-expo-share-intent] Patched single-file SEND payload bug ✓');
}

try {
  main();
} catch (errorValue) {
  console.warn('[patch-expo-share-intent] Patch failed:', errorValue && errorValue.message);
  // Never fail the install over this — patch is best-effort.
  process.exit(0);
}
