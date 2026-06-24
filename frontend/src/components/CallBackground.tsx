import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  interpolate,
} from 'react-native-reanimated';

/**
 * CallBackground — a modern, premium animated backdrop for call screens.
 *
 * Layers (back → front):
 *   1. Rich multi-stop linear gradient (brand-warm or calm-blue).
 *   2. Three large, slowly-drifting glowing orbs rendered with true SVG
 *      radial gradients (soft, blur-free glow that reads well on OLED).
 *   3. A subtle radial vignette that darkens the edges to focus the
 *      avatar / call controls in the center.
 *
 * The motion is intentionally slow (12–20s loops) so it feels alive and
 * premium without ever distracting from the call itself.
 */

type Variant = 'warm' | 'incoming';

interface Palette {
  base: readonly [string, string, string];
  orbs: { color: string; r: number; x: number; y: number }[];
}

// Orb positions are expressed as fractions of the screen so the layout
// scales across phones, tablets and foldables.
const PALETTES: Record<Variant, Palette> = {
  warm: {
    base: ['#2A1D06', '#3A2608', '#160F03'],
    orbs: [
      { color: '#E4B53B', r: 0.62, x: 0.18, y: 0.16 },
      { color: '#C99A1F', r: 0.78, x: 0.92, y: 0.42 },
      { color: '#FFD34E', r: 0.5, x: 0.5, y: 0.96 },
    ],
  },
  incoming: {
    base: ['#0E2438', '#143A57', '#081320'],
    orbs: [
      { color: '#4FC3F7', r: 0.6, x: 0.16, y: 0.18 },
      { color: '#1E88E5', r: 0.8, x: 0.9, y: 0.44 },
      { color: '#80DEEA', r: 0.5, x: 0.52, y: 0.95 },
    ],
  },
};

function Orb({
  color,
  size,
  left,
  top,
  driftX,
  driftY,
  duration,
  delay,
}: {
  color: string;
  size: number;
  left: number;
  top: number;
  driftX: number;
  driftY: number;
  duration: number;
  delay: number;
}) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [duration, progress]);

  const animatedStyle = useAnimatedStyle(() => {
    const tx = interpolate(progress.value, [0, 1], [-driftX, driftX]);
    const ty = interpolate(progress.value, [0, 1], [driftY, -driftY]);
    const scale = interpolate(progress.value, [0, 0.5, 1], [1, 1.12, 1]);
    const opacity = interpolate(progress.value, [0, 0.5, 1], [0.85, 1, 0.85]);
    return {
      opacity,
      transform: [{ translateX: tx }, { translateY: ty }, { scale }],
    };
  });

  // Unique gradient id per orb instance.
  const gradId = useMemo(() => `orb-${Math.random().toString(36).slice(2)}`, []);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.orb,
        { width: size, height: size, left, top },
        animatedStyle,
        // Stagger the loops so the orbs never pulse in unison.
        { ...(delay ? {} : {}) },
      ]}
    >
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={gradId} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={color} stopOpacity={0.55} />
            <Stop offset="45%" stopColor={color} stopOpacity={0.22} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${gradId})`} />
      </Svg>
    </Animated.View>
  );
}

function CallBackground({ variant = 'warm' }: { variant?: Variant }) {
  const { width, height } = useWindowDimensions();
  const palette = PALETTES[variant];
  const minSide = Math.min(width, height);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={palette.base as unknown as string[]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />

      {palette.orbs.map((orb, i) => {
        const size = minSide * orb.r * 1.9;
        const left = width * orb.x - size / 2;
        const top = height * orb.y - size / 2;
        return (
          <Orb
            key={i}
            color={orb.color}
            size={size}
            left={left}
            top={top}
            driftX={18 + i * 8}
            driftY={22 + i * 6}
            duration={13000 + i * 3500}
            delay={i * 600}
          />
        );
      })}

      {/* Edge vignette — keeps the center (avatar / controls) crisp. */}
      <Svg style={StyleSheet.absoluteFill} width={width} height={height}>
        <Defs>
          <RadialGradient id="call-vignette" cx="50%" cy="42%" r="75%">
            <Stop offset="55%" stopColor="#000000" stopOpacity={0} />
            <Stop offset="100%" stopColor="#000000" stopOpacity={0.55} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={width} height={height} fill="url(#call-vignette)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  orb: {
    position: 'absolute',
  },
});

export default React.memo(CallBackground);
