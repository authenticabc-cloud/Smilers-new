/**
 * IS_EXPO_GO — true when this JS is running inside the Expo Go sandbox app.
 *
 * Expo Go ships a FIXED set of native modules, so every custom one this app
 * depends on (Stream Video, Twilio Video, Notifee, CallKeep,
 * expo-speech-recognition, react-native-webrtc) is simply absent. A top-level
 * `import` of such a package throws during MODULE EVALUATION, which takes down
 * whatever imported it — and when that importer is reachable from the root
 * layout, it takes the whole app down with it.
 *
 * Use this flag to skip those imports and degrade to a no-op instead.
 * In a real dev/prod build it is always false, so guarded paths behave
 * exactly as they did before.
 */
import Constants from 'expo-constants';

export const IS_EXPO_GO =
  Constants.appOwnership === 'expo' ||
  Constants.executionEnvironment === 'storeClient';
