import React, { useEffect } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { getDisplayInitials } from '../../lib/displayName';
import { Colors } from '../../theme';
import { styles } from './callScreenStyles';
import type { AudioOutputRoute } from './callTypes';

export function ControlBtn({
  testID,
  onPress,
  backgroundColor,
  icon,
  label,
  size,
}: {
  testID: string;
  onPress: () => void;
  backgroundColor: string;
  icon: React.ReactNode;
  label: string;
  size?: 'md' | 'xl';
}) {
  const sizeStyle = size === 'xl' ? styles.bigBtnXL : styles.bigBtn;
  return (
    <TouchableOpacity
      style={[sizeStyle, { backgroundColor }]}
      onPress={onPress}
      activeOpacity={0.85}
      testID={testID}
    >
      {icon}
      {label ? <Text style={styles.bigBtnLabel}>{label}</Text> : null}
    </TouchableOpacity>
  );
}

/**
 * RingingAvatar — avatar with up to three concentric pulsing rings.
 * When `animate=true`, the rings expand and fade in a staggered loop
 * (similar to FaceTime / WhatsApp incoming call screens).
 */
export function RingingAvatar({
  name,
  size,
  animate,
}: {
  name: string;
  size: number;
  animate: boolean;
}) {
  const p1 = useSharedValue(0);
  const p2 = useSharedValue(0);
  const p3 = useSharedValue(0);

  useEffect(() => {
    if (animate) {
      const loop = (sv: any, delay: number) => {
        sv.value = 0;
        sv.value = withRepeat(
          withTiming(1, { duration: 2200, easing: Easing.out(Easing.ease) }),
          -1,
          false
        );
      };
      // Stagger the rings
      loop(p1, 0);
      setTimeout(() => loop(p2, 600), 600);
      setTimeout(() => loop(p3, 1200), 1200);
    } else {
      cancelAnimation(p1);
      cancelAnimation(p2);
      cancelAnimation(p3);
      p1.value = 0;
      p2.value = 0;
      p3.value = 0;
    }
    return () => {
      cancelAnimation(p1);
      cancelAnimation(p2);
      cancelAnimation(p3);
    };
  }, [animate, p1, p2, p3]);

  const ringStyle1 = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + p1.value * 0.6 }],
    opacity: 0.45 * (1 - p1.value),
  }));
  const ringStyle2 = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + p2.value * 0.6 }],
    opacity: 0.45 * (1 - p2.value),
  }));
  const ringStyle3 = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + p3.value * 0.6 }],
    opacity: 0.45 * (1 - p3.value),
  }));

  const ringSize = size + 24;
  const initials = getDisplayInitials(name, 2);
  // Tighter wrap (was ringSize * 1.8 which forced massive vertical padding
  // and pushed the contact name down onto the action buttons on video calls).
  const wrapDim = animate ? ringSize * 1.55 : size + 16;

  return (
    <View style={[styles.ringingWrap, { width: wrapDim, height: wrapDim }]}>
      {animate ? (
        <>
          <Animated.View
            style={[
              styles.ring,
              { width: ringSize, height: ringSize, borderRadius: ringSize / 2 },
              ringStyle1,
            ]}
          />
          <Animated.View
            style={[
              styles.ring,
              { width: ringSize, height: ringSize, borderRadius: ringSize / 2 },
              ringStyle2,
            ]}
          />
          <Animated.View
            style={[
              styles.ring,
              { width: ringSize, height: ringSize, borderRadius: ringSize / 2 },
              ringStyle3,
            ]}
          />
        </>
      ) : null}
      <View
        style={[
          styles.callAvatarCore,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
          },
        ]}
        testID="call-avatar-core"
      >
        <Text style={[styles.callAvatarInitials, { fontSize: size * 0.28 }]}>{initials || '?'}</Text>
      </View>
    </View>
  );
}

export function AudioOutputMenu({
  value,
  onSelect,
}: {
  value: AudioOutputRoute;
  onSelect: (next: AudioOutputRoute) => void;
}) {
  const options: Array<{
    key: AudioOutputRoute;
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      key: 'earpiece',
      label: 'Earpiece',
      icon: <Ionicons name="phone-portrait-outline" size={22} color={Colors.primary} />,
    },
    {
      key: 'speaker',
      label: 'Speaker',
      icon: <Ionicons name="volume-high-outline" size={22} color="rgba(255,255,255,0.82)" />,
    },
    {
      key: 'bluetooth',
      label: 'Bluetooth',
      icon: <Ionicons name="bluetooth-outline" size={22} color="rgba(255,255,255,0.82)" />,
    },
  ];

  return (
    <View style={styles.audioMenuCard} testID="audio-output-card">
      <Text style={styles.audioMenuTitle}>AUDIO OUTPUT</Text>
      {options.map((option) => {
        const selected = value === option.key;
        return (
          <TouchableOpacity
            key={option.key}
            style={[styles.audioMenuRow, selected ? styles.audioMenuRowSelected : null]}
            onPress={() => onSelect(option.key)}
            activeOpacity={0.82}
            testID={`audio-output-${option.key}`}
          >
            <View style={styles.audioMenuIconWrap}>{option.icon}</View>
            <Text style={[styles.audioMenuLabel, selected ? styles.audioMenuLabelSelected : null]}>
              {option.label}
            </Text>
            {selected ? <View style={styles.audioMenuSelectedDot} /> : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/**
 * Three bouncing dots while we wait for the other side to pick up.
 */
export function BouncingDot({ delay }: { delay: number }) {
  const sv = useSharedValue(0);
  useEffect(() => {
    setTimeout(() => {
      sv.value = withRepeat(
        withTiming(1, { duration: 600, easing: Easing.inOut(Easing.ease) }),
        -1,
        true
      );
    }, delay);
    return () => cancelAnimation(sv);
  }, [delay, sv]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: -4 * sv.value }],
    opacity: 0.4 + 0.6 * sv.value,
  }));
  return <Animated.View style={[styles.dot, style]} />;
}

export function SmallControl({
  testID,
  onPress,
  active,
  icon,
  label,
}: {
  testID: string;
  onPress: () => void;
  active?: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <View style={styles.smallControlWrap}>
      <TouchableOpacity
        style={[styles.smallBtn, active ? styles.smallBtnActive : null]}
        onPress={onPress}
        activeOpacity={0.85}
        testID={testID}
      >
        {icon}
      </TouchableOpacity>
      <Text style={styles.smallBtnLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}
