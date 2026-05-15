import React from 'react';
import ComingSoonScreen from '../src/components/ComingSoonScreen';

export default function LanguagesScreen() {
  return (
    <ComingSoonScreen
      testID="languages-screen"
      title="Languages"
      icon="globe-outline"
      tagline="Pick languages you understand"
      description="Tell Smilers which languages you already understand so we can skip translation for them."
      bullets={[
        'Add multiple primary languages',
        'Translate everything else automatically',
        'Preserve original messages when needed',
      ]}
    />
  );
}
