/**
 * EmergencyActiveBanner
 *
 * A slim, persistent bar pinned to the top while the CURRENT user has an active
 * emergency alert. It gives a constant "you are broadcasting" indicator and a
 * one-tap route back to the emergency controls (/emergency), from any screen.
 *
 * Hidden on web, when there is no active alert, and while already on the
 * Emergency screen (which shows its own controls).
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Platform, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useQuery } from 'convex/react';
import { usePathname, useRouter } from 'expo-router';

import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';
import { Colors, FontSize, FontWeight } from '../theme';

export default function EmergencyActiveBanner() {
  const { isAuthenticated } = useAuth();
  const alert = useQuery(
    (api as any).emergencyAlerts.getActiveAlert,
    isAuthenticated ? {} : ('skip' as any),
  ) as { _id?: string; status?: string } | null | undefined;
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const router = useRouter();

  const active = !!alert?._id && alert?.status !== 'resolved';
  const onEmergencyScreen = !!pathname && pathname.startsWith('/emergency');
  const visible = Platform.OS !== 'web' && active && !onEmergencyScreen;

  // Pulsing "live" dot.
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!visible) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.3, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [visible, pulse]);

  if (!visible) return null;

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => router.push('/emergency' as any)}
      style={[styles.bar, { paddingTop: insets.top, height: insets.top + 34 }]}
      testID="emergency-active-banner"
    >
      <Animated.View style={[styles.dot, { opacity: pulse }]} />
      <Text style={styles.text}>Sharing live · tap to view</Text>
      <Feather name="chevron-right" size={16} color={Colors.white} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10000,
    elevation: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.danger,
    paddingHorizontal: 12,
  },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: Colors.white },
  text: { color: Colors.white, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
});
