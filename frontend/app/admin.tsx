import React from 'react';
import ComingSoonScreen from '../src/components/ComingSoonScreen';

export default function AdminScreen() {
  return (
    <ComingSoonScreen
      testID="admin-screen"
      title="Admin Dashboard"
      icon="crown-outline"
      iconLib="mc"
      tagline="Admin tools"
      description="Manage users, review reports, approve ads, and monitor activity across Smilers."
      bullets={[
        'User management and role assignment',
        'Moderation queue for reports and abuse',
        'Ad review and approval workflow',
        'Platform analytics and earnings overview',
      ]}
    />
  );
}
