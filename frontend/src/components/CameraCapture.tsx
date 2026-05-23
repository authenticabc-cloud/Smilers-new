/**
 * CameraCapture — in-app camera modal for taking photos directly from
 * the chat composer.
 *
 * Mirrors the web app's `<CameraCapture>` (src/pages/chat/_components/camera-capture.tsx):
 *   • Front/back camera toggle (top-right)
 *   • Close button (top-left)
 *   • Shutter button (bottom-center, large white circle)
 *   • Captured-photo preview with Retake / Send / Discard
 *   • Permission denied fullscreen overlay with "Open Settings" CTA
 *
 * Uses `expo-camera` (CameraView API, SDK 54). On confirm, calls
 * `onCapture(localUri)` with the JPEG file URI saved to the cache dir;
 * the parent uploads it to Convex.
 */

import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions, CameraType } from 'expo-camera';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

interface CameraCaptureProps {
  visible: boolean;
  /** Called with the local file URI of the captured JPEG when the user taps Send. */
  onCapture: (localUri: string) => void | Promise<void>;
  /** Called when the user dismisses the camera (close or back). */
  onClose: () => void;
}

export default function CameraCapture({ visible, onCapture, onClose }: CameraCaptureProps) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [capturing, setCapturing] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [sending, setSending] = useState(false);
  const cameraRef = useRef<CameraView | null>(null);

  // Hide the entire view when not visible — avoids keeping the camera
  // sensor warm in the background.
  if (!visible) return null;

  const closeAndReset = () => {
    setPreview(null);
    setSending(false);
    setCapturing(false);
    setCameraReady(false);
    onClose();
  };

  const handleRequestPermission = async () => {
    const result = await requestPermission();
    if (!result.granted && !result.canAskAgain) {
      Alert.alert(
        'Camera access blocked',
        'Open Settings and allow camera access to take photos.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ],
      );
    }
  };

  const handleShoot = async () => {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        // Mirror the captured image when using the front camera so the
        // preview matches what the user saw on screen (the live preview
        // is mirrored by the OS for front cameras).
        mirror: facing === 'front',
        exif: false,
        skipProcessing: false,
      });
      if (photo?.uri) {
        setPreview(photo.uri);
      }
    } catch (errorValue: any) {
      Alert.alert('Capture failed', errorValue?.message || 'Please try again.');
    } finally {
      setCapturing(false);
    }
  };

  const handleRetake = () => {
    setPreview(null);
  };

  const handleSend = async () => {
    if (!preview || sending) return;
    setSending(true);
    try {
      await onCapture(preview);
      closeAndReset();
    } catch (errorValue: any) {
      Alert.alert('Failed to send', errorValue?.message || 'Please try again.');
      setSending(false);
    }
  };

  // --- Permission states ----------------------------------------------------
  if (!permission) {
    return (
      <View style={styles.root} testID="camera-capture-loading">
        <ActivityIndicator color={Colors.white} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.root} testID="camera-capture-permission">
        <SafeAreaView edges={['top']} style={styles.permissionHeader}>
          <TouchableOpacity onPress={closeAndReset} style={styles.iconBtn} testID="camera-permission-close">
            <Feather name="x" size={26} color={Colors.white} />
          </TouchableOpacity>
        </SafeAreaView>
        <View style={styles.permissionBody}>
          <Feather name="camera-off" size={72} color="rgba(255,255,255,0.65)" />
          <Text style={styles.permissionTitle}>Camera access needed</Text>
          <Text style={styles.permissionBodyText}>
            Allow Smilers to use your camera so you can take photos directly
            from chat.
          </Text>
          <TouchableOpacity
            style={styles.permissionCta}
            onPress={handleRequestPermission}
            activeOpacity={0.85}
            testID="camera-permission-grant"
          >
            <Text style={styles.permissionCtaText}>Allow camera</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // --- Preview state --------------------------------------------------------
  if (preview) {
    return (
      <View style={styles.root} testID="camera-capture-preview">
        <Image source={{ uri: preview }} style={StyleSheet.absoluteFill} resizeMode="contain" />

        <SafeAreaView edges={['top']} style={styles.previewTopBar}>
          <TouchableOpacity onPress={closeAndReset} style={styles.iconBtn} testID="camera-preview-discard">
            <Feather name="x" size={26} color={Colors.white} />
          </TouchableOpacity>
        </SafeAreaView>

        <View style={[styles.previewActions, { paddingBottom: Math.max(insets.bottom, 18) }]}>
          <TouchableOpacity
            style={styles.previewSecondaryBtn}
            onPress={handleRetake}
            activeOpacity={0.85}
            disabled={sending}
            testID="camera-preview-retake"
          >
            <Feather name="refresh-ccw" size={22} color={Colors.white} />
            <Text style={styles.previewSecondaryText}>Retake</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.previewSendBtn}
            onPress={handleSend}
            activeOpacity={0.85}
            disabled={sending}
            testID="camera-preview-send"
          >
            {sending ? (
              <ActivityIndicator color="#3D2A00" />
            ) : (
              <>
                <Feather name="send" size={22} color="#3D2A00" />
                <Text style={styles.previewSendText}>Send</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // --- Live camera state ----------------------------------------------------
  return (
    <View style={styles.root} testID="camera-capture-live">
      <CameraView
        ref={(ref) => {
          cameraRef.current = ref;
        }}
        facing={facing}
        style={StyleSheet.absoluteFill}
        onCameraReady={() => setCameraReady(true)}
      />

      <SafeAreaView edges={['top']} style={styles.liveTopBar}>
        <TouchableOpacity onPress={closeAndReset} style={styles.iconBtn} testID="camera-live-close">
          <Feather name="x" size={26} color={Colors.white} />
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={() => setFacing((current) => (current === 'back' ? 'front' : 'back'))}
          style={styles.iconBtn}
          testID="camera-live-switch"
        >
          <Ionicons name="camera-reverse" size={26} color={Colors.white} />
        </TouchableOpacity>
      </SafeAreaView>

      {!cameraReady ? (
        <View style={styles.cameraLoadingOverlay}>
          <ActivityIndicator color={Colors.white} />
          <Text style={styles.cameraLoadingText}>Starting camera…</Text>
        </View>
      ) : null}

      <View style={[styles.shutterWrap, { paddingBottom: Math.max(insets.bottom, 24) + 12 }]}>
        <TouchableOpacity
          style={[styles.shutterBtn, capturing ? styles.shutterBtnDisabled : null]}
          onPress={handleShoot}
          disabled={!cameraReady || capturing}
          activeOpacity={0.85}
          testID="camera-live-shutter"
        >
          <View style={styles.shutterInner} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    zIndex: 999,
  },

  // Permission state
  permissionHeader: { paddingHorizontal: Spacing.lg, paddingTop: 4 },
  permissionBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: 14,
  },
  permissionTitle: {
    fontSize: 22,
    color: Colors.white,
    fontWeight: FontWeight.bold,
    textAlign: 'center',
  },
  permissionBodyText: {
    fontSize: FontSize.base,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    lineHeight: 22,
  },
  permissionCta: {
    marginTop: 12,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
  },
  permissionCtaText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: '#3D2A00' },

  // Live camera
  liveTopBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: 6,
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  cameraLoadingText: { color: Colors.white, fontWeight: FontWeight.semibold },

  shutterWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
  },
  shutterBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 4,
    borderColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterBtnDisabled: { opacity: 0.55 },
  shutterInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.white,
  },

  // Preview
  previewTopBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.lg,
    paddingTop: 6,
  },
  previewActions: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    gap: 14,
  },
  previewSecondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  previewSecondaryText: { fontSize: FontSize.base, color: Colors.white, fontWeight: FontWeight.semibold },
  previewSendBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
  },
  previewSendText: { fontSize: FontSize.base, color: '#3D2A00', fontWeight: FontWeight.bold },
});
