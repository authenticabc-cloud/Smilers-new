import { useEffect, useState } from 'react';

/**
 * callDebugLog — a tiny in-memory ring buffer + pub/sub so the call screen
 * and CallSession can append "what just happened" entries and a visible
 * on-screen overlay can render them in real time.
 *
 * Purpose: the user is testing on production APKs where `console.log` is
 * not visible. Reading `adb logcat` is friction. By rendering the same
 * events ON SCREEN, the user can take a single screenshot and we can see
 * exactly what step the call/screen-share flow failed on — without
 * speculating about native crashes or schema mismatches.
 *
 * Usage:
 *   import { callDebug } from '../lib/callDebugLog';
 *   callDebug.push('PC', 'state=connected');
 *   const events = useCallDebugLog();
 */

export interface CallDebugEvent {
  /** Monotonic id. */
  id: number;
  /** ms since epoch when the event was pushed. */
  ts: number;
  /** Short tag (e.g. 'PC', 'SIG', 'SCREEN', 'ERR'). */
  tag: string;
  /** Human-readable message. */
  message: string;
}

type Listener = (events: CallDebugEvent[]) => void;

class CallDebugBuffer {
  private buf: CallDebugEvent[] = [];
  private listeners = new Set<Listener>();
  private nextId = 1;
  private readonly limit = 60;

  push(tag: string, message: string) {
    const event: CallDebugEvent = {
      id: this.nextId++,
      ts: Date.now(),
      tag: tag.slice(0, 8),
      message: String(message).slice(0, 240),
    };
    this.buf.push(event);
    if (this.buf.length > this.limit) this.buf.shift();
    // Also mirror to console so a dev build with adb logcat still sees them.
    try {
      // eslint-disable-next-line no-console
      console.log(`[callDebug:${event.tag}]`, event.message);
    } catch {}
    for (const listener of this.listeners) {
      try {
        listener([...this.buf]);
      } catch {
        /* listener errors are not fatal. */
      }
    }
  }

  /** Clears the buffer — used by the overlay's "clear" button. */
  clear() {
    this.buf = [];
    for (const listener of this.listeners) {
      try {
        listener([]);
      } catch {}
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    try {
      listener([...this.buf]);
    } catch {}
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): CallDebugEvent[] {
    return [...this.buf];
  }
}

export const callDebug = new CallDebugBuffer();

/** React hook to subscribe to the in-memory buffer. */
export function useCallDebugLog(): CallDebugEvent[] {
  const [events, setEvents] = useState<CallDebugEvent[]>(() => callDebug.snapshot());
  useEffect(() => callDebug.subscribe(setEvents), []);
  return events;
}
