#import <React/RCTBridgeModule.h>

// Registers the Swift SmilersCallModule (and its playCallTone method) with the
// React Native bridge so JS can call NativeModules.SmilersCallModule.playCallTone.
@interface RCT_EXTERN_MODULE(SmilersCallModule, NSObject)

RCT_EXTERN_METHOD(playCallTone:(NSString *)name
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
