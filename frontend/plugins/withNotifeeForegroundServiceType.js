/**
 * withNotifeeForegroundServiceType
 *
 * CRASH FIX (voice-note playback): the bundled Notifee core AAR declares its
 * foreground service with ONLY `android:foregroundServiceType="shortService"`:
 *
 *   <service android:name="app.notifee.core.ForegroundService"
 *            android:foregroundServiceType="shortService" />
 *
 * Our playback code starts that service at runtime with the MEDIA_PLAYBACK
 * type (see src/lib/audio/playbackNotification.ts). On Android 14+ (API 34),
 * starting a foreground service with a type that is NOT declared in the
 * merged manifest throws `MissingForegroundServiceTypeException` on the main
 * thread — an uncatchable NATIVE crash. That is exactly what happens the
 * instant the user taps play on a voice note.
 *
 * This plugin injects a manifest `<service>` override for Notifee's
 * ForegroundService that declares `mediaPlayback` and uses
 * `tools:replace="android:foregroundServiceType"` so the manifest merger
 * replaces the AAR's `shortService`-only value instead of erroring on the
 * conflict.
 */
const { withAndroidManifest, AndroidConfig } = require('@expo/config-plugins');

const SERVICE_NAME = 'app.notifee.core.ForegroundService';
// Declared types the notifee foreground service is allowed to run as:
//  - mediaPlayback: voice-note / translated-audio playback
//  - microphone + location: emergency SOS capture (keeps live audio + GPS
//    broadcasting when the app is backgrounded or the screen is locked).
// Android allows combining these with `|` (only `shortService` may not be
// combined). A runtime foreground service must request a SUBSET of the types
// declared here, otherwise Android 14+ throws the uncatchable
// MissingForegroundServiceTypeException — so this list must cover every type
// any runtime FGS requests.
const FGS_TYPE = 'mediaPlayback|microphone|location';

module.exports = function withNotifeeForegroundServiceType(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;

    // Ensure the tools namespace is present so tools:replace resolves.
    manifest.$ = manifest.$ || {};
    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    application.service = application.service || [];

    let service = application.service.find(
      (s) => s.$ && s.$['android:name'] === SERVICE_NAME,
    );
    if (!service) {
      service = { $: { 'android:name': SERVICE_NAME } };
      application.service.push(service);
    }

    service.$['android:foregroundServiceType'] = FGS_TYPE;
    service.$['android:exported'] = 'false';
    service.$['tools:replace'] = 'android:foregroundServiceType';

    return mod;
  });
};
