/**
 * Lightweight global touch-activity tracker so floating UI (Voice Command FAB
 * etc.) can auto-hide when the user isn't touching the screen and reappear
 * when they do. Mirrors the web app's behavior where the mic FAB fades out
 * during inactivity and pops back in on any tap.
 */

type Listener = () => void;

let lastTouchAt = Date.now();
const listeners = new Set<Listener>();

export function recordTouchActivity(): void {
  lastTouchAt = Date.now();
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Ignore listener errors so one bad subscriber can't break others.
    }
  });
}

export function subscribeTouchActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLastTouchAt(): number {
  return lastTouchAt;
}
