/**
 * withCallWakeScreen — iter-202 Expo config plugin.
 *
 * Notifee's `fullScreenAction: { id: 'default' }` is *necessary* but not
 * *sufficient* to wake the device on an incoming call when the screen
 * is off / locked. The Android system only wakes the screen if the
 * Activity it launches declares BOTH:
 *   • android:showWhenLocked  = "true"
 *   • android:turnScreenOn    = "true"
 *
 * Managed Expo apps (no native /android folder) need a config plugin
 * to inject these attributes into `MainActivity` at prebuild time.
 *
 * Also adds:
 *   • USE_FULL_SCREEN_INTENT permission (already declared via app.json
 *     permissions but we belt-and-brace here in case it's stripped).
 *   • android:turnScreenOn for the root activity → Notifee + CallKeep
 *     can wake the device from doze/screen-off when category=CALL.
 *
 * This is what was missing — the user reports "rings but screen doesn't
 * light up" which is the exact symptom of MainActivity NOT having the
 * wake/lock flags.
 */
const {
  withAndroidManifest,
  withMainActivity,
  AndroidConfig,
} = require('@expo/config-plugins');

function withCallWakeManifest(config) {
  return withAndroidManifest(config, async (config) => {
    const manifest = config.modResults;
    const application =
      manifest?.manifest?.application && manifest.manifest.application[0];
    if (!application) return config;

    // Find MainActivity — most managed Expo projects name it ".MainActivity"
    // or "<package>.MainActivity".
    const activities = application.activity || [];
    const mainActivity = activities.find((a) => {
      const name = a.$ && a.$['android:name'];
      return (
        name === '.MainActivity' ||
        (typeof name === 'string' && name.endsWith('.MainActivity'))
      );
    });
    if (!mainActivity) return config;

    mainActivity.$ = mainActivity.$ || {};
    // Critical attributes — these are what tells Android "yes, please
    // wake the screen and show me over the keyguard when the full-screen
    // intent fires".
    mainActivity.$['android:showWhenLocked'] = 'true';
    mainActivity.$['android:turnScreenOn'] = 'true';
    // Helpful for cold-start launching from a notification: keep the
    // activity visible above other lockscreens.
    mainActivity.$['android:resizeableActivity'] = 'true';

    // Ensure the USE_FULL_SCREEN_INTENT permission is present even if
    // someone removes it from app.json by accident.
    AndroidConfig.Permissions.addPermission(
      manifest,
      'android.permission.USE_FULL_SCREEN_INTENT'
    );

    return config;
  });
}

/**
 * Inject programmatic wake + keyguard dismissal into MainActivity.onCreate so
 * that when the user taps "Answer" on the lock screen the call screen comes up
 * WITHOUT a second unlock. The manifest attributes (showWhenLocked/turnScreenOn)
 * show the activity over the keyguard and turn the screen on; this additionally
 * calls KeyguardManager.requestDismissKeyguard so input/interaction is allowed
 * immediately. Idempotent and safe: if the onCreate signature can't be found
 * the source is left untouched (manifest attributes still apply).
 */
function withCallWakeKeyguard(config) {
  return withMainActivity(config, (config) => {
    const isKotlin = config.modResults.language === 'kt';
    let src = config.modResults.contents;
    if (src.includes('requestDismissKeyguard')) return config; // already applied

    if (isKotlin) {
      const snippet =
        '\n    // withCallWakeScreen: wake the screen + dismiss the keyguard so' +
        '\n    // answering an incoming call from the lock screen jumps straight' +
        '\n    // into the call (no second unlock). API 27+ only.' +
        '\n    if (android.os.Build.VERSION.SDK_INT >= 27) {' +
        '\n      setShowWhenLocked(true)' +
        '\n      setTurnScreenOn(true)' +
        '\n      val keyguardManager = getSystemService(android.content.Context.KEYGUARD_SERVICE) as android.app.KeyguardManager' +
        '\n      keyguardManager.requestDismissKeyguard(this, null)' +
        '\n    }';
      const re = /(super\.onCreate\([^)]*\))/;
      if (re.test(src)) src = src.replace(re, `$1${snippet}`);
    } else {
      const snippet =
        '\n    // withCallWakeScreen: wake + dismiss keyguard (API 27+).' +
        '\n    if (android.os.Build.VERSION.SDK_INT >= 27) {' +
        '\n      setShowWhenLocked(true);' +
        '\n      setTurnScreenOn(true);' +
        '\n      android.app.KeyguardManager keyguardManager = (android.app.KeyguardManager) getSystemService(android.content.Context.KEYGUARD_SERVICE);' +
        '\n      keyguardManager.requestDismissKeyguard(this, null);' +
        '\n    }';
      const re = /(super\.onCreate\([^)]*\);)/;
      if (re.test(src)) src = src.replace(re, `$1${snippet}`);
    }

    config.modResults.contents = src;
    return config;
  });
}

function withCallWakeScreen(config) {
  config = withCallWakeManifest(config);
  config = withCallWakeKeyguard(config);
  return config;
}

module.exports = withCallWakeScreen;
