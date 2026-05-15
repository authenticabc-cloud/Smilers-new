import React from 'react';
import ComingSoonScreen from '../src/components/ComingSoonScreen';

export default function BackupScreen() {
  return (
    <ComingSoonScreen
      testID="backup-screen"
      title="Backup & Storage"
      icon="server-outline"
      tagline="Keep your chats safe"
      description="Configure end-to-end encrypted backups and manage local storage used by Smilers."
      bullets={[
        'Daily, weekly, or monthly auto backup',
        'Encrypted cloud backup with your passphrase',
        'Manage local cache and media storage',
        'Restore on a new device',
      ]}
    />
  );
}
