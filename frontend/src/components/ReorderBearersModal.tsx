import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import DraggableFlatList, { ScaleDecorator, type RenderItemParams } from 'react-native-draggable-flatlist';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

export type ReorderBearer = { userId: string; name: string; title: string };

function getInitials(name?: string): string {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/**
 * ReorderBearersModal — smooth drag-and-drop ranking of a sub group's office
 * bearers (Chief Admin). On drop, reports the new top-to-bottom userId order to
 * the parent, which calls subGroups.setPositionOrder.
 */
export function ReorderBearersModal({
  visible,
  bearers,
  onReorder,
  onClose,
}: {
  visible: boolean;
  bearers: ReorderBearer[];
  onReorder: (orderedUserIds: string[]) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<ReorderBearer[]>(bearers);

  useEffect(() => {
    if (visible) setData(bearers);
  }, [visible, bearers]);

  const renderItem = ({ item, drag, isActive }: RenderItemParams<ReorderBearer>) => (
    <ScaleDecorator>
      <TouchableOpacity
        style={[styles.row, isActive && styles.rowActive]}
        onLongPress={drag}
        delayLongPress={120}
        disabled={isActive}
        testID={`reorder-bearer-${item.userId}`}
      >
        <Ionicons name="reorder-three" size={24} color={Colors.textSecondary} />
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{getInitials(item.name)}</Text>
        </View>
        <View style={styles.mid}>
          <Text style={styles.name} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.title} numberOfLines={1}>
            {item.title}
          </Text>
        </View>
      </TouchableOpacity>
    </ScaleDecorator>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Rank office bearers</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} testID="reorder-bearers-close">
              <Ionicons name="close" size={24} color={Colors.textPrimary} />
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>Press and hold, then drag to reorder. Saved automatically.</Text>
          <GestureHandlerRootView style={styles.listWrap}>
            <DraggableFlatList
              data={data}
              keyExtractor={(item) => item.userId}
              renderItem={renderItem}
              onDragEnd={({ data: next }) => {
                setData(next);
                onReorder(next.map((b) => b.userId));
              }}
            />
          </GestureHandlerRootView>
          <TouchableOpacity style={styles.doneBtn} onPress={onClose} testID="reorder-bearers-done">
            <Text style={styles.doneText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  card: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    padding: Spacing.lg,
    maxHeight: '82%',
    gap: Spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  hint: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.sm },
  listWrap: { flexGrow: 0, maxHeight: 420 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: 12,
    paddingHorizontal: Spacing.sm,
    backgroundColor: Colors.background,
    borderRadius: Radius.md,
  },
  rowActive: { backgroundColor: Colors.surface },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  mid: { flex: 1 },
  name: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  title: { fontSize: FontSize.sm, color: Colors.textSecondary },
  doneBtn: { backgroundColor: Colors.primary, paddingVertical: 14, borderRadius: Radius.pill, alignItems: 'center', marginTop: Spacing.sm },
  doneText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
});
