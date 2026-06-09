/**
 * /group/[id]/regulations  ▸  Regulations Board (iter-151)
 *
 * Canonical: `api.groupRegulations.getRegulations / addRegulation /
 * updateRegulation / deleteRegulation`.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import { api } from '../../../src/convexApi';
import { useSafeConvexQuery } from '../../../src/hooks/useSafeConvexQuery';
import ScreenErrorBoundary from '../../../src/components/ScreenErrorBoundary';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../../src/theme';

export default function RegulationsScreen() {
  const router = useRouter();
  return (
    <ScreenErrorBoundary screenName="group-regulations" onClose={() => router.back()}>
      <RegulationsInner />
    </ScreenErrorBoundary>
  );
}

function RegulationsInner() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = id;
  const { data: regs, loading, refetch } = useSafeConvexQuery<any[]>(
    (api as any).groupRegulations?.getRegulations,
    conversationId ? { conversationId } : {},
    [],
    !!conversationId,
  );
  const addM = useMutation((api as any).groupRegulations?.addRegulation);
  const updateM = useMutation((api as any).groupRegulations?.updateRegulation);
  const deleteM = useMutation((api as any).groupRegulations?.deleteRegulation);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);

  const openCreate = () => {
    setEditingId(null);
    setTitle('');
    setContent('');
    setPinned(false);
    setEditorOpen(true);
  };

  const openEdit = (r: any) => {
    setEditingId(String(r._id));
    setTitle(r.title || '');
    setContent(r.content || '');
    setPinned(!!r.pinned);
    setEditorOpen(true);
  };

  const onSave = async () => {
    if (!conversationId) return;
    if (!title.trim() || !content.trim()) {
      return Alert.alert('Missing fields', 'Title and content are required.');
    }
    setBusy(true);
    try {
      if (editingId) {
        if (typeof updateM !== 'function') throw new Error('Server missing updateRegulation');
        await updateM({ regulationId: editingId, title: title.trim(), content: content.trim(), pinned });
      } else {
        if (typeof addM !== 'function') throw new Error('Server missing addRegulation');
        await addM({ conversationId, title: title.trim(), content: content.trim(), pinned });
      }
      setEditorOpen(false);
      await refetch();
    } catch (e: any) {
      Alert.alert('Save failed', e?.message?.slice(0, 200) || 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  const onDelete = (regulationId: string, regTitle: string) => {
    Alert.alert('Delete regulation?', `"${regTitle}" will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            if (typeof deleteM !== 'function') return;
            await deleteM({ regulationId });
            await refetch();
          } catch (e: any) {
            Alert.alert('Delete failed', e?.message?.slice(0, 200) || 'Try again.');
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="group-regulations-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="arrow-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginHorizontal: 12 }}>
          <Text style={styles.headerTitle}>Regulations Board</Text>
          <Text style={styles.headerSub}>{regs?.length || 0} rules</Text>
        </View>
        <TouchableOpacity onPress={openCreate} hitSlop={10} testID="group-regulations-add">
          <Feather name="plus" size={28} color={Colors.textPrimary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={Colors.primary} size="large" style={{ marginTop: 60 }} />
      ) : (
        <FlatList
          data={regs || []}
          keyExtractor={(it: any) => String(it._id)}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={{ height: Spacing.md }} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Feather name="file-text" size={42} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No regulations yet</Text>
              <Text style={styles.emptyBody}>Tap + to add group rules and guidelines.</Text>
              <TouchableOpacity style={styles.emptyCta} onPress={openCreate} testID="group-regulations-empty-cta">
                <Text style={styles.emptyCtaText}>Add Regulation</Text>
              </TouchableOpacity>
            </View>
          }
          renderItem={({ item }: any) => (
            <TouchableOpacity
              style={[styles.card, item.pinned && styles.cardPinned]}
              onPress={() => openEdit(item)}
              testID={`regulation-${String(item._id)}`}
            >
              <View style={styles.cardHeader}>
                {item.pinned ? <Feather name="bookmark" size={14} color={Colors.primary} /> : null}
                <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
                <TouchableOpacity onPress={() => onDelete(String(item._id), item.title)} hitSlop={10}>
                  <Feather name="trash-2" size={18} color="#D63030" />
                </TouchableOpacity>
              </View>
              <Text style={styles.cardContent} numberOfLines={4}>{item.content}</Text>
              {item.creatorName ? <Text style={styles.cardMeta}>by {item.creatorName}</Text> : null}
            </TouchableOpacity>
          )}
        />
      )}

      <Modal visible={editorOpen} transparent animationType="slide" onRequestClose={() => setEditorOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setEditorOpen(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>{editingId ? 'Edit Regulation' : 'Add Regulation'}</Text>
            <Text style={styles.modalLabel}>Title</Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. No spam"
              placeholderTextColor={Colors.textMuted}
              style={styles.input}
              maxLength={80}
            />
            <Text style={styles.modalLabel}>Content</Text>
            <TextInput
              value={content}
              onChangeText={setContent}
              placeholder="Explain the rule…"
              placeholderTextColor={Colors.textMuted}
              style={[styles.input, { minHeight: 100, textAlignVertical: 'top' }]}
              multiline
              maxLength={600}
            />
            <TouchableOpacity style={styles.pinRow} onPress={() => setPinned((p) => !p)}>
              <Feather name={pinned ? 'check-square' : 'square'} size={20} color={Colors.primary} />
              <Text style={styles.pinText}>Pin to top</Text>
            </TouchableOpacity>
            <View style={styles.actions}>
              <TouchableOpacity onPress={() => setEditorOpen(false)} style={styles.cancel}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onSave} style={styles.save} disabled={busy}>
                <Text style={styles.saveText}>{busy ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  header: {
    height: Platform.select({ ios: 100, default: 88 }),
    backgroundColor: Colors.primary,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.md,
  },
  headerTitle: { fontSize: 20, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  headerSub: { fontSize: FontSize.sm, color: 'rgba(60,40,10,0.7)', marginTop: 2 },
  listContent: { padding: Spacing.base, paddingBottom: 80 },
  empty: { paddingTop: 80, alignItems: 'center', gap: 10 },
  emptyTitle: { fontSize: 20, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  emptyBody: { fontSize: FontSize.base, color: Colors.textSecondary, textAlign: 'center', paddingHorizontal: 30 },
  emptyCta: { marginTop: 16, height: 50, paddingHorizontal: 32, borderRadius: Radius.md, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  emptyCtaText: { fontWeight: FontWeight.bold, color: Colors.textPrimary, fontSize: FontSize.base },
  card: { padding: Spacing.base, borderRadius: Radius.lg, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.borderLight, gap: 6 },
  cardPinned: { borderColor: Colors.primary, borderWidth: 1.5 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { flex: 1, fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  cardContent: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  cardMeta: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 4 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: Spacing.lg, gap: Spacing.md, maxHeight: '90%' },
  modalTitle: { fontSize: 20, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  modalLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  input: { minHeight: 46, paddingHorizontal: Spacing.base, paddingVertical: Spacing.sm, borderWidth: 1, borderColor: Colors.borderLight, borderRadius: Radius.md, fontSize: FontSize.base, color: Colors.textPrimary, backgroundColor: Colors.background },
  pinRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  pinText: { fontSize: FontSize.base, color: Colors.textPrimary },
  actions: { flexDirection: 'row', gap: Spacing.sm, marginTop: 8 },
  cancel: { flex: 1, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.md },
  cancelText: { color: Colors.textSecondary, fontWeight: FontWeight.semibold },
  save: { flex: 1, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.md, backgroundColor: Colors.primary },
  saveText: { color: Colors.textPrimary, fontWeight: FontWeight.bold, fontSize: FontSize.base },
});
