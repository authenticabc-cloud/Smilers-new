export interface FaqItem {
  q: string;
  a: string;
  category: string;
}

export const FAQ_CATEGORIES = [
  'Getting started',
  'Account & security',
  'Messaging & calls',
  'Privacy & blocking',
  'Earnings & ads',
  'Trustees & emergency',
  'Troubleshooting',
] as const;

export type FaqCategory = (typeof FAQ_CATEGORIES)[number];

export const FAQS: FaqItem[] = [
  // Getting started
  {
    category: 'Getting started',
    q: 'How do I sign in to Smilers?',
    a: 'Tap Sign in on the welcome screen, complete the secure browser sign-in, and verify your phone number with the code we send by SMS. You only need to do this once per device.',
  },
  {
    category: 'Getting started',
    q: 'Why do I need to verify my phone number?',
    a: 'Phone verification confirms you are a real person, protects your account from spam, and powers features like contact discovery, SOS alerts, and ringtone customization.',
  },
  {
    category: 'Getting started',
    q: 'Can I use Smilers on multiple devices?',
    a: 'Yes. Sign in with the same account on each device and verify your phone number on the new device. Your chats sync end-to-end encrypted across devices.',
  },

  // Account & security
  {
    category: 'Account & security',
    q: 'How do I sign out?',
    a: 'Open Settings → Account → Sign out. You will need to sign in and verify your phone number again to use Smilers on this device.',
  },
  {
    category: 'Account & security',
    q: 'How do I delete my account?',
    a: 'Open Settings → Account → Delete account. Type DELETE to confirm. This permanently removes your account, messages, contacts, ad credits, and earnings.',
  },
  {
    category: 'Account & security',
    q: 'How do I enable App Lock?',
    a: 'Open Settings → App Lock. Set a PIN and optionally enable biometric unlock (Face ID, Touch ID, or fingerprint).',
  },

  // Messaging & calls
  {
    category: 'Messaging & calls',
    q: 'Are my messages end-to-end encrypted?',
    a: 'Yes. All one-to-one and group messages, calls, and media are protected with AES-256-GCM encryption. Smilers can never read them.',
  },
  {
    category: 'Messaging & calls',
    q: 'How do scheduled messages work?',
    a: 'In any chat, long-press the send button to schedule a message for later. Manage your scheduled messages from Settings → Scheduled Messages.',
  },
  {
    category: 'Messaging & calls',
    q: 'What is Chat-Once?',
    a: 'Chat-Once messages disappear after the recipient reads them. Tap the orange flame icon when composing to send a Chat-Once message.',
  },

  // Privacy & blocking
  {
    category: 'Privacy & blocking',
    q: 'How do I block someone?',
    a: 'Open the chat or contact, tap the user’s name, then tap Block. They will no longer be able to message or call you. Manage blocked users from Settings → Blocked Users.',
  },
  {
    category: 'Privacy & blocking',
    q: 'Who can see when I was last seen?',
    a: 'Go to Settings → Privacy → Last seen and choose Everyone, My contacts, or Nobody.',
  },

  // Earnings & ads
  {
    category: 'Earnings & ads',
    q: 'How do I earn on Smilers?',
    a: 'You earn points for engagement: messaging, calling, sharing status updates, and inviting friends. Convert points to a withdrawal from the Earnings screen.',
  },
  {
    category: 'Earnings & ads',
    q: 'How do ad credits work?',
    a: 'Buy ad credits or redeem a code from Ads → Redeem Code. Credits are deducted only when someone actually clicks your ad.',
  },
  {
    category: 'Earnings & ads',
    q: 'When does my ad become visible to users?',
    a: 'New ads enter a moderation queue. Approved ads typically go live within 24 hours and start showing to users in your targeted countries.',
  },

  // Trustees & emergency
  {
    category: 'Trustees & emergency',
    q: 'What are trustees?',
    a: 'Trustees are up to 5 trusted contacts who are notified immediately when you trigger an SOS. They receive your last known location.',
  },
  {
    category: 'Trustees & emergency',
    q: 'How do I trigger an SOS?',
    a: 'Open Settings → Emergency and tap the big red SOS button, or use the SOS shortcut from your Profile tab.',
  },

  // Troubleshooting
  {
    category: 'Troubleshooting',
    q: 'I am not receiving the verification code',
    a: 'Wait 60 seconds and tap Resend. Make sure your phone has signal and the country code is correct. If it still fails, contact support below.',
  },
  {
    category: 'Troubleshooting',
    q: 'Notifications are not working',
    a: 'Go to Settings → Notifications and make sure notifications are enabled. Also check your device system settings to confirm Smilers has notification permission.',
  },
  {
    category: 'Troubleshooting',
    q: 'The app feels slow or shows old data',
    a: 'Open Settings → Backup & Storage and tap Clear cache. This safely removes thumbnails and previews without touching your messages.',
  },
];
