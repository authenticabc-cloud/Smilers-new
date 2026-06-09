/**
 * BLE manager — iter-146.
 *
 * Wraps `react-native-ble-plx` so the rest of the app can pair, persist,
 * and auto-reconnect to a panic-button / wearable heart-rate device
 * without each screen reimplementing the wheel.
 *
 * Capabilities
 *   • Scan for nearby BLE peripherals (returns RSSI-sorted list)
 *   • Connect & discover all services + characteristics
 *   • Subscribe to ANY notifying characteristic and forward bytes to a
 *     listener — we treat any non-zero notify as a "panic press" until
 *     the web team supplies the canonical service/characteristic UUIDs
 *     (placeholders documented below).
 *   • Persist the paired device id in AsyncStorage so we can
 *     auto-reconnect on every app launch.
 *
 * Notes
 *   • This module is a NO-OP on web (BleManager isn't loadable there).
 *   • Auto-reconnect is best-effort — if the device is off / out of
 *     range, we silently wait and try again on the next app focus.
 *   • Permissions (BLUETOOTH_SCAN/CONNECT + ACCESS_FINE_LOCATION on
 *     Android, NSBluetoothAlwaysUsageDescription on iOS) are declared
 *     in `app.json` (iter-146).
 *
 * Canonical contract TODO
 *   The web team has not yet sent the service/characteristic UUIDs
 *   used to identify panic-press notifications. Until they do, we
 *   subscribe to every notifying characteristic on the device and
 *   forward any non-zero byte as a panic press. Swap in the canonical
 *   UUIDs in `PANIC_SERVICE_UUID` / `PANIC_CHARACTERISTIC_UUID` below
 *   to filter.
 */

import { Platform, PermissionsAndroid } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Lazy require so web builds don't blow up on a missing native module.
// Use a string-evaluated require so Metro doesn't try to resolve the
// module at bundle time on web — that was causing a 500 on the web
// preview because react-native-ble-plx has no web entry.
let BleManager: any = null;
let bleManager: any = null;
let LoadError: any = null;
try {
  if (Platform.OS === 'android' || Platform.OS === 'ios') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-ble-plx');
    BleManager = mod.BleManager;
    bleManager = new BleManager();
  }
} catch (errorValue) {
  LoadError = errorValue;
  // eslint-disable-next-line no-console
  console.warn('[ble] react-native-ble-plx not loaded:', (errorValue as any)?.message);
}

const PAIRED_DEVICE_KEY = 'smilers.ble.pairedDeviceId';
const PAIRED_DEVICE_NAME_KEY = 'smilers.ble.pairedDeviceName';

/** Canonical Heart Rate Monitor BLE service + characteristic (SIG 0x180D / 0x2A37).
 *  Confirmed against the web app's `use-heart-rate-monitor.ts`. */
export const HEART_RATE_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb';
export const HEART_RATE_CHARACTERISTIC_UUID = '00002a37-0000-1000-8000-00805f9b34fb';

/** Default thresholds — match web `panicModeSettings` defaults. */
export const DEFAULT_BPM_THRESHOLD = 130;
export const DEFAULT_SUSTAINED_SECONDS = 10;

/** Mutable runtime thresholds — Emergency screen pushes the user's current
 *  panic-mode settings here so a slider change takes effect on the next
 *  notification without re-subscribing to the characteristic. */
let runtimeBpmThreshold = DEFAULT_BPM_THRESHOLD;
let runtimeSustainedMs = DEFAULT_SUSTAINED_SECONDS * 1000;
let runtimeCooldownMs = 20 * 60 * 1000;
let lastPanicFiredAt = 0;

/** Update the BPM threshold + sustained window used by the live BLE
 *  subscription. Safe to call repeatedly (e.g. on every slider tick). */
export function setPanicThresholds(opts: {
  triggerBpm?: number;
  sustainedSeconds?: number;
  cooldownMinutes?: number;
}) {
  if (typeof opts.triggerBpm === 'number' && Number.isFinite(opts.triggerBpm) && opts.triggerBpm > 0) {
    runtimeBpmThreshold = opts.triggerBpm;
  }
  if (
    typeof opts.sustainedSeconds === 'number' &&
    Number.isFinite(opts.sustainedSeconds) &&
    opts.sustainedSeconds > 0
  ) {
    runtimeSustainedMs = opts.sustainedSeconds * 1000;
  }
  if (
    typeof opts.cooldownMinutes === 'number' &&
    Number.isFinite(opts.cooldownMinutes) &&
    opts.cooldownMinutes >= 0
  ) {
    runtimeCooldownMs = opts.cooldownMinutes * 60 * 1000;
  }
}

/** Parse a Heart Rate Measurement notification per the Bluetooth SIG
 *  spec (byte 0 = flags; bit 0 indicates 16-bit BPM payload).
 *  `b64` is the base64 string `react-native-ble-plx` hands us. */
export function parseHeartRateMeasurement(b64: string | null): number | null {
  if (!b64) return null;
  try {
    // Manual base64 → byte array (no Node Buffer on RN).
    const binary =
      typeof atob === 'function'
        ? atob(b64)
        : Buffer.from(b64, 'base64').toString('binary');
    const bytes: number[] = [];
    for (let index = 0; index < binary.length; index += 1) {
      bytes.push(binary.charCodeAt(index));
    }
    if (bytes.length < 2) return null;
    const flags = bytes[0];
    const is16Bit = (flags & 0x01) === 0x01;
    if (is16Bit && bytes.length >= 3) {
      // Little-endian uint16 at offset 1.
      return bytes[1] | (bytes[2] << 8);
    }
    return bytes[1];
  } catch {
    return null;
  }
}

export interface BleDeviceInfo {
  id: string;
  name: string | null;
  rssi: number | null;
}

let onPanicPressListener: (() => void) | null = null;
let connectedDevice: any = null;
let notifySubscriptions: any[] = [];

export function isBleAvailable(): boolean {
  return bleManager !== null;
}

/** Get the human-readable reason BLE isn't available (for UI display). */
export function getBleLoadError(): string | null {
  if (Platform.OS === 'web') return 'Bluetooth is not supported in the web preview.';
  if (LoadError) return String((LoadError as any)?.message || LoadError);
  if (!bleManager) return 'Bluetooth module is unavailable in this build. Please use the production APK.';
  return null;
}

/** Request the runtime permissions required for BLE scanning on Android 12+. */
export async function ensureBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    const apiLevel = Number(Platform.Version) || 0;
    const perms: string[] =
      apiLevel >= 31
        ? [
            (PermissionsAndroid.PERMISSIONS as any).BLUETOOTH_SCAN,
            (PermissionsAndroid.PERMISSIONS as any).BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          ]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    const result = await PermissionsAndroid.requestMultiple(perms as any);
    return Object.values(result).every((value) => value === PermissionsAndroid.RESULTS.GRANTED);
  } catch {
    return false;
  }
}

/** Returns the last paired device id + name, or null if none. */
export async function getPairedDevice(): Promise<{ id: string; name: string | null } | null> {
  try {
    const id = await AsyncStorage.getItem(PAIRED_DEVICE_KEY);
    if (!id) return null;
    const name = await AsyncStorage.getItem(PAIRED_DEVICE_NAME_KEY);
    return { id, name };
  } catch {
    return null;
  }
}

async function setPairedDevice(id: string | null, name: string | null) {
  try {
    if (id) await AsyncStorage.setItem(PAIRED_DEVICE_KEY, id);
    else await AsyncStorage.removeItem(PAIRED_DEVICE_KEY);
    if (name) await AsyncStorage.setItem(PAIRED_DEVICE_NAME_KEY, name);
    else await AsyncStorage.removeItem(PAIRED_DEVICE_NAME_KEY);
  } catch {
    /* best-effort */
  }
}

/** Scan for nearby BLE peripherals. Auto-stops after `timeoutMs`. */
export async function scanForDevices(
  onDevice: (device: BleDeviceInfo) => void,
  timeoutMs: number = 10_000,
): Promise<void> {
  if (!bleManager) throw new Error(getBleLoadError() || 'BLE unavailable');
  const granted = await ensureBlePermissions();
  if (!granted) throw new Error('Bluetooth permission denied');

  const seen = new Set<string>();
  bleManager.startDeviceScan(null, null, (err: any, device: any) => {
    if (err) {
      bleManager.stopDeviceScan();
      // eslint-disable-next-line no-console
      console.warn('[ble] scan error:', err?.message);
      return;
    }
    if (!device?.id) return;
    if (seen.has(device.id)) return;
    seen.add(device.id);
    // Only surface peripherals that advertise a name — anonymous
    // beacons are not useful for a user-facing pairing list.
    if (device.name) {
      onDevice({ id: device.id, name: device.name || null, rssi: device.rssi ?? null });
    }
  });

  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  bleManager.stopDeviceScan();
}

/** Stop an ongoing scan immediately (e.g. user picked a device). */
export function stopScan() {
  try {
    bleManager?.stopDeviceScan();
  } catch {}
}

/** Connect to a device by id, discover services, and subscribe for
 *  panic-press notifications. Persists the device on success. */
export async function connectAndSubscribe(
  deviceId: string,
  deviceName?: string | null,
): Promise<boolean> {
  if (!bleManager) throw new Error(getBleLoadError() || 'BLE unavailable');
  // Stop any prior connection cleanly.
  await disconnect();
  const device = await bleManager.connectToDevice(deviceId, { autoConnect: true });
  await device.discoverAllServicesAndCharacteristics();
  connectedDevice = device;
  await setPairedDevice(deviceId, deviceName || device.name || null);

  // iter-147: lock to canonical Heart Rate Monitor service. Drop the
  // generic "any notifying characteristic" subscription — that was a
  // placeholder. We now mirror the web behavior exactly: subscribe to
  // the BPM characteristic, parse the value, fire a panic press only
  // after BPM stays >= threshold for `sustainedSeconds` continuously.
  // Thresholds + cooldown read from module-scope so a slider change in
  // the Emergency screen takes effect on the very next notification.
  let aboveThresholdSince: number | null = null;
  const services = await device.services();
  for (const service of services) {
    if (service.uuid.toLowerCase() !== HEART_RATE_SERVICE_UUID.toLowerCase()) {
      continue;
    }
    const characteristics = await service.characteristics();
    for (const characteristic of characteristics) {
      if (!characteristic.isNotifiable) continue;
      if (characteristic.uuid.toLowerCase() !== HEART_RATE_CHARACTERISTIC_UUID.toLowerCase()) {
        continue;
      }
      const sub = characteristic.monitor((err: any, ch: any) => {
        if (err) return;
        const bpm = parseHeartRateMeasurement(ch?.value || null);
        if (bpm == null) return;
        if (bpm >= runtimeBpmThreshold) {
          if (aboveThresholdSince == null) {
            aboveThresholdSince = Date.now();
          } else if (Date.now() - aboveThresholdSince >= runtimeSustainedMs) {
            const now = Date.now();
            if (now - lastPanicFiredAt >= runtimeCooldownMs) {
              // Fire once, observe the user's cooldown window before
              // another sustained high-BPM episode can trigger again
              // (matches web `cooldownMinutes` semantics).
              lastPanicFiredAt = now;
              onPanicPressListener?.();
            }
            aboveThresholdSince = null;
          }
        } else {
          aboveThresholdSince = null;
        }
      });
      notifySubscriptions.push(sub);
    }
  }
  return true;
}

/** Disconnect the current device and forget the paired id. */
export async function unpair(): Promise<void> {
  await disconnect();
  await setPairedDevice(null, null);
}

async function disconnect() {
  try {
    notifySubscriptions.forEach((sub) => {
      try {
        sub.remove?.();
      } catch {}
    });
    notifySubscriptions = [];
    if (connectedDevice) {
      await bleManager?.cancelDeviceConnection(connectedDevice.id);
      connectedDevice = null;
    }
  } catch {
    /* best-effort */
  }
}

/** Auto-reconnect on app launch (best-effort, silent on failure). */
export async function autoReconnect(): Promise<boolean> {
  if (!bleManager) return false;
  const paired = await getPairedDevice();
  if (!paired) return false;
  try {
    await connectAndSubscribe(paired.id, paired.name);
    return true;
  } catch {
    return false;
  }
}

/** Register the listener that fires when a panic press is detected. */
export function setPanicPressListener(fn: (() => void) | null) {
  onPanicPressListener = fn;
}

export function isConnected(): boolean {
  return !!connectedDevice;
}
