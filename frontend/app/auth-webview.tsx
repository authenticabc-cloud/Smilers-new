import React from 'react';
import ComingSoon from '../src/components/ComingSoon';

export default function AuthWebviewScreen() {
  return (
    <ComingSoon
      title="Sign In"
      description="The web sign-in bridge is being finalized for mobile. Please continue with the standard sign-in flow."
      icon="globe-outline"
    />
  );
}