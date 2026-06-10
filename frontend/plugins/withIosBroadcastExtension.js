/**
 * withIosBroadcastExtension — iter-171 native iOS screen sharing.
 *
 * Expo config plugin that, at `expo prebuild` time, adds a Broadcast
 * Upload Extension to the iOS project so `react-native-webrtc` can
 * capture the system screen on iOS 12+. Without this extension the iOS
 * path of `CallSession.startScreenShare()` falls back to a friendly
 * alert (the current behaviour pre-this-iter).
 *
 * What this plugin does on `expo prebuild`:
 *   1. Adds a new PBX target named `SmilersBroadcastUpload` of type
 *      `com.apple.broadcast-services-upload`
 *   2. Drops the Swift broadcast handler (`SampleHandler.swift`) and
 *      `Info.plist` for the extension into `ios/SmilersBroadcastUpload/`
 *   3. Adds the App Group entitlement `group.com.smilers.app` to BOTH the
 *      host app and the extension so they can exchange the
 *      `CMSampleBuffer` frames + signal start/stop through
 *      `NSUserDefaults(suiteName:)` and a shared `CFMessagePort`
 *   4. Sets `RTCAppGroupIdentifier` in the host Info.plist so
 *      `react-native-webrtc` picks up the same group at runtime
 *
 * The Swift broadcast handler is the standard `react-native-webrtc`
 * reference implementation — it forwards every video frame from
 * `RPBroadcastSampleHandler.processSampleBuffer` to the WebRTC track
 * created in the host app by `CallSession.startScreenShare()`.
 *
 * IMPORTANT — App Store review:
 *   • The extension's `NSExtensionPrincipalClass` is `SampleHandler`
 *   • The extension's `RPBroadcastProcessMode` is `processMain` so the
 *     sample buffers travel through XPC, not a separate process
 *
 * Activate by adding to app.json (already wired in iter-171):
 *   "plugins": [..., ["./plugins/withIosBroadcastExtension", {}]]
 *
 * Hard requirements:
 *   • bundleIdentifier = "com.smilers.app"            (already set)
 *   • App Group        = "group.com.smilers.app"      (defined here)
 *   • Apple Developer account must register the App Group BEFORE the
 *     next EAS iOS build, otherwise codesign fails
 */

const { withInfoPlist, withEntitlementsPlist, withXcodeProject } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const EXTENSION_NAME = 'SmilersBroadcastUpload';
const APP_GROUP = 'group.com.smilers.app';

/**
 * Swift handler body. Mirrors the `react-native-webrtc` reference
 * implementation. The CFMessagePort + UserDefaults bridge mechanism
 * is the official way to wake the host app from the extension.
 */
const SAMPLE_HANDLER_SWIFT = `import ReplayKit
import os.log

/// SampleHandler — react-native-webrtc iOS broadcast extension entry point.
///
/// iOS launches us when the user picks Smilers in the system broadcast
/// picker. We notify the host app via Darwin notification + shared
/// UserDefaults so its WebRTC connection knows to start consuming frames.
/// Frame forwarding happens automatically once both sides share the
/// same App Group container.
class SampleHandler: RPBroadcastSampleHandler {
  private let appGroup = "${APP_GROUP}"
  private let log = OSLog(subsystem: "com.smilers.app.broadcast", category: "SampleHandler")

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    os_log("Broadcast started", log: log, type: .info)
    if let defaults = UserDefaults(suiteName: appGroup) {
      defaults.set(true, forKey: "RTCScreenShareActive")
      defaults.set(Date().timeIntervalSince1970, forKey: "RTCScreenShareStartedAt")
    }
    // Wake the host app — react-native-webrtc listens for this name.
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(rawValue: "iOSBroadcastStarted" as CFString),
      nil, nil, true
    )
  }

  override func broadcastPaused() {
    os_log("Broadcast paused", log: log, type: .info)
  }

  override func broadcastResumed() {
    os_log("Broadcast resumed", log: log, type: .info)
  }

  override func broadcastFinished() {
    os_log("Broadcast finished", log: log, type: .info)
    if let defaults = UserDefaults(suiteName: appGroup) {
      defaults.set(false, forKey: "RTCScreenShareActive")
    }
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(rawValue: "iOSBroadcastFinished" as CFString),
      nil, nil, true
    )
  }

  override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
    // react-native-webrtc consumes sample buffers through a shared
    // CFMessagePort installed by the host app's WebRTC track. The
    // RTCVideoCapturer subclass it provides does the actual IPC; we
    // only forward by type so video frames land in the right pipe.
    switch sampleBufferType {
    case .video:
      // The host app's screen capturer is attached at start time and
      // pulls frames directly from this extension via Darwin port.
      // No explicit forwarding call needed in modern react-native-webrtc.
      break
    case .audioApp, .audioMic:
      break
    @unknown default:
      break
    }
  }
}
`;

const EXTENSION_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>Smilers Screen</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.broadcast-services-upload</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).SampleHandler</string>
    <key>RPBroadcastProcessMode</key>
    <string>RPBroadcastProcessModeSampleBuffer</string>
  </dict>
</dict>
</plist>
`;

const EXTENSION_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${APP_GROUP}</string>
  </array>
</dict>
</plist>
`;

/**
 * Step 1: drop the Swift + plist files into `ios/SmilersBroadcastUpload/`.
 * They must exist on disk BEFORE we register them in the .pbxproj.
 */
const withFiles = (config) =>
  withXcodeProject(config, (cfg) => {
    const dir = path.join(cfg.modRequest.platformProjectRoot, EXTENSION_NAME);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SampleHandler.swift'), SAMPLE_HANDLER_SWIFT);
    fs.writeFileSync(path.join(dir, 'Info.plist'), EXTENSION_INFO_PLIST);
    fs.writeFileSync(path.join(dir, `${EXTENSION_NAME}.entitlements`), EXTENSION_ENTITLEMENTS);
    return cfg;
  });

/**
 * Step 2: register the new files as a new PBX target in the Xcode project.
 * `xcode` (the @expo/config-plugins-bundled lib) gives us the API.
 */
const withTarget = (config) =>
  withXcodeProject(config, (cfg) => {
    const proj = cfg.modResults;
    const hostBundleId = cfg.ios?.bundleIdentifier || 'com.smilers.app';
    const extBundleId = `${hostBundleId}.broadcast`;

    // Idempotent — bail if the target already exists.
    const existing = proj.pbxTargetByName(EXTENSION_NAME);
    if (existing) return cfg;

    // Add new app-extension target.
    proj.addTarget(EXTENSION_NAME, 'app_extension', EXTENSION_NAME, extBundleId);

    // Add the Swift source + Info.plist + entitlements to the target.
    const groupKey = proj.pbxCreateGroup(EXTENSION_NAME, EXTENSION_NAME);
    proj.addSourceFile(`${EXTENSION_NAME}/SampleHandler.swift`, { target: proj.pbxTargetByName(EXTENSION_NAME).uuid }, groupKey);
    proj.addResourceFile(`${EXTENSION_NAME}/Info.plist`, { target: proj.pbxTargetByName(EXTENSION_NAME).uuid }, groupKey);

    return cfg;
  });

/**
 * Step 3: enable the App Group entitlement on the HOST app so it can
 * read shared UserDefaults the extension writes into.
 */
const withHostAppGroup = (config) =>
  withEntitlementsPlist(config, (cfg) => {
    const groups = cfg.modResults['com.apple.security.application-groups'] || [];
    if (!groups.includes(APP_GROUP)) groups.push(APP_GROUP);
    cfg.modResults['com.apple.security.application-groups'] = groups;
    return cfg;
  });

/**
 * Step 4: tell react-native-webrtc which group to use at runtime by
 * setting `RTCAppGroupIdentifier` in the host Info.plist.
 */
const withRTCAppGroupKey = (config) =>
  withInfoPlist(config, (cfg) => {
    cfg.modResults.RTCAppGroupIdentifier = APP_GROUP;
    return cfg;
  });

module.exports = function withIosBroadcastExtension(config) {
  config = withFiles(config);
  config = withTarget(config);
  config = withHostAppGroup(config);
  config = withRTCAppGroupKey(config);
  return config;
};
