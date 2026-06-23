# Screen-Share — Verification & Debug Note (Android)

After the **fix**: a new local config plugin (`plugins/withWebRTCScreenshare.js`)
sets `WebRTCModuleOptions.enableMediaProjectionService = true`, which starts the
`mediaProjection` foreground service Android 14+ requires for screen capture.
Without it the capturer emits **black frames to the remote** (camera calls are
unaffected — they don't use MediaProjection). **This only takes effect in a
fresh build** (prebuild-time native change).

---

## 1. Verify the fix (happy path)
1. **Publish** → **Generate a new Android build** → install on the device.
2. Open the app once after install.
3. Start a screen share (whole screen or single app).
4. Expect on the **recipient**: your actual screen content (not black).
5. While sharing, the device should show an **ongoing "screen capture / media projection" notification** — that's the foreground service now running. If you DON'T see it, the service didn't start (see debugging below).

## 2. Confirm the plugin landed in the build (optional)
The injected line lives in `MainApplication`. If you ever inspect a prebuilt
project (`android/app/src/main/java/.../MainApplication.kt`), you should see:
```kotlin
super.onCreate()
// withWebRTCScreenshare: ...
com.oney.WebRTCModule.WebRTCModuleOptions.getInstance().enableMediaProjectionService = true
```

## 3. If the recipient STILL sees black — capture logcat
Plug the **sharer's** phone into a computer with Android platform-tools, then:

```bash
# clear, then watch only the relevant tags while you start a share
adb logcat -c
adb logcat | grep -iE "MediaProjection|ScreenCapture|ForegroundService|WebRTCModule|SecurityException|MissingForegroundServiceType"
```

Start the screen share and watch for:
- `Media projection service started`  → ✅ foreground service is running (good).
- `Media projection service not started` → ❌ flag still false / start blocked.
- `MissingForegroundServiceTypeException` or `SecurityException` mentioning `mediaProjection` → service type / permission problem.
- Nothing at all from `MediaProjection` → capture never began (permission dialog dismissed?).

Send me the lines around when you tap "Share" and I'll tune from there.

## 4. Things that are already correct (don't change)
- `AndroidManifest`: `MediaProjectionService` declared with `foregroundServiceType="mediaProjection"`.
- Permission `FOREGROUND_SERVICE_MEDIA_PROJECTION` present.
- `@config-plugins/react-native-webrtc` applied; OS App-info → "Picture-in-picture: Allowed".
- `react-native-webrtc@124.0.7` is the latest published version (no upgrade available).

## 5. Quality toggle (already in the app)
While sharing, the overlay has **Auto / Sharp / Smooth**:
- **Auto** (default) — starts Sharp, switches to Smooth when it detects motion.
- **Sharp** — best for text/code (near-native resolution, 12fps).
- **Smooth** — best for video/motion (downscaled, 24fps).
If text looks soft, pick **Sharp**; if motion stutters, pick **Smooth**.
