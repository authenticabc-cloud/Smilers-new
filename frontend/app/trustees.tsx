import React from 'react';
import ComingSoonScreen from '../src/components/ComingSoonScreen';

export default function TrusteesScreen() {
  return (
    <ComingSoonScreen
      testID="trustees-screen"
      title="Trustees"
      icon="shield-checkmark-outline"
      tagline="Your circle of trust"
      description="Add up to 5 trusted contacts who can be alerted instantly in an emergency."
      bullets={[
        'Add up to 5 trusted contacts',
        'One-tap emergency alerts',
        'Share live location with trustees',
        'Trustees can recover your account',
      ]}
    />
  );
}
