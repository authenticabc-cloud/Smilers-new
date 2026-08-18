/**
 * Local "opened" tracking for received emergency alerts, so the Settings
 * Emergency row can show a red badge for ACTIVE alerts the user hasn't opened
 * yet. Purely on-device (AsyncStorage) — the alert list itself is reactive from
 * Convex (`getReceivedAlerts`); this only records which alertIds were viewed.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'smilers.emergency.openedAlertIds.v1';

export async function getOpenedAlertIds(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

export async function markAlertOpened(alertId: string): Promise<void> {
  if (!alertId) return;
  try {
    const set = await getOpenedAlertIds();
    if (set.has(alertId)) return;
    set.add(alertId);
    // Cap to the most recent 200 ids to keep storage small.
    const arr = Array.from(set).slice(-200);
    await AsyncStorage.setItem(KEY, JSON.stringify(arr));
  } catch {
    /* best-effort */
  }
}
