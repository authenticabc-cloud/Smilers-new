#!/usr/bin/env node
/**
 * patch-rn-skia-webp.js
 *
 * WHY: @shopify/react-native-skia ships a prebuilt `libskia.a` (inside
 * libskia.xcframework) that STATICALLY bundles its own copy of `libwebp`
 * (object members named `libwebp.*.o`). Our app ALSO links a standalone
 * `libwebp.framework` pulled in transitively by `expo-image` -> `SDWebImage`
 * (SDWebImageWebPCoder -> libwebp). At the app link step both provide the SAME
 * WebP C symbols (`_VP8LPredictor*_C`, `_WebP*`, `_kSLog2Table`, ...) so the
 * iOS archive fails with "ld: 75 duplicate symbols".
 *
 * FIX: Strip the bundled `libwebp.*.o` members out of Skia's static libraries
 * so exactly ONE copy of WebP is linked. Skia's internal WebP references then
 * resolve against the standalone `libwebp.framework` (same libwebp C ABI). We
 * keep the standalone framework because expo-image / SDWebImage were compiled
 * against ITS headers and must remain the provider (expo-image is core to the
 * app; Skia's WebP usage is incidental).
 *
 * Skia's device slice (ios-arm64_arm64e) is a FAT/universal static archive, so
 * we can't `ar d` it directly — we split each arch with `lipo`, delete the
 * libwebp members from the thin archive, then recombine.
 *
 * Runs from the postinstall/prepare chain on the EAS macOS builder AFTER
 * `yarn install` (before pod install / Xcode archive), so it applies to the
 * fresh node_modules every build. Idempotent, and NEVER throws — on the local
 * Linux sandbox `ar`/`lipo` aren't the Apple toolchain, so it logs & skips.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function log(msg) {
  console.log(`[patch-rn-skia-webp] ${msg}`);
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

function findSkiaDeviceLibs() {
  const base = path.join(
    __dirname,
    '..',
    'node_modules',
    '@shopify',
    'react-native-skia',
    'libs',
    'apple',
    'libskia.xcframework'
  );
  if (!fs.existsSync(base)) return [];
  const libs = [];
  for (const slice of fs.readdirSync(base)) {
    // Only the iOS device/simulator slices participate in the app archive link.
    if (!slice.startsWith('ios-')) continue;
    const lib = path.join(base, slice, 'libskia.a');
    if (fs.existsSync(lib)) libs.push({ slice, lib });
  }
  return libs;
}

function listWebpMembers(archive) {
  const members = run('ar', ['t', archive])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return members.filter((m) => /^libwebp.*\.o$/.test(m));
}

function stripThin(archive, label) {
  const webp = listWebpMembers(archive);
  if (webp.length === 0) return 0;
  run('ar', ['d', archive, ...webp]);
  try {
    run('ranlib', [archive]);
  } catch (_) {
    /* best-effort */
  }
  log(`${label}: removed ${webp.length} libwebp object(s)`);
  return webp.length;
}

function getArches(lib) {
  // `lipo -archs` prints e.g. "arm64 arm64e"; throws / prints error for a
  // non-fat (thin) archive.
  return run('lipo', ['-archs', lib]).trim().split(/\s+/).filter(Boolean);
}

function stripLib({ slice, lib }) {
  let arches;
  try {
    arches = getArches(lib);
  } catch (e) {
    // Not a fat file (thin single-arch archive) OR non-Apple toolchain.
    // Try treating it as a plain thin archive.
    try {
      const n = stripThin(lib, `${slice}/libskia.a`);
      if (n === 0) log(`${slice}/libskia.a: already clean`);
    } catch (e2) {
      log(`skip ${slice}/libskia.a (cannot process: ${e2.message.split('\n')[0]})`);
    }
    return;
  }

  if (arches.length <= 1) {
    // Thin archive reported by lipo — operate directly.
    try {
      const n = stripThin(lib, `${slice}/libskia.a`);
      if (n === 0) log(`${slice}/libskia.a: already clean`);
    } catch (e) {
      log(`skip ${slice}/libskia.a (cannot strip: ${e.message.split('\n')[0]})`);
    }
    return;
  }

  // Fat archive: split -> strip each arch -> recombine.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skia-webp-'));
  const thinPaths = [];
  let total = 0;
  let touched = false;
  try {
    for (const arch of arches) {
      const thin = path.join(tmp, `libskia-${arch}.a`);
      run('lipo', [lib, '-thin', arch, '-output', thin]);
      try {
        total += stripThin(thin, `${slice}/libskia.a[${arch}]`);
        touched = true;
      } catch (_) {
        /* keep this arch as-is if it can't be stripped */
      }
      thinPaths.push(thin);
    }
    if (touched && total > 0) {
      run('lipo', ['-create', ...thinPaths, '-output', lib]);
      log(`${slice}/libskia.a: recombined ${arches.length} arch(es), ${total} libwebp object(s) removed`);
    } else {
      log(`${slice}/libskia.a: already clean`);
    }
  } catch (e) {
    log(`skip ${slice}/libskia.a (fat strip failed: ${e.message.split('\n')[0]})`);
  } finally {
    try {
      for (const p of thinPaths) if (fs.existsSync(p)) fs.unlinkSync(p);
      fs.rmdirSync(tmp);
    } catch (_) {
      /* ignore cleanup errors */
    }
  }
}

function main() {
  const libs = findSkiaDeviceLibs();
  if (libs.length === 0) {
    log('react-native-skia libskia.xcframework not found — skipping');
    return;
  }
  for (const entry of libs) stripLib(entry);
}

try {
  main();
} catch (e) {
  log(`unexpected error (ignored): ${e && e.message}`);
}
// Always succeed so the postinstall chain is never broken.
process.exit(0);
