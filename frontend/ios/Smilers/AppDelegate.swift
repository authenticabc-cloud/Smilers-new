import Expo
import React
import ReactAppDependencyProvider
import stream_io_noise_cancellation_react_native

// TEMP native launch diagnostics. Since the iOS app hangs on the splash and
// never runs JavaScript (no JS boot heartbeat reaches the backend), these
// fire-and-forget beacons report each native launch step directly from Swift
// so we can see exactly how far the native launch gets, and whether the
// embedded JS bundle (main.jsbundle) is present. Reuses the existing
// /api/diagnostic-logs endpoint, tagged platform "ios-native".
func smilersNativeBeacon(_ stage: String, _ detail: String) {
  let host = "https://app-migration-75.emergent.host"
  guard let url = URL(string: host + "/api/diagnostic-logs") else { return }
  let ts = Int(Date().timeIntervalSince1970 * 1000)
  let appVer = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"
  let payload: [String: Any] = [
    "platform": "ios-native",
    "appVersion": appVer,
    "platformVersion": UIDevice.current.systemVersion,
    "device": UIDevice.current.model,
    "events": [[
      "ts": ts,
      "tag": "NATIVE",
      "message": stage + ": " + detail,
      "source": "AppDelegate",
    ]],
  ]
  guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
  var req = URLRequest(url: url)
  req.httpMethod = "POST"
  req.setValue("application/json", forHTTPHeaderField: "Content-Type")
  req.httpBody = body
  URLSession.shared.dataTask(with: req).resume()
}

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    smilersNativeBeacon("didFinishLaunching", "start")
    let embeddedBundle = Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    smilersNativeBeacon("embeddedBundle", embeddedBundle == nil ? "MISSING main.jsbundle" : ("found " + embeddedBundle!.lastPathComponent))

    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    bindReactNativeFactory(factory)

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    smilersNativeBeacon("startReactNative", "before")
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
    smilersNativeBeacon("startReactNative", "after")
#endif

    // Defer Stream Video native setup (Krisp noise/echo cancellation + VoIP
    // PushKit registration) to the next main-runloop tick so it runs AFTER
    // React Native has begun loading the JS bundle. Running these SYNCHRONOUSLY
    // before `startReactNative` can stall the iOS launch sequence so the JS
    // bundle never executes — observed as a permanent splash-screen hang on
    // first launch with NO JS boot heartbeat reaching the backend (iOS only;
    // Android boots fine). They are still registered at launch time.
    DispatchQueue.main.async {
      NoiseCancellationManager.getInstance().registerProcessor()
      StreamVideoReactNative.voipRegistration()
    }

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    let u = Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    smilersNativeBeacon("bundleURL", u == nil ? "returned nil (no embedded bundle!)" : ("returned " + u!.absoluteString))
    return u
#endif
  }
}
