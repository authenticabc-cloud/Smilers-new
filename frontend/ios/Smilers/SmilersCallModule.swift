import Foundation
import AVFoundation

/**
 * iOS counterpart of the Android `SmilersCallModule.playCallTone`.
 *
 * Plays a short in-call tone (the "Connected" / "Ciaooo" call chimes) bundled in
 * the app (the ios/Smilers folder, as .mp3 files) via AVAudioPlayer. Lives in the
 * app's OWN committed native source (always compiled) — NOT a node_modules patch, which was not
 * reliably compiled into release builds. The mixing behaviour follows the
 * AVAudioSession the Stream/WebRTC call has already configured.
 *
 * RCTPromiseResolveBlock / RCTPromiseRejectBlock are exposed to Swift through the
 * Smilers-Bridging-Header.h (#import <React/RCTBridgeModule.h>).
 */
@objc(SmilersCallModule)
class SmilersCallModule: NSObject {

  private var tonePlayer: AVAudioPlayer?

  @objc(playCallTone:resolver:rejecter:)
  func playCallTone(
    _ name: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let url = Bundle.main.url(forResource: name, withExtension: "mp3") else {
      resolve(false)
      return
    }
    do {
      let player = try AVAudioPlayer(contentsOf: url)
      player.numberOfLoops = 0
      player.volume = 1.0
      player.prepareToPlay()
      player.play()
      // Retain so it isn't deallocated mid-playback.
      self.tonePlayer = player
      resolve(true)
    } catch {
      reject("PLAY_TONE_FAILED", error.localizedDescription, error)
    }
  }

  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  /// iter-463d: Native diagnostic bridge. The expo-modules-core race patch
  /// mirrors its `[smilers-diag]` boot-timeline events into
  /// NSUserDefaults("smilers_native_diag"). This method (in COMMITTED native
  /// source, so it always compiles) hands that timeline to JS, which records it
  /// into the on-device Diagnostic Logs — letting us see whether
  /// legacyProxyDidSetBridge fires / the permission retry gives up, WITHOUT a Mac.
  @objc(getNativeDiag:rejecter:)
  func getNativeDiag(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let arr = UserDefaults.standard.array(forKey: "smilers_native_diag") as? [String] ?? []
    resolve(arr)
  }
}
