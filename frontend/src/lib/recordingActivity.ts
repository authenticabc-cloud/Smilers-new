/**
 * Tiny global "is a voice note recording right now?" signal (iter-307).
 *
 * Mirrors `callActivity`. Used by AppLockGate to SUPPRESS the PIN re-lock while
 * a voice note is being recorded. Starting a recording changes the audio
 * session (and may briefly flip AppState to inactive/active); with "Lock when
 * leaving" enabled that return-to-active was LOCKING the app mid-recording,
 * which unmounted the chat screen, tore down the recorder, and produced a
 * "Recording failed" error. While a recording is in progress we treat the app
 * as busy and skip the auto/lock-on-leaving relock, exactly like an active call.
 */
let activeCount = 0;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* ignore */
    }
  });
}

export const recordingActivity = {
  /** Mark a recording as in-progress. Returns a disposer to call when it ends. */
  enter(): () => void {
    activeCount += 1;
    notify();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      activeCount = Math.max(0, activeCount - 1);
      notify();
    };
  },
  isActive(): boolean {
    return activeCount > 0;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
