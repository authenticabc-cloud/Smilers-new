// systemUIActivity — a global "a native picker / system UI is on screen" flag,
// mirroring callActivity / recordingActivity.
//
// WHY: launching a native picker (document/file, image library, camera, share
// sheet) sends our Activity to the background and brings it back to `active`
// when the user is done. With the App-Lock "Lock when leaving" option enabled,
// AppLockGate treated that return-to-active as "the user left the app" and
// re-locked — so after picking a file the app locked and, on unlock, reset to
// the chats home, losing the in-progress attachment. On Android there is no
// reliable AppState signal that distinguishes a picker round-trip from truly
// leaving the app, so we bracket picker launches with this explicit guard and
// AppLockGate skips the re-lock while it is active.
type Listener = (active: boolean) => void;

let activeCount = 0;
const listeners = new Set<Listener>();

function emit() {
  const active = activeCount > 0;
  listeners.forEach((l) => {
    try {
      l(active);
    } catch {
      /* ignore listener errors */
    }
  });
}

export const systemUIActivity = {
  /** Mark a native-UI interaction as started. Returns an idempotent disposer. */
  enter(): () => void {
    activeCount += 1;
    emit();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      activeCount = Math.max(0, activeCount - 1);
      emit();
    };
  },

  isActive(): boolean {
    return activeCount > 0;
  },

  /**
   * Run an async native-UI call (picker/share) with the guard held for its
   * whole duration. The disposer is delayed ~1.5s after the promise settles
   * because the AppState `active` event fires slightly AFTER the picker promise
   * resolves — we must still be "active" when AppLockGate handles it.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const dispose = this.enter();
    try {
      return await fn();
    } finally {
      setTimeout(dispose, 1500);
    }
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
