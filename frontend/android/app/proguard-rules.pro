# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# Add any project specific keep options here:

# @generated begin expo-build-properties - expo prebuild (DO NOT MODIFY)

        -keep class com.twilio.** { *; }
        -keep class tvi.webrtc.** { *; }
      
# react-native-webrtc — keep all native classes from being stripped by R8 in release builds.
# Without these rules the org.webrtc.* classes are stripped → instant native crash on require().
-keep class org.webrtc.** { *; }
-keep interface org.webrtc.** { *; }
-dontwarn org.webrtc.**
# React Native bridge module for WebRTC
-keep class com.oney.WebRTCModule.** { *; }
-keep interface com.oney.WebRTCModule.** { *; }
-dontwarn com.oney.WebRTCModule.**
# React Native core modules that WebRTC depends on
-keep class com.facebook.react.modules.** { *; }
-keep class com.facebook.jni.** { *; }
# Keep all JNI native methods
-keepclasseswithmembernames class * { native <methods>; }
# @twilio/video-react-native-sdk — keep the Twilio Video SDK and its namespaced WebRTC fork (tvi.webrtc).
# R8 minification is enabled; the existing rules only keep org.webrtc.* (react-native-webrtc). Without these
# Twilio rules R8 strips com.twilio.* / tvi.webrtc.* in release builds, so mounting the <TwilioVideo> view
# (tapping the voice/video call button) hits missing native classes and HARD-crashes (no JS error boundary can catch it).
-keep class com.twilio.** { *; }
-keep interface com.twilio.** { *; }
-dontwarn com.twilio.**
-keep class tvi.webrtc.** { *; }
-keep interface tvi.webrtc.** { *; }
-dontwarn tvi.webrtc.**
-keep class com.twiliorn.** { *; }
-dontwarn com.twiliorn.**
# @generated end expo-build-properties