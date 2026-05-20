/**
 * Global helpers for the App Lock gate. Lets non-gate components (e.g. the
 * "Lock Now" button in the settings screen) trigger a lock without having to
 * propagate refs/contexts. The gate registers its handlers on mount.
 */

type Handler = () => void;

let lockNowHandler: Handler | null = null;
let reloadSettingsHandler: Handler | null = null;

export function registerAppLockHandlers(handlers: {
  lockNow: Handler;
  reloadSettings: Handler;
}) {
  lockNowHandler = handlers.lockNow;
  reloadSettingsHandler = handlers.reloadSettings;
  return () => {
    if (lockNowHandler === handlers.lockNow) lockNowHandler = null;
    if (reloadSettingsHandler === handlers.reloadSettings) reloadSettingsHandler = null;
  };
}

export function triggerLockNow() {
  if (lockNowHandler) {
    lockNowHandler();
  }
}

export function notifyAppLockSettingsChanged() {
  if (reloadSettingsHandler) {
    reloadSettingsHandler();
  }
}
