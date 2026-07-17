/**
 * ChatSwipeRow — wraps a Chats-list row with swipe actions:
 *   • Right-swipe → Archive (full-swipe auto-triggers).
 *   • Left-swipe  → Mark read (only when the row is unread).
 * Extracted from app/(tabs)/chats.tsx.
 */
import React, { useRef } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Swipeable, RectButton } from 'react-native-gesture-handler';
import { Feather } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight } from '../theme';

type Props = {
  onArchive: () => void;
  onMarkRead?: () => void;
  hasUnread?: boolean;
  children: React.ReactNode;
};

export default function ChatSwipeRow({ onArchive, onMarkRead, hasUnread, children }: Props) {
  const ref = useRef<Swipeable>(null);
  const renderRightActions = () => (
    <RectButton
      style={styles.swipeArchiveAction}
      onPress={() => {
        ref.current?.close();
        onArchive();
      }}
    >
      <Feather name="archive" size={22} color={Colors.white} />
      <Text style={styles.swipeArchiveText}>Archive</Text>
    </RectButton>
  );
  const renderLeftActions =
    hasUnread && onMarkRead
      ? () => (
          <RectButton
            style={styles.swipeReadAction}
            onPress={() => {
              ref.current?.close();
              onMarkRead();
            }}
          >
            <Feather name="check-circle" size={22} color={Colors.white} />
            <Text style={styles.swipeArchiveText}>Read</Text>
          </RectButton>
        )
      : undefined;
  return (
    <Swipeable
      ref={ref}
      friction={2}
      rightThreshold={48}
      leftThreshold={48}
      overshootRight={false}
      overshootLeft={false}
      renderRightActions={renderRightActions}
      renderLeftActions={renderLeftActions}
      // A full swipe auto-triggers (no tap needed).
      onSwipeableOpen={(direction) => {
        if (direction === 'right') {
          ref.current?.close();
          onArchive();
        } else if (direction === 'left' && hasUnread && onMarkRead) {
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
  swipeArchiveAction: {
    backgroundColor: Colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    width: 92,
    gap: 4,
  },
  swipeArchiveText: {
    color: Colors.white,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
  },
  swipeReadAction: {
    backgroundColor: Colors.success || '#22c55e',
    justifyContent: 'center',
    alignItems: 'center',
    width: 92,
    gap: 4,
  },
});
