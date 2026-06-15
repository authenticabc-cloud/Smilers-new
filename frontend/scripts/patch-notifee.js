#!/usr/bin/env node
/**
 * Patch @notifee/react-native Android build.gradle to fix EAS build failures
 * caused by JitPack timeouts on `app.notifee:core:+`.
 *
 * Problem:
 *   Notifee's android/build.gradle declares:
 *     implementation(group: 'app.notifee', name: 'core', version: '+')
 *   The `+` (dynamic version) forces Gradle to query every repository for the
 *   latest version, including JitPack. JitPack is frequently slow / times out
 *   on EAS managed builds, killing the build with:
 *     Could not resolve app.notifee:core:+
 *     Read timed out (maven-metadata.xml on jitpack.io)
 *
 *   The Notifee AAR is actually shipped INSIDE node_modules at:
 *     android/libs/app/notifee/core/<version>/core-<version>.aar
 *   so the network call is completely unnecessary.
 *
 * Fix:
 *   1. Read the bundled maven-metadata.xml and extract the exact version
 *      shipped with the installed Notifee package (e.g., "202108261754").
 *   2. Replace `version: '+'` in build.gradle with that exact version. This
 *      lets Gradle resolve the dependency directly from the local file repo
 *      registered in the `allprojects { repositories { maven { url "$notifeeDir/android/libs" } } }`
 *      block, without ever reaching the network.
 *   3. Promote the local Notifee maven repo so it is tried BEFORE remote
 *      repos by inserting it at the head of allprojects repositories.
 *
 * Runs via the postinstall hook so the patch survives `node_modules` rebuilds
 * on EAS / clean installs.
 */
const fs = require('fs');
const path = require('path');

const NOTIFEE_ROOT = path.join(__dirname, '..', 'node_modules', '@notifee', 'react-native');
const BUILD_GRADLE = path.join(NOTIFEE_ROOT, 'android', 'build.gradle');
const METADATA = path.join(NOTIFEE_ROOT, 'android', 'libs', 'app', 'notifee', 'core', 'maven-metadata.xml');

if (!fs.existsSync(BUILD_GRADLE)) {
  console.log('[patch-notifee] @notifee/react-native not installed — skipping');
  process.exit(0);
}

if (!fs.existsSync(METADATA)) {
  console.log('[patch-notifee] maven-metadata.xml not found — skipping');
  process.exit(0);
}

// Parse the version shipped with the package.
const xml = fs.readFileSync(METADATA, 'utf8');
const releaseMatch = xml.match(/<release>([^<]+)<\/release>/);
const latestMatch = xml.match(/<latest>([^<]+)<\/latest>/);
const version = (releaseMatch && releaseMatch[1]) || (latestMatch && latestMatch[1]);

if (!version) {
  console.log('[patch-notifee] Could not parse Notifee core version from maven-metadata.xml — skipping');
  process.exit(0);
}

const original = fs.readFileSync(BUILD_GRADLE, 'utf8');
let patched = original;
let didChange = false;

// 1. Pin version: replace `version: '+'` with the local version.
const PIN_RE = /implementation\(group:\s*'app\.notifee',\s*name:\s*'core',\s*version:\s*'\+'\)/;
if (PIN_RE.test(patched)) {
  patched = patched.replace(
    PIN_RE,
    `implementation(group: 'app.notifee', name: 'core', version: '${version}')`,
  );
  didChange = true;
}

// 2. Inject local maven repo into Notifee module's own `repositories { ... }` block
//    (the one near line 90) so Gradle finds the AAR without traversing remote repos.
const LOCAL_REPO_LINE = `maven { url "$notifeeDir/android/libs" }`;
const MODULE_REPO_RE = /repositories\s*\{\s*\n\s*google\(\)\s*\n\s*mavenCentral\(\)\s*\n\s*\}/m;
if (MODULE_REPO_RE.test(patched) && !patched.includes('"$notifeeDir/android/libs"\n  }\n  google()')) {
  patched = patched.replace(
    MODULE_REPO_RE,
    `repositories {\n  maven { url "$notifeeDir/android/libs" }\n  google()\n  mavenCentral()\n}`,
  );
  didChange = true;
}

if (!didChange) {
  console.log(`[patch-notifee] Nothing to patch (already pinned to ${version}).`);
  process.exit(0);
}

fs.writeFileSync(BUILD_GRADLE, patched, 'utf8');
console.log(`[patch-notifee] Pinned app.notifee:core to ${version} and promoted local maven repo.`);
