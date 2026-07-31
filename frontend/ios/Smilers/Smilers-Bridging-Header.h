//
// Use this file to import your target's public headers that you would like to expose to Swift.
//

// Stream Video SDK — expose the Objective-C StreamVideoReactNative class to Swift
// (used by StreamVideoReactNative.voipRegistration() in AppDelegate.swift). The pod
// links as a static library (no use_frameworks!), so the class is reached through the
// bridging header rather than a Swift module import.
#import "StreamVideoReactNative.h"

// Expose the React Native bridge-module macros/types (RCTPromiseResolveBlock,
// RCTPromiseRejectBlock) to Swift for SmilersCallModule.swift.
#import <React/RCTBridgeModule.h>

