import { useEffect, useState } from 'react';

export type PushRegistrationStatus =
  | 'idle'
  | 'waiting-auth'
  | 'requesting-permission'
  | 'acquiring-device-token'
  | 'acquiring-expo-token'
  | 'registering-backend'
  | 'registered'
  | 'retry-scheduled'
  | 'unregistered'
  | 'error';

export interface PushDiagnosticsState {
  authSessionReady: boolean;
  convexAuthReady: boolean;
  convexAuthLoading: boolean;
  canRegisterWithBackend: boolean;
  retryAvailable: boolean;
  isPhysicalDevice: boolean | null;
  permissionStatus: string;
  projectId: string;
  expoPushToken: string;
  registrationStatus: PushRegistrationStatus;
  lastError: string;
  lastUpdatedAt: string;
  lastRegisteredAt: string;
  lastUnregisteredAt: string;
}

const defaultState: PushDiagnosticsState = {
  authSessionReady: false,
  convexAuthReady: false,
  convexAuthLoading: true,
  canRegisterWithBackend: false,
  retryAvailable: false,
  isPhysicalDevice: null,
  permissionStatus: 'unknown',
  projectId: '',
  expoPushToken: '',
  registrationStatus: 'idle',
  lastError: '',
  lastUpdatedAt: '',
  lastRegisteredAt: '',
  lastUnregisteredAt: '',
};

let pushDiagnosticsState: PushDiagnosticsState = defaultState;
let retryHandler: null | (() => Promise<void>) = null;
const listeners = new Set<(state: PushDiagnosticsState) => void>();

function emit() {
  listeners.forEach((listener) => listener(pushDiagnosticsState));
}

export function setPushDiagnostics(partial: Partial<PushDiagnosticsState>) {
  pushDiagnosticsState = {
    ...pushDiagnosticsState,
    ...partial,
    lastUpdatedAt: new Date().toISOString(),
  };
  emit();
}

export function usePushDiagnostics() {
  const [state, setState] = useState(pushDiagnosticsState);

  useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);

  return state;
}

export function getPushDiagnosticsState() {
  return pushDiagnosticsState;
}

export function setPushDiagnosticsRetryHandler(handler: null | (() => Promise<void>)) {
  retryHandler = handler;
  setPushDiagnostics({ retryAvailable: !!handler });
}

export async function requestPushDiagnosticsRetry() {
  if (!retryHandler) {
    throw new Error('Push registration is not ready to retry yet.');
  }
  await retryHandler();
}