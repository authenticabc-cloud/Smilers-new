/**
 * withNativeCallService — Expo config plugin
 *
 * Registers SmilersCallNotificationService as the sole FCM message handler
 * by removing Expo's ExpoFirebaseMessagingService from the merged manifest
 * and substituting our subclass. The subclass delegates non-call messages
 * back to Expo via super.onMessageReceived(), so all existing push
 * notification features continue to work.
 *
 * Also registers CallActionReceiver for Decline button handling.
 *
 * This plugin is idempotent — safe to run on every `expo prebuild`.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const EXPO_FCM_SERVICE = 'expo.modules.notifications.service.ExpoFirebaseMessagingService';
const SMILERS_FCM_SERVICE = 'com.smilers.app.SmilersCallNotificationService';
const CALL_ACTION_RECEIVER = 'com.smilers.app.CallActionReceiver';

function withNativeCallService(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const app = manifest.manifest.application[0];

    if (!app.service) app.service = [];

    // 1. Remove Expo's FCM service from the merged manifest
    if (!app.service.some((s) => s.$['android:name'] === EXPO_FCM_SERVICE)) {
      app.service.push({
        $: {
          'android:name': EXPO_FCM_SERVICE,
          'tools:node': 'remove',
        },
      });
    }

    // 2. Register SmilersCallNotificationService
    if (!app.service.some((s) => s.$['android:name'] === SMILERS_FCM_SERVICE)) {
      app.service.push({
        $: {
          'android:name': SMILERS_FCM_SERVICE,
          'android:exported': 'false',
          'android:directBootAware': 'true',
        },
        'intent-filter': [
          {
            action: [{ $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } }],
          },
        ],
      });
    }

    // 3. Register CallActionReceiver
    if (!app.receiver) app.receiver = [];
    if (!app.receiver.some((r) => r.$['android:name'] === CALL_ACTION_RECEIVER)) {
      app.receiver.push({
        $: {
          'android:name': CALL_ACTION_RECEIVER,
          'android:exported': 'false',
        },
      });
    }

    return config;
  });
}

module.exports = withNativeCallService;
