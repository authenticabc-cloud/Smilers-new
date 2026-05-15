import React from 'react';
import ComingSoonScreen from '../src/components/ComingSoonScreen';

export default function VoiceTasksScreen() {
  return (
    <ComingSoonScreen
      testID="voice-tasks-screen"
      title="Voice Tasks"
      icon="mic-outline"
      tagline="Hands-free Smilers"
      description="Send messages, place calls, and trigger contacts using just your voice."
      bullets={[
        'Call or message a contact by name',
        'Dictate replies hands-free',
        'Set scheduled messages by voice',
      ]}
    />
  );
}
