/**
 * GroupSwipeRow — wraps a Groups-list row with a left-swipe "Read" action.
 * Mounted only for unread groups. Extracted from app/(tabs)/groups.tsx.
 */
import React, { useRef } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Swipeable, RectButton } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight } from '../theme';

type Props = { onMarkRead: () => void; children: React.ReactNode };

export default function GroupSwipeRow({ onMarkRead, children }: Props) {
  const ref = useRef<Swipeable>(null);
  const renderLeftActions = () => (
    <RectButton
      style={styles.swipeReadAction}
      onPress={() => {
        ref.current?.close();
        onMarkRead();
      }}
    >
      <Ionicons name="checkmark-circle-outline" size={22} color={Colors.white} />
      <Text style={styles.swipeReadText}>Read</Text>
    </RectButton>
  );
  return (
    <Swipeable
      ref={ref}
      friction={2}
      leftThreshold={48}
      overshootLeft={false}
      renderLeftActions={renderLeftActions}
      onSwipeableOpen={(direction) => {
        if (direction === 'left') {
          ref.current?.close();
          onMarkRead();
        }
      }}
    >
      {children}
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  swipeReadAction: {
    backgroundColor: Colors.success || '#22c55e',
    justifyContent: 'center',
    alignItems: 'center',
    width: 92,
    gap: 4,
  },
  swipeReadText: { color: Colors.white, fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
});
