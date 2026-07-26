// MUST be first — registers the background notification task handler and
// Notifee call event handlers at module scope so they run in ALL contexts,
// including the headless JS process that Expo spawns when a FCM data message
// arrives while the app is killed (React components do not mount in that
// context, so anything registered only inside a hook would never execute).
import './src/push/backgroundTaskSetup';

// Task 4 — register the Stream iOS CallKit/VoIP push config BEFORE the app
// component registers, so incoming Stream calls ring via native CallKit even
// when the app is killed. No-op on Android/web (guarded internally).
import { setupStreamIosPush } from './src/push/streamIosPushConfig';
setupStreamIosPush();

// Hand off to Expo Router for the normal app launch.
require('expo-router/entry');
