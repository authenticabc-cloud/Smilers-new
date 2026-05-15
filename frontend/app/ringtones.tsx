import React from 'react';
import ComingSoonScreen from '../src/components/ComingSoonScreen';

export default function RingtonesScreen() {
  return (
    <ComingSoonScreen
      testID="ringtones-screen"
      title="Ringtones"
      icon="musical-notes-outline"
      tagline="Sound the way you want"
      description="Choose your incoming call ringtone and notification sounds."
      bullets={[
        'Default and custom ringtones',
        'Per-contact ringtone overrides',
        'Silent and vibrate-only modes',
      ]}
    />
  );
}
