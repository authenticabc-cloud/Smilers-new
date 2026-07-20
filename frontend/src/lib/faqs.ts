import { Platform } from 'react-native';

export interface FaqItem {
  q: string;
  a: string;
  category: string;
}

const IOS_PREMIUM_PURCHASE_DISABLED = Platform.OS === 'ios';

export const FAQ_CATEGORIES = [
  'Getting started',
  'Account & security',
  'Messaging & calls',
  'Privacy & blocking',
  'Premium & payments',
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
  {
    category: 'Messaging & calls',
    q: 'Can I add more people to an ongoing call?',
    a: 'Yes. During a 1-to-1 voice or video call, tap “Add” and choose contacts to invite. The call seamlessly becomes a group (conference) call without dropping — no need to hang up and start over.',
  },
  {
    category: 'Messaging & calls',
    q: 'What happens if someone calls me while I’m already on a call?',
    a: 'Smilers supports call waiting. You’ll see the incoming call and can hold your current call to switch, or decline it. Your first call stays connected while you decide.',
  },
  {
    category: 'Messaging & calls',
    q: 'How do I pin an important message in a group?',
    a: 'Group admins can long-press a message and tap Pin. Pinned messages show as a banner at the top of the chat — tap it to jump straight to the message. Long-press the pin again to unpin.',
  },
  {
    category: 'Messaging & calls',
    q: 'Who can edit posts in a group?',
    a: 'Group admins control edit permissions. Members can suggest an edit to a group post, and an admin approves or rejects it. When an edit is approved, everyone sees a small “suggested edit was approved” notice in the chat.',
  },
  {
    category: 'Messaging & calls',
    q: 'Why do some group messages show a name above them?',
    a: 'In group chats, the sender’s name appears above their message so you always know who said what. Smilers shows the name you saved in your contacts first, then their Smilers name.',
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

  // Premium & payments
  {
    category: 'Premium & payments',
    q: 'What is Smilers Premium and what does it cost?',
    a: IOS_PREMIUM_PURCHASE_DISABLED
      ? 'Premium unlocks the full Smilers experience, including Emergency features, Voice Tasks, Chat Once, and Face Verification. If you already have Premium, it stays active on this device.'
      : 'Premium unlocks the full Smilers experience. Plans are Monthly (€3), 6 Months (€15), and Yearly (€24). Open the Premium screen to compare plans and subscribe.',
  },
  {
    category: 'Premium & payments',
    q: 'How do I pay for Premium with Mobile Money?',
    a: IOS_PREMIUM_PURCHASE_DISABLED
      ? 'Premium purchases aren’t available in the iOS app right now. If you already have Premium, it stays active on this device.'
      : 'On the Premium screen, pick a plan and tap “Pay with Mobile Money”. Choose your country, optionally add the phone number you’ll pay from, and send the request. An admin messages you the mobile money number to pay. Once they confirm your payment, your Premium plan is activated automatically.',
  },
  {
    category: 'Premium & payments',
    q: 'Can I buy ad clicks with Mobile Money?',
    a: 'Yes. In Ads → My Ads, tap “Buy clicks” on your ad, choose how many clicks, then tap “Pay with Mobile Money”. Pick your country, review the estimated total, and send the request. An admin sends you the number to pay and, once confirmed, the clicks are credited to your ad automatically. Ad clicks are €0.04 each.',
  },
  {
    category: 'Premium & payments',
    q: 'How long does a Mobile Money payment take to confirm?',
    a: 'An admin reviews and confirms manually, usually within a few hours. You’ll get a message with the number to pay. Your Premium plan or ad clicks are applied automatically the moment the admin marks the payment as complete — no need to re-enter anything.',
  },
  {
    category: 'Premium & payments',
    q: 'Where can I track my Mobile Money requests?',
    a: IOS_PREMIUM_PURCHASE_DISABLED
      ? 'For ad clicks, open Ads → My Ads and check the “Mobile Money top-ups” card, which shows each request as Pending, Credited, or Declined.'
      : 'For Premium, open the Premium screen and tap “Your requests”. For ad clicks, open Ads → My Ads and check the “Mobile Money top-ups” card, which shows each request as Pending, Credited, or Declined.',
  },
  {
    category: 'Premium & payments',
    q: 'The amount is shown as “≈”. Why?',
    a: 'The local-currency figure before you submit is an estimate based on the current exchange rate. The exact amount is confirmed when your request is created, and the admin will always tell you the precise amount to send.',
  },
  {
    category: 'Premium & payments',
    q: 'Which countries and currencies are supported for Mobile Money?',
    a: 'Mobile Money is available across many African markets including Kenya (KES), Ghana (GHS), Uganda (UGX), Tanzania (TZS), Rwanda (RWF), Zambia (ZMW), South Africa (ZAR), Nigeria (NGN), Cameroon/Gabon (XAF), Côte d’Ivoire/Senegal/Burkina Faso/Mali/Benin/Togo (XOF), and Malawi (MWK). Pick your country in the payment screen.',
  },
  {
    category: 'Premium & payments',
    q: 'Can I still pay by card instead of Mobile Money?',
    a: IOS_PREMIUM_PURCHASE_DISABLED
      ? 'Card checkout is available for buying ad clicks. Premium purchases aren’t available in the iOS app right now.'
      : 'Yes. Card checkout is still available for both Premium and buying ad clicks — just use the main Pay button instead of “Pay with Mobile Money”.',
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
    a: 'Buy ad credits, redeem a code from Ads → Redeem Code, or top up with Mobile Money from your ad’s “Buy clicks” screen. Credits are deducted only when someone actually clicks your ad.',
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
