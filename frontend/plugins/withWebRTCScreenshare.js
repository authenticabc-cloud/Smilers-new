/**
 * withWebRTCScreenshare — enable react-native-webrtc's MediaProjection
 * foreground service so SCREEN SHARING actually produces frames on the remote.
 *
 * THE BUG IT FIXES
 * ----------------
 * react-native-webrtc only starts its `mediaProjection` foreground service
 * (MediaProjectionService) when `WebRTCModuleOptions.enableMediaProjectionService`
 * is `true`. That flag is a plain Java boolean with NO initializer, so it
 * defaults to `false`, and neither `@config-plugins/react-native-webrtc` nor
 * the generated MainApplication ever sets it.
 *
 * On Android 14+ (the user is on Android 16) the OS REQUIRES an active
 * `mediaProjection`-typed foreground service for screen capture. Without it the
 * capturer still "runs" but emits BLACK frames to the remote peer — which is
 * exactly the reported symptom: a normal camera call renders fine (640×480, no
 * MediaProjection needed) while a shared screen shows up black on the receiver.
 *
 * THE FIX
 * -------
 * Inject `WebRTCModuleOptions.getInstance().enableMediaProjectionService = true`
 * into MainApplication.onCreate() at prebuild. The service + permission
 * (FOREGROUND_SERVICE_MEDIA_PROJECTION) and the service declaration
 * (foregroundServiceType="mediaProjection") already ship with the library, so
 * flipping this flag is all that's required.
 *
 * Idempotent: skips if the flag is already set.
 */
const { withMainApplication } = require('@expo/config-plugins');

const MARKER = 'enableMediaProjectionService';

function withWebRTCScreenshare(config) {
  return withMainApplication(config, (config) => {
    let src = config.modResults.contents;
    if (src.includes(MARKER)) return config; // already applied

    const isKotlin = config.modResults.language === 'kt';

    const ktSnippet =
      '\n    // withWebRTCScreenshare: start the mediaProjection foreground' +
      '\n    // service so screen-share frames are not black on Android 14+.' +
      '\n    com.oney.WebRTCModule.WebRTCModuleOptions.getInstance().enableMediaProjectionService = true';

    const javaSnippet =
      '\n    // withWebRTCScreenshare: start the mediaProjection foreground' +
      '\n    // service so screen-share frames are not black on Android 14+.' +
      '\n    com.oney.WebRTCModule.WebRTCModuleOptions.getInstance().enableMediaProjectionService = true;';

    const re = isKotlin ? /(super\.onCreate\([^)]*\))/ : /(super\.onCreate\([^)]*\);)/;
    if (re.test(src)) {
      src = src.replace(re, `$1${isKotlin ? ktSnippet : javaSnippet}`);
      config.modResults.contents = src;
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        '[withWebRTCScreenshare] could not find super.onCreate() in MainApplication — ' +
          'enableMediaProjectionService NOT set; screen share may stay black on Android 14+.',
      );
    }
    return config;
  });
}

module.exports = withWebRTCScreenshare;
