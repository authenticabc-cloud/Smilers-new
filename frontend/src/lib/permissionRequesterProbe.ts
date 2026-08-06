import { recordDiagnostic } from './diagnostics';

/**
 * permissionRequesterProbe — a TEMPORARY diagnostic (iter-462).
 *
 * On iOS the native Expo permission REQUESTERS were failing to register
 * ("Unrecognized requester: …"), so the OS permission prompt never appears and
 * the app never shows up in Settings' permission lists. The fix lives in the
 * native startup patch (`scripts/patch-expo-modules-race.js`), which re-runs
 * module registration once the legacy registry is ready.
 *
 * This probe measures the EFFECT of that fix over time — using only the GET
 * variants of the permission APIs, which DO NOT prompt the user. If a requester
 * is unregistered the GET throws "Unrecognized requester"; once registered it
 * returns a status. We sample at several delays and log each result to the
 * exportable diagnostic buffer, so a single exported log tells us exactly if
 * and WHEN each requester becomes available.
 */
let started = false;

function msg(e: any): string {
  return e?.message || String(e);
}

export function runPermissionRequesterProbe(): void {
  if (started) return;
  started = true;

  const probes: { name: string; fn: () => Promise<any> }[] = [];

  const add = (name: string, load: () => { fn: () => Promise<any> }) => {
    try {
      probes.push({ name, fn: load().fn });
    } catch (e) {
      recordDiagnostic({ tag: 'PROBE', source: 'permProbe', message: `load ${name} failed: ${msg(e)}` });
    }
  };

  add('imgpicker.media', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('expo-image-picker');
    return { fn: () => m.getMediaLibraryPermissionsAsync() };
  });
  add('imgpicker.camera', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('expo-image-picker');
    return { fn: () => m.getCameraPermissionsAsync() };
  });
  add('contacts', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('expo-contacts');
    return { fn: () => m.getPermissionsAsync() };
  });
  add('location', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('expo-location');
    return { fn: () => m.getForegroundPermissionsAsync() };
  });
  add('notifications', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('expo-notifications');
    return { fn: () => m.getPermissionsAsync() };
  });

  recordDiagnostic({ tag: 'PROBE', source: 'permProbe', message: `starting; ${probes.length} requesters to sample` });

  // Flush-proof build marker: the on-boot flush clears early events, but these
  // timer-fired PROBE samples persist — so embedding the build tag here gives a
  // reliable "did THIS code reach the build" signal on-device.
  const BUILD = 'iter463f-REREG';
  const delays = [400, 1500, 3000, 6000, 10000];
  delays.forEach((delay) => {
    setTimeout(() => {
      probes.forEach(async (p) => {
        try {
          const res = await p.fn();
          const status = res?.status ?? (res?.granted ? 'granted' : 'unknown');
          recordDiagnostic({ tag: 'PROBE', source: 'permProbe', message: `[${BUILD}] t=${delay}ms ${p.name} OK status=${status}` });
        } catch (e) {
          recordDiagnostic({ tag: 'PROBE', source: 'permProbe', message: `[${BUILD}] t=${delay}ms ${p.name} ERR ${msg(e)}` });
        }
      });
    }, delay);
  });

  // iter-463d: read the NATIVE boot timeline (mirrored into NSUserDefaults by
  // the expo-modules-core patch) via the committed SmilersCallModule bridge and
  // record it into the on-device diagnostic buffer. Fires at 4s/11s — AFTER the
  // on-boot flush — so these entries persist for the user to screenshot.
  [4000, 11000].forEach((delay) => {
    setTimeout(async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { NativeModules } = require('react-native');
        const mod = NativeModules?.SmilersCallModule;
        if (mod?.getNativeDiag) {
          const lines = await mod.getNativeDiag();
          const arr = Array.isArray(lines) ? lines : [];
          recordDiagnostic({ tag: 'NATDIAG', source: 'native', message: `[${BUILD}] t=${delay}ms nativeEvents=${arr.length}` });
          arr.forEach((l: any, i: number) =>
            recordDiagnostic({ tag: 'NATDIAG', source: 'native', message: `#${i} ${String(l)}` }),
          );
        } else {
          recordDiagnostic({ tag: 'NATDIAG', source: 'native', message: `[${BUILD}] t=${delay}ms getNativeDiag UNAVAILABLE (bridge missing)` });
        }
      } catch (e) {
        recordDiagnostic({ tag: 'NATDIAG', source: 'native', message: `[${BUILD}] t=${delay}ms read ERR ${msg(e)}` });
      }
    }, delay);
  });
}
