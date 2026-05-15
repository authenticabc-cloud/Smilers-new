import React from 'react';
import ComingSoonScreen from '../src/components/ComingSoonScreen';

export default function HelpScreen() {
  return (
    <ComingSoonScreen
      testID="help-screen"
      title="Help & Support"
      icon="help-circle-outline"
      tagline="We're here for you"
      description="Browse FAQs, troubleshoot common issues, or contact our support team directly."
      bullets={[
        'Searchable help center & FAQs',
        'Email support@smilers.online',
        'Report a bug or request a feature',
        'View app version and diagnostics',
      ]}
    />
  );
}
