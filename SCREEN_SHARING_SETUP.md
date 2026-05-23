# Native Screen Sharing — Setup & Implementation

This document describes the native screen-sharing implementation in the
Smilers mobile app and the remaining build-time configuration required for
iOS.

## Status

| Platform | Status | What happens when user taps "Share screen" |
|----------|--------|---------------------------------------------|
| **Android** | ✅ Ready in the next EAS build | System "Start recording or casting?" prompt → on confirm, screen track replaces the camera track on the active call. |
| **iOS** | 🔧 Needs Broadcast Upload Extension target (build-time) | Currently shows an explanatory alert; once the extension is added to the Xcode project, ReplayKit's broadcast picker will appear. |
| **Web (preview)** | ⛔ Not supported | Tool button is hidden. |

The **mobile UI is fully wired** today:
* `ConferenceHUD` exposes a `Share screen` / `Stop sharing` tool button
  (active/yellow when broadcasting).
* `CallSession.startScreenShare()` / `stopScreenShare()` use
  `mediaDevices.getDisplayMedia()` from `react-native-webrtc` and replace
  the outgoing video track on the peer connection without renegotiating
  for video calls (uses `RTCRtpSender.replaceTrack`).
* Voice-only calls automatically renegotiate to add a video track when
  the user starts a screen share.
* The call screen at `/app/frontend/app/call/[conversationId].tsx`
  toggles `screenSharing` state and forwards it down to the HUD so the
  tool button reflects the live broadcasting state.

## Android setup (DONE)

`/app/frontend/app.json` declares the foreground-service permissions
required by Android 14+ for screen capture:

```json
"permissions": [
  "FOREGROUND_SERVICE",
  "FOREGROUND_SERVICE_PHONE_CALL",
  "FOREGROUND_SERVICE_MEDIA_PROJECTION"
]
```

`react-native-webrtc` ships a foreground service that requests the
`MediaProjection` token automatically when `getDisplayMedia()` is called.
No further manifest tweaks are required — the `@config-plugins/react-native-webrtc`
Expo plugin handles it. **Next EAS build will pick this up.**

## iOS setup (PENDING — build-time only)

Apple requires a separate **Broadcast Upload Extension** target signed
into the same App Group as the main app. The mobile JS already calls
`getDisplayMedia()` correctly; the extension is purely a native target
that must exist in the compiled `.ipa`.

### Recommended approach: bundled Expo config plugin

The cleanest Expo path is to install one of the community plugins that
adds the Broadcast Upload Extension target automatically during prebuild:

```bash
yarn expo install @config-plugins/react-native-webrtc
```

Then in `app.json` extend the plugin with broadcast options (only after
the plugin author adds an explicit broadcast option — current v14 does
not yet ship that flag). Until then, follow the manual steps below.

### Manual steps (one-time, after `eas build --platform ios`):

1. Add `RTCAppGroupIdentifier` and `RTCScreenSharingExtension` to the
   main app's `Info.plist`:

   ```xml
   <key>RTCAppGroupIdentifier</key>
   <string>group.com.smilers.app</string>
   <key>RTCScreenSharingExtension</key>
   <string>com.smilers.app.BroadcastExtension</string>
   ```

2. Add a new Xcode target of type **Broadcast Upload Extension** named
   `SmilersBroadcastExtension`.

3. Enable the **App Groups** capability on both the main app target and
   the extension target, with id `group.com.smilers.app`.

4. Replace the auto-generated `SampleHandler.swift` in the extension with
   the WebRTC bridge from
   `node_modules/react-native-webrtc/ios/RCTBroadcastSampleHandler.m`.
   Most repos re-export this directly:

   ```swift
   import ReplayKit
   import WebRTC

   class SampleHandler: RTCBroadcastSampleHandler {
     // No additional code needed — superclass forwards CMSampleBuffers
     // to the main app over the App Group.
   }
   ```

5. Set the iOS deployment target to **14.0+** on the extension target.

6. Rebuild the iOS app via `eas build --platform ios --profile production`.

### After the build is installed

When the user taps **Share screen** in the conference HUD on iOS, the
system's broadcast picker will appear automatically (via WebRTC's
`getDisplayMedia()` call which talks to the extension target).

## Code surface (already in place)

| File | What it does |
|------|--------------|
| `/app/frontend/src/lib/webrtc/CallSession.ts` | `startScreenShare()` calls `getDisplayMedia()`, finds the existing video sender, calls `replaceTrack` with the screen track. Stops camera-light. Renegotiates if voice-only. |
| `/app/frontend/app/call/[conversationId].tsx` | `toggleScreenShare` callback wraps the CallSession methods, manages local `screenSharing` state, catches errors with friendly alerts. iOS path currently shows the build-pending alert. |
| `/app/frontend/src/components/ConferenceHUD.tsx` | `Share screen` tool button accepts `onToggleScreenShare` + `screenSharing` props from the call screen; shows yellow active state when broadcasting; label flips to "Stop sharing". |
| `/app/frontend/app.json` | Adds `FOREGROUND_SERVICE_MEDIA_PROJECTION` permission for Android 14+. |

## Testing checklist

After the next EAS build:

1. Open a conference, tap **Share screen** on Android. System prompt
   should appear: "Start now / Cancel".
2. On confirm, the remote peer should see your screen instead of your
   camera feed. Audio continues uninterrupted.
3. Tap **Stop sharing** — camera feed should resume (or the video track
   should be removed for voice-only calls).
4. On iOS (after extension is built in), the ReplayKit picker should
   appear with **Smilers** as the broadcaster. Recording starts when
   confirmed.

## Known limitations

* No screen-share-with-audio yet (currently `audio: false` in
  `getDisplayMedia`). Easy to enable on Android by toggling that flag;
  iOS requires the extension to add `RPSampleBufferTypeAudioApp`
  handling.
* Remote side renders the screen track in the standard video tile (no
  fullscreen take-over yet). A future iteration can detect the SDP
  signaling and switch to a fullscreen presenter view.
* `screenSharing` state is local-only — other participants currently
  cannot tell *who* is sharing screen via Convex state. A future
  iteration can add `conferences.setScreenSharer({conferenceId})` to
  broadcast the presenter identity.
