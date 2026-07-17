import React, { useCallback, useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Shadow } from '../theme';
import { subscribeTouchActivity } from '../lib/touchActivity';
import { toggleDriveMode, useDriveMode } from '../lib/driveMode';

// Lazily grab the speech-recognition module for the permission prompt.
let ExpoSpeechRecognitionModule: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ExpoSpeechRecognitionModule = require('expo-speech-recognition').ExpoSpeechRecognitionModule;
} catch {
  ExpoSpeechRecognitionModule = null;
}

const IDLE_FADE_MS = 4000;
const FADE_MS = 220;

/**
 * DriveModeToggle — a small pill that sits just ABOVE the SOS button and turns
 * hands-free Drive Mode on/off. It auto-dims after a few seconds of inactivity
 * and pops back to full opacity on any screen touch (shares the global
 * touch-activity tracker with the voice-command FAB), while staying tappable.
 */
export default function DriveModeToggle() {
  const on = useDriveMode();
  const opacity = useRef(new Animated.Value(1)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fadeTo = useCallback(
    (to: number) => {
      Animated.timing(opacity, {
        toValue: to,
        duration: FADE_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    },
    [opacity],
  );

  const scheduleDim = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    // Keep it prominent while ON so the driver can see the state.
    hideTimer.current = setTimeout(() => fadeTo(on ? 0.55 : 0.18), IDLE_FADE_MS);
  }, [fadeTo, on]);

  const reveal = useCallback(() => {
    fadeTo(1);
    scheduleDim();
  }, [fadeTo, scheduleDim]);

  useEffect(() => {
    const unsub = subscribeTouchActivity(reveal);
    reveal();
    return () => {
      unsub();
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [reveal]);

  const handlePress = useCallback(async () => {
    reveal();
    if (!on) {
      // Ask for the microphone before turning listening on.
      try {
        const perm = await ExpoSpeechRecognitionModule?.requestPermissionsAsync?.();
        if (perm && perm.granted === false) {
          // Still toggle on; the controller will surface a permission hint.
        }
      } catch {
        /* ignore — controller handles missing permission */
      }
    }
    toggleDriveMode();
  }, [on, reveal]);

  return (
    <Animated.View style={[styles.wrap, { opacity }]} pointerEvents="box-none">
      <TouchableOpacity
        style={[styles.pill, on ? styles.pillOn : styles.pillOff]}
        onPress={handlePress}
        activeOpacity={0.85}
        testID="drive-mode-toggle"
        accessibilityLabel={on ? 'Turn Drive Mode off' : 'Turn Drive Mode on'}
      >
        <MaterialCommunityIcons
          name={on ? 'steering' : 'car'}
          size={16}
          color={Colors.white}
          style={styles.icon}
        />
        <Text style={styles.text}>{on ? 'DRIVE ON' : 'DRIVE'}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    // Sits directly above the SOS pill (SOS is bottom: 84).
    bottom: 132,
    left: 0,
  },
  pill: {
    position: 'absolute',
    left: -44,
    bottom: 0,
    paddingVertical: 10,
    paddingRight: 16,
    paddingLeft: 56,
    borderTopRightRadius: Radius.pill,
    borderBottomRightRadius: Radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    ...Shadow.lg,
  },
  pillOff: { backgroundColor: '#2563EB' },
  pillOn: { backgroundColor: '#16A34A' },
  icon: { marginRight: 6 },
  text: {
    color: Colors.white,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.sm,
    letterSpacing: 0.5,
  },
});
