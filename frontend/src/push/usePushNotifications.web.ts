export function usePushNotifications() {
  // Web preview should not load native Expo notifications modules.
}

// iter-116: stub for the projectId mismatch describer so the
// Notifications screen renders cleanly in the web preview (the real
// implementation lives in the .ts native variant).
export function describePushProjectMismatch(): string {
  return '';
}
