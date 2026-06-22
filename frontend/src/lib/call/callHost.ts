/**
 * callHost — a tiny module-level store that lets the live WebRTC call screen
 * be rendered ONCE at the app root (see src/components/call/CallHost.tsx)
 * instead of inside the `/call/[conversationId]` route.
 *
 * Why: keeping the call as a route meant navigating anywhere unmounted the
 * `CallSession` and dropped the call. By hoisting the call UI to the root and
 * driving it from this store, the user can MINIMIZE the call into a small
 * draggable window and keep browsing Smilers while the peer connection stays
 * alive (the call subtree is never unmounted — only resized).
 *
 * The `/call/[conversationId]` route becomes a thin shim that forwards its
 * params here and pops itself, so every existing entry point (push wake,
 * startCall, deep links) keeps working unchanged.
 */
import { useSyncExternalStore } from 'react';

export type CallHostParams = Record<string, string | undefined>;
export type CallHostMode = 'full' | 'mini';

export interface CallHostState {
  params: CallHostParams | null;
  mode: CallHostMode;
}

let state: CallHostState = { params: null, mode: 'full' };
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function setState(next: CallHostState) {
  state = next;
  emit();
}

export const callHost = {
  /** Begin (or switch to) a call with the given route params; shown full-screen. */
  start(params: CallHostParams) {
    setState({ params: { ...params }, mode: 'full' });
  },
  /** Tear down the call overlay completely. */
  end() {
    if (!state.params && state.mode === 'full') return;
    setState({ params: null, mode: 'full' });
  },
  /** Shrink the active call into the floating mini window. */
  minimize() {
    if (!state.params || state.mode === 'mini') return;
    setState({ params: state.params, mode: 'mini' });
  },
  /** Restore the active call back to full-screen. */
  maximize() {
    if (!state.params || state.mode === 'full') return;
    setState({ params: state.params, mode: 'full' });
  },
  isActive() {
    return state.params !== null;
  },
  getState(): CallHostState {
    return state;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** React hook — re-renders on any call host change. */
export function useCallHost(): CallHostState {
  return useSyncExternalStore(callHost.subscribe, callHost.getState, callHost.getState);
}
