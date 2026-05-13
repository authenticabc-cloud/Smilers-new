import React from 'react';
import ComingSoon from '../src/components/ComingSoon';

export default function AppLockScreen() {
  return (
    <ComingSoon
      title="App Lock"
      description="Protect Smilers with a PIN code or your device's biometric unlock. Arriving in a future update."
      icon="lock-closed-outline"
    />
  );
}