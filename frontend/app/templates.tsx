import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Header from '../src/components/Header';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';
import { QUICK_TEMPLATES_KEY, readStoredJson, writeStoredJson } from '../src/lib/settingsStorage';

const SUGGESTED_TEMPLATES = [
  {
    id: 'starter-thanks',
    label: 'Thanks',
    shortcut: '/thanks',
    message: 'Thanks so much. I’ll get back to you shortly.',
    favorite: false,
  },
  {
    id: 'starter-omw',
    label: 'On my way',
    shortcut: '/omw',
    message: 'On my way. I’ll message you as soon as I arrive.',
    favorite: false,
  },
  {
    id: 'starter-followup',
    label: 'Follow up',
    shortcut: '/followup',
    message: 'Just following up on my earlier message — let me know when you have a moment.',
    favorite: false,
  },
];

function emptyDraft() {
  return {
    id: '',
    label: '',
    shortcut: '',
    message: '',
    favorite: false,
  };
}

export default function TemplatesScreen() {
  const router = useRouter();
  const [templates, setTemplates] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [statusNote, setStatusNote] = useState('Loading quick replies…');
  const [composerVisible, setComposerVisible] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const stored = await readStoredJson(QUICK_TEMPLATES_KEY, []);
      if (mounted) {
        setTemplates(Array.isArray(stored) ? stored : []);
        setStatusNote('Saved on this device');
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  const persist = async (nextTemplates: any[], nextNote = 'Saved on this device') => {
    setTemplates(nextTemplates);
    await writeStoredJson(QUICK_TEMPLATES_KEY, nextTemplates);
    setStatusNote(nextNote);
  };

  const filteredTemplates = useMemo(() => {
    const cleanQuery = query.trim().toLowerCase();
    const source = [...templates].sort((a, b) => Number(b.favorite) - Number(a.favorite));
    if (!cleanQuery) {
      return source;
    }
    return source.filter((item) => {
      const haystack = `${item.label} ${item.shortcut} ${item.message}`.toLowerCase();
      return haystack.includes(cleanQuery);
    });
  }, [query, templates]);

  const openCreate = () => {
    setDraft(emptyDraft());
    setComposerVisible(true);
  };

  const openEdit = (item: any) => {
    setDraft({ ...item });
    setComposerVisible(true);
  };

  const saveDraft = async () => {
    const label = draft.label.trim();
    const message = draft.message.trim();
    if (!label) {
      Alert.alert('Add a title', 'Give this quick reply a short label.');
      return;
    }
    if (!message) {
      Alert.alert('Add a message', 'Write the quick reply text you want to reuse.');
      return;
    }

    const nextTemplate = {
      ...draft,
      id: draft.id || `${Date.now()}`,
      label,
      shortcut: draft.shortcut.trim(),
      message,
    };
    const nextTemplates = draft.id
      ? templates.map((item) => (item.id === draft.id ? nextTemplate : item))
      : [nextTemplate, ...templates];
    await persist(nextTemplates);
    setComposerVisible(false);
  };

  const onCopy = async (item: any) => {
    await Clipboard.setStringAsync(item.message || '');
    setStatusNote(`Copied “${item.label}”`);
  };

  const toggleFavorite = async (item: any) => {
    const nextTemplates = templates.map((entry) =>
      entry.id === item.id ? { ...entry, favorite: !entry.favorite } : entry
    );
    await persist(nextTemplates);
  };

  const removeTemplate = (id: string) => {
    Alert.alert('Delete quick reply?', 'This removes it from your saved reply list.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await persist(templates.filter((item) => item.id !== id));
        },
      },
    ]);
  };

  const addSuggestedTemplate = async (item: any) => {
    if (templates.some((entry) => entry.shortcut === item.shortcut || entry.label === item.label)) {
      setStatusNote(`${item.label} is already saved`);
      return;
    }
    await persist([{ ...item }, ...templates], `${item.label} added`);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="templates-screen">
      <Header
        title="Quick Replies"
        showBack
        onBack={() => router.back()}
        variant="dark"
        subtitle="Create and manage message templates"
        right={
          <TouchableOpacity onPress={openCreate} style={styles.headerButton} testID="templates-add-button">
            <Ionicons name="add" size={24} color={Colors.white} />
          </TouchableOpacity>
        }
      />

      <FlatList
        data={filteredTemplates}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        testID="templates-list"
        ListHeaderComponent={
          <>
            <View style={styles.heroCard} testID="templates-hero-card">
              <View style={styles.heroIconWrap} testID="templates-hero-icon-wrap">
                <MaterialCommunityIcons name="message-text-outline" size={24} color={Colors.primary} />
              </View>
              <View style={styles.flexOne}>
                <Text style={styles.heroTitle} testID="templates-hero-title">Reply faster</Text>
                <Text style={styles.heroSub} testID="templates-hero-subtitle">
                  Save your most-used responses, copy them instantly, and keep consistent replies ready.
                </Text>
              </View>
            </View>

            <View style={styles.searchWrap} testID="templates-search-wrap">
              <Ionicons name="search" size={18} color={Colors.textMuted} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search quick replies"
                placeholderTextColor={Colors.textMuted}
                style={styles.searchInput}
                testID="templates-search-input"
              />
            </View>

            <Text style={styles.statusNote} testID="templates-status-note">{statusNote}</Text>

            <View style={styles.suggestionsCard} testID="templates-suggestions-card">
              <Text style={styles.sectionTitle} testID="templates-suggestions-title">Starter replies</Text>
              <Text style={styles.sectionSub} testID="templates-suggestions-subtitle">
                Add a few common replies in one tap, then edit them anytime.
              </Text>
              {SUGGESTED_TEMPLATES.map((item, index) => (
                <View key={item.id} style={[styles.suggestionRow, index === SUGGESTED_TEMPLATES.length - 1 ? styles.suggestionRowLast : null]}>
                  <View style={styles.flexOne}>
                    <Text style={styles.templateLabel} testID={`template-suggestion-label-${index}`}>{item.label}</Text>
                    <Text style={styles.templatePreview} numberOfLines={2} testID={`template-suggestion-message-${index}`}>
                      {item.message}
                    </Text>
                  </View>
                  <TouchableOpacity style={styles.addSmallButton} onPress={() => addSuggestedTemplate(item)} testID={`template-suggestion-add-${index}`}>
                    <Text style={styles.addSmallButtonText}>Add</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          </>
        }
        renderItem={({ item, index }) => (
          <View style={styles.templateCard} testID={`template-card-${index}`}>
            <View style={styles.templateTopRow}>
              <View style={styles.flexOne}>
                <View style={styles.templateMetaRow}>
                  <Text style={styles.templateLabel} testID={`template-label-${index}`}>{item.label}</Text>
                  {item.shortcut ? <Text style={styles.shortcutPill} testID={`template-shortcut-${index}`}>{item.shortcut}</Text> : null}
                </View>
                <Text style={styles.templatePreview} numberOfLines={3} testID={`template-message-${index}`}>{item.message}</Text>
              </View>
              <TouchableOpacity onPress={() => toggleFavorite(item)} style={styles.iconButton} testID={`template-favorite-${index}`}>
                <Ionicons name={item.favorite ? 'star' : 'star-outline'} size={20} color={item.favorite ? Colors.tickYellow : Colors.textMuted} />
              </TouchableOpacity>
            </View>

            <View style={styles.actionsRow} testID={`template-actions-${index}`}>
              <TouchableOpacity style={styles.actionButton} onPress={() => onCopy(item)} testID={`template-copy-${index}`}>
                <Ionicons name="copy-outline" size={18} color={Colors.primary} />
                <Text style={styles.actionButtonText}>Copy</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionButton} onPress={() => openEdit(item)} testID={`template-edit-${index}`}>
                <Ionicons name="create-outline" size={18} color={Colors.primary} />
                <Text style={styles.actionButtonText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.deleteButton} onPress={() => removeTemplate(item.id)} testID={`template-delete-${index}`}>
                <Ionicons name="trash-outline" size={18} color={Colors.danger} />
                <Text style={styles.deleteButtonText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.emptyCard} testID="templates-empty-state">
            <MaterialCommunityIcons name="message-reply-text-outline" size={54} color={Colors.primary} />
            <Text style={styles.emptyTitle}>No quick replies found</Text>
            <Text style={styles.emptySub}>Try a different search or create your first saved response.</Text>
            <TouchableOpacity style={styles.primaryButton} onPress={openCreate} testID="templates-empty-create-button">
              <Text style={styles.primaryButtonText}>Create Quick Reply</Text>
            </TouchableOpacity>
          </View>
        }
      />

      <Modal visible={composerVisible} transparent animationType="slide" onRequestClose={() => setComposerVisible(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setComposerVisible(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalKeyboardWrap}>
            <Pressable style={styles.modalCard} onPress={() => {}} testID="templates-modal">
              <Text style={styles.modalTitle} testID="templates-modal-title">{draft.id ? 'Edit quick reply' : 'New quick reply'}</Text>
              <Text style={styles.modalSub} testID="templates-modal-subtitle">
                Give this reply a label and save the message you want to reuse.
              </Text>
              <TextInput
                value={draft.label}
                onChangeText={(value) => setDraft({ ...draft, label: value })}
                placeholder="Label"
                placeholderTextColor={Colors.textMuted}
                style={styles.input}
                testID="templates-label-input"
              />
              <TextInput
                value={draft.shortcut}
                onChangeText={(value) => setDraft({ ...draft, shortcut: value })}
                placeholder="Shortcut, e.g. /thanks"
                placeholderTextColor={Colors.textMuted}
                style={styles.input}
                testID="templates-shortcut-input"
              />
              <TextInput
                value={draft.message}
                onChangeText={(value) => setDraft({ ...draft, message: value })}
                placeholder="Message"
                placeholderTextColor={Colors.textMuted}
                multiline
                style={[styles.input, styles.messageInput]}
                testID="templates-message-input"
              />
              <View style={styles.modalActions} testID="templates-modal-actions">
                <TouchableOpacity style={styles.modalSecondaryButton} onPress={() => setComposerVisible(false)} testID="templates-cancel-button">
                  <Text style={styles.modalSecondaryButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalPrimaryButton} onPress={saveDraft} testID="templates-save-button">
                  <Text style={styles.modalPrimaryButtonText}>{draft.id ? 'Save Changes' : 'Save Reply'}</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  headerButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  content: { padding: Spacing.base, paddingBottom: 56, flexGrow: 1 },
  heroCard: {
    flexDirection: 'row',
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.base,
    marginBottom: Spacing.base,
  },
  heroIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryLight,
  },
  heroTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  heroSub: { marginTop: 4, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: Spacing.base,
  },
  searchInput: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  statusNote: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.base },
  suggestionsCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.base,
    marginBottom: Spacing.base,
  },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  sectionSub: { marginTop: 4, marginBottom: Spacing.base, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  suggestionRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  suggestionRowLast: { borderBottomWidth: 0, paddingBottom: 0 },
  addSmallButton: {
    minHeight: 40,
    borderRadius: Radius.pill,
    paddingHorizontal: 14,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addSmallButtonText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.primaryDark },
  templateCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.base,
    marginBottom: Spacing.base,
  },
  templateTopRow: { flexDirection: 'row', gap: 12 },
  templateMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 },
  templateLabel: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  shortcutPill: {
    fontSize: FontSize.xs,
    color: Colors.primaryDark,
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    overflow: 'hidden',
  },
  templatePreview: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  iconButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: Spacing.base },
  actionButton: {
    minHeight: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionButtonText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  deleteButton: {
    minHeight: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: '#FECACA',
    backgroundColor: '#FEF2F2',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  deleteButtonText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.danger },
  emptyCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.xl,
    alignItems: 'center',
    gap: 12,
    marginTop: Spacing.base,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  primaryButton: {
    minHeight: 48,
    paddingHorizontal: 18,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.headerBg },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalKeyboardWrap: { width: '100%' },
  modalCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: Spacing.base,
    gap: 12,
  },
  modalTitle: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: Colors.textPrimary, textAlign: 'center' },
  modalSub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  input: {
    minHeight: 48,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.base,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  messageInput: { minHeight: 110, paddingTop: 14, textAlignVertical: 'top' },
  modalActions: { flexDirection: 'row', gap: 12 },
  modalPrimaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalPrimaryButtonText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.headerBg },
  modalSecondaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalSecondaryButtonText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  flexOne: { flex: 1 },
});