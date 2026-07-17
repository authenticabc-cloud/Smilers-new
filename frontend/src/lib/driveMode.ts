/**
 * driveMode — global hands-free "Drive Mode" state.
 *
 * When ON, a single continuous speech recognizer listens for a small set of
 * command words (answer / decline / reject / listen / watch) that work for ALL
 * incoming calls and messages, not just the user's voice-task contacts. Kept as
 * a tiny module singleton (like localReadState) so the toggle, the controller
 * and the voice-command launcher can all read/observe it without prop drilling.
 *
 * NOT persisted across app restarts on purpose — always-listening should be an
 * explicit, deliberate action each session.
 */
import { useEffect, useState } from 'react';

let enabled = false;
const listeners = new Set<(v: boolean) => void>();

export const DRIVE_DECLINE_REPLY = "I'm driving and will call you back.";

export function isDriveModeEnabled(): boolean {
  return enabled;
}

export function setDriveMode(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  listeners.forEach((l) => {
    try {
      l(enabled);
    } catch {
      /* ignore */
    }
  });
}

export function toggleDriveMode(): boolean {
  setDriveMode(!enabled);
  return enabled;
}

export function subscribeDriveMode(cb: (v: boolean) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useDriveMode(): boolean {
  const [v, setV] = useState(enabled);
  useEffect(() => subscribeDriveMode(setV), []);
  return v;
}
