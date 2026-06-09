/**
 * BLE manager — web stub (iter-146).
 *
 * `react-native-ble-plx` has no web entry, so the web bundle uses this
 * no-op companion. Every export mirrors the native API and resolves
 * with safe defaults so the Emergency screen can render normally in
 * the web preview (it just shows the "Bluetooth not supported here"
 * branch instead of opening the picker).
 */

export interface BleDeviceInfo {
  id: string;
  name: string | null;
  rssi: number | null;
}

export const PANIC_SERVICE_UUID: string | null = null;
export const PANIC_CHARACTERISTIC_UUID: string | null = null;

export function isBleAvailable(): boolean {
  return false;
}

export function getBleLoadError(): string | null {
  return 'Bluetooth is not supported in the web preview.';
}

export async function ensureBlePermissions(): Promise<boolean> {
  return false;
}

export async function getPairedDevice(): Promise<{ id: string; name: string | null } | null> {
  return null;
}

export async function scanForDevices(
  _onDevice: (device: BleDeviceInfo) => void,
  _timeoutMs?: number,
): Promise<void> {
  throw new Error('Bluetooth is not supported in the web preview.');
}

export function stopScan() {
  /* noop */
}

export async function connectAndSubscribe(
  _deviceId: string,
  _deviceName?: string | null,
): Promise<boolean> {
  return false;
}

export async function unpair(): Promise<void> {
  /* noop */
}

export async function autoReconnect(): Promise<boolean> {
  return false;
}

export function setPanicPressListener(_fn: (() => void) | null) {
  /* noop */
}

export function isConnected(): boolean {
  return false;
}
