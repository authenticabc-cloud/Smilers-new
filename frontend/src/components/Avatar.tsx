import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, FontSize, FontWeight } from '../theme';

interface AvatarProps {
  name?: string;
  size?: number;
  uri?: string;
  backgroundColor?: string;
  textColor?: string;
}

export default function Avatar({ name, size = 48, backgroundColor, textColor }: AvatarProps) {
  const initial = (name || '?').charAt(0).toUpperCase();
  const fontSize = size * 0.45;

  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: backgroundColor || Colors.primaryLight,
        },
      ]}
    >
      <Text style={[styles.text, { fontSize, color: textColor || Colors.primary }]}>{initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontWeight: FontWeight.bold,
  },
});
