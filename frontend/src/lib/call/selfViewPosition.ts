/**
 * selfViewPosition.ts — persist the draggable video call self-view (PiP)
 * position across calls.
 *
 * The user drags the small local-camera preview anywhere on screen. We store
 * the final translate offset (relative to the default bottom-right anchor) in
 * AsyncStorage so the NEXT call restores the preview to the same spot instead
 * of resetting to the corner every time.
 *
 * Values are the clamped { tx, ty } translate deltas produced by the call
 * screen's PanResponder — they are re-clamped to the current screen bounds on
 * restore, so a saved position from a different orientation/size never pushes
 * the preview off-screen.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'smilers.call.selfViewPos.v1';

export type SelfViewPos = { tx: number; ty: number };

export async function loadSelfViewPos(): Promise<SelfViewPos | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.tx === 'number' &&
      typeof parsed.ty === 'number' &&
      Number.isFinite(parsed.tx) &&
      Number.isFinite(parsed.ty)
    ) {
      return { tx: parsed.tx, ty: parsed.ty };
    }
  } catch {}
  return null;
}

export function saveSelfViewPos(pos: SelfViewPos): void {
  try {
    void AsyncStorage.setItem(KEY, JSON.stringify(pos)).catch(() => {});
  } catch {}
}
