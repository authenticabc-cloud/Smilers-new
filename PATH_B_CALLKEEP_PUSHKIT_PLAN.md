# Path B Plan — WhatsApp-grade Incoming Call UX via Manual EAS Build

> **Why this doc exists**: Emergent-managed push (now in production, iter-127) delivers messages/mentions/missed-call notifications reliably via a standard system-tray banner. But it **cannot** deliver a WhatsApp-grade ringing-call UX — that requires VoIP-specific OS APIs (iOS PushKit + CallKit, Android high-priority FCM + full-screen intent + CallKeep) which are **not exposed** by Emergent's relay. This document is the implementation plan for adding that ringing UX as a separate manual EAS build, while keeping everything else on Emergent push.
>
> **When to do this**: AFTER you've verified message + missed-call notifications are working end-to-end via Emergent push, AND you decide the call ringing UX is critical enough to justify manual EAS builds going forward.

---

## High-level architecture

Two parallel push channels co-existing in the same APK:

```
┌─────────────────────────────────────────────────────────┐
│ MESSAGES / MENTIONS / MISSED CALLS                      │
│   Convex → FastAPI /api/send-push-internal              │
│         → Emergent relay → FCM/APNs notification        │
│         → Android: heads-up banner                      │
│         → iOS: banner + alert                           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ INCOMING CALL RINGING (NEW)                             │
│   Convex → direct FCM v1 data-message (Android)         │
│         → Firebase Admin SDK with project aff3eee0-...  │
│         → Android receives via custom HeadlessJS task   │
│         → CallKeep displays full-screen ringing UI       │
│                                                          │
│   Convex → APNs VoIP push (iOS)                         │
│         → PushKit                                        │
│         → CallKit displays native incoming-call screen   │
└─────────────────────────────────────────────────────────┘
```

Key: the call channel **bypasses Emergent entirely** and uses your own FCM project (`aff3eee0-0f42-475a-bd4c-a6d39d9b2f7b`) plus your own APNs auth key. This requires:
- Manual EAS builds from your local machine (Emergent's pipeline rewrites the projectId)
- Native module installs (CallKeep) that don't work in Expo Go
- iOS APNs VoIP push certificate (separate from regular APNs)

---

## Mobile-side libraries to add

```bash
yarn add react-native-callkeep
yarn add @notifee/react-native      # Android full-screen-intent helper
yarn add react-native-voip-push-notification  # iOS PushKit (peer dep of CallKeep)
```

**`react-native-callkeep`** — exposes the native incoming-call screen on both platforms (Android = a foreground service + full-screen intent; iOS = CallKit).

**`@notifee/react-native`** — required on Android to wire the FCM data-message to a full-screen intent that wakes the device. Without it the data-message arrives silently in the background.

**`react-native-voip-push-notification`** — iOS PushKit listener; required for VoIP push to be routed to CallKeep.

---

## Mobile-side code outline

### 1. Native config (`app.json`)

```jsonc
{
  "expo": {
    "ios": {
      "infoPlist": {
        "UIBackgroundModes": ["voip", "audio", "remote-notification"]
      },
      "entitlements": {
        "com.apple.developer.pushkit.unrestricted-voip": true
      }
    },
    "plugins": [
      // existing plugins…
      ["react-native-callkeep", {
        "appName": "Smilers",
        "imageName": "ic_launcher_round",
        "supportsVideo": true
      }]
    ]
  }
}
```

### 2. Register CallKeep early (`app/_layout.tsx`)

```tsx
import RNCallKeep from 'react-native-callkeep';

if (Platform.OS !== 'web') {
  RNCallKeep.setup({
    ios: {
      appName: 'Smilers',
      includesCallsInRecents: true,
      supportsVideo: true,
    },
    android: {
      alertTitle: 'Permission required',
      alertDescription: 'Smilers needs to manage your calls so we can show incoming-call screens.',
      cancelButton: 'Cancel',
      okButton: 'Allow',
      foregroundService: {
        channelId: 'com.smilers.app.calls',
        channelName: 'Incoming calls',
        notificationTitle: 'Smilers is running',
      },
    },
  });
  RNCallKeep.setAvailable(true);
}
```

### 3. Listen for VoIP push (iOS) — `src/push/voipPush.ts`

```ts
import VoipPushNotification from 'react-native-voip-push-notification';
import RNCallKeep from 'react-native-callkeep';

VoipPushNotification.addEventListener('register', (token) => {
  // Forward VoIP token to backend separately from regular push token
  fetch(`${BACKEND_URL}/api/register-voip-push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id, voip_token: token }),
  });
});

VoipPushNotification.addEventListener('notification', (notification) => {
  // VoIP push payload from your server. Show CallKit UI.
  const { uuid, callerName, callerId, callType } = notification;
  RNCallKeep.displayIncomingCall(uuid, callerId, callerName, 'generic', callType === 'video');
});

VoipPushNotification.registerVoipToken();
```

### 4. Listen for data-message (Android) — needs `expo-build-properties` + custom Firebase service

On Android, FCM data-messages with `priority: high` and `content-available: 1` get delivered to a `HeadlessJsTaskService`. Use `@notifee/react-native` to launch a full-screen intent:

```ts
import notifee, { AndroidImportance, AndroidVisibility } from '@notifee/react-native';
import RNCallKeep from 'react-native-callkeep';
import messaging from '@react-native-firebase/messaging';

messaging().setBackgroundMessageHandler(async (remoteMessage) => {
  const { type, callId, callerName, callerId } = remoteMessage.data ?? {};
  if (type !== 'incoming-call') return;

  RNCallKeep.displayIncomingCall(callId, callerId, callerName, 'generic', false);

  await notifee.displayNotification({
    title: 'Incoming call',
    body: `${callerName} is calling…`,
    android: {
      channelId: 'com.smilers.app.calls',
      importance: AndroidImportance.HIGH,
      visibility: AndroidVisibility.PUBLIC,
      fullScreenAction: { id: 'default' },
      pressAction: { id: 'default' },
      ongoing: true,
      category: 'call',
    },
  });
});
```

### 5. Hook CallKeep events → join WebRTC call

```ts
RNCallKeep.addEventListener('answerCall', ({ callUUID }) => {
  // Navigate into the WebRTC call screen
  router.push(`/call/${callUUID}`);
});

RNCallKeep.addEventListener('endCall', ({ callUUID }) => {
  // Tell Convex the call was declined / hung up
  declineCall({ callId: callUUID });
});
```

---

## Backend-side changes

### 1. Convex: store VoIP tokens separately from regular tokens

New table: `voipTokens { userId, token, platform, createdAt }`.

New mutation: `api.calls.registerVoipToken({ token, platform })`.

### 2. Convex: when an incoming call is initiated

Instead of calling `/api/send-push-internal`, fire two parallel pushes:

- **iOS recipients**: POST to APNs directly via `apns2` library with topic = `<bundleId>.voip` and headers `apns-push-type: voip`.
- **Android recipients**: POST to FCM v1 via Firebase Admin SDK using the user's service account JSON for project `aff3eee0-...`. Payload must be `data: {type: "incoming-call", callId, callerName, callerId}` with `android: { priority: "high" }`.

```ts
// Convex action (Android side)
const adminMessaging = getAdminMessaging(); // uses Firebase Admin SDK
await adminMessaging.send({
  token: voipToken,
  data: {
    type: 'incoming-call',
    callId,
    callerName,
    callerId,
  },
  android: {
    priority: 'high',
    directBootOk: true,
  },
});
```

You'll need the **service account JSON** for project `aff3eee0-...` uploaded as a Convex secret.

### 3. iOS APNs VoIP cert

You'll need to:
1. Go to https://developer.apple.com → Certificates → create an **Apple Push Notification service SSL** certificate with the **VoIP Services** option checked
2. Convert to `.p8` token-based auth (Apple's preferred path)
3. Upload the `.p8` + key ID + team ID to your Convex secrets
4. Use `node-apn` or `@parse/node-apn` to send the VoIP push

---

## Build & install steps

### One-time setup

```bash
# Sign in to your own Expo account
npm install -g eas-cli
eas login          # sign in as abcsimplesend

# Verify
eas whoami         # should print: abcsimplesend
```

### Each release

```bash
git pull
cd frontend
yarn install
eas build --platform android --profile production
# Wait ~15 min, download APK from the link EAS prints
# Install on phone manually (uninstall the old Emergent build first)

# For iOS:
eas build --platform ios --profile production
# Same flow — install IPA via TestFlight or direct provisioning
```

### Important: project ID lock

To prevent the EAS CLI from auto-rewriting `extra.eas.projectId`, set it explicitly in `eas.json`:

```json
{
  "build": {
    "production": {
      "autoIncrement": true,
      "extra": {
        "expo": {
          "extra": {
            "eas": {
              "projectId": "aff3eee0-0f42-475a-bd4c-a6d39d9b2f7b"
            }
          }
        }
      }
    }
  }
}
```

---

## Estimated effort

| Task | Hours |
|---|---|
| Add libraries + native config | 2 |
| Wire CallKeep + voipPush + notifee handlers | 4 |
| Backend: voipTokens table + register mutation | 1 |
| Backend: Firebase Admin SDK setup + Android data push | 3 |
| Backend: APNs VoIP `.p8` setup + node-apn integration | 3 |
| iOS PushKit certificate provisioning + entitlement | 2 |
| Testing on real device (Android) | 2 |
| Testing on real device (iOS) | 2 |
| **Total** | **~19 hours** |

---

## Testing checklist

Before declaring ringing-call UX shipped:

- [ ] Cold-start incoming call on Android: phone is locked, app killed → full-screen ringing UI appears, ringtone loops, Accept/Decline buttons work
- [ ] Cold-start incoming call on iOS: same as above with CallKit
- [ ] Tap Accept → drops into `/call/<callId>` and the WebRTC connection establishes within 3s
- [ ] Tap Decline → caller sees "Call declined" within 2s
- [ ] Network blip during ring: call doesn't disappear (CallKit/CallKeep keeps ringing for ~30s)
- [ ] Battery saver / doze mode on Android: push still arrives in under 2s
- [ ] Killing the app process via swipe DOES still ring (foreground service keeps the FCM listener alive)
- [ ] Force-stopping the app DOES NOT ring (OS-level restriction, document for users)

---

## When NOT to do this

If your user base is small or you're early-stage, the Path A (banner) call notification may be Good Enough™ — users tap the banner and the call connects within a few seconds. Reserve Path B work for when:
- You have churn analytics showing missed calls are a top-3 user complaint
- You're competing directly with WhatsApp/Telegram and call-ringing parity is a marketing requirement
- You're ready to commit to manual EAS builds for every release going forward

— Smilers mobile agent (iter-127)
