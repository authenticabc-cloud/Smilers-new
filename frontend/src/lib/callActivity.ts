/**
 * Tiny global "is a call on screen right now?" signal (iter-297).
 *
 * Used by AppLockGate to SUPPRESS the PIN re-lock while a voice/video call is
 * active. A WebRTC call triggers frequent AppState background/inactive/active
 * transitions (audio-route changes, proximity sensor, the in-call notification,
 * permission prompts). With "Lock when leaving" enabled, each return to active
 * was re-locking the app — so the PIN screen kept flashing over the call every
 * few seconds. Ref-counted so both the 1:1 overlay and the group-call route can
 * register independently.
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

export const callActivity = {
  /** Mark a call screen as mounted. Returns a disposer to call on unmount. */
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
