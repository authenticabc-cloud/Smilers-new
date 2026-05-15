import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { useAuth } from '../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

const MAX_TRUSTEES = 5;

interface Trustee {
  _id: string;
  name?: string;
  phone?: string;
  email?: string;
  relationship?: string;
  contactId?: string;
}

interface FormState {
  name: string;
  phone: string;
  email: string;
  relationship: string;
}

const EMPTY_FORM: FormState = { name: '', phone: '', email: '', relationship: '' };

export default function TrusteesScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { data: trustees, loading, refetch } = useSafeConvexQuery<Trustee[]>(
    api.trustees.getMyTrustees,
    {},
    [],
    isAuthenticated,
  );
  const addTrustee = useMutation(api.trustees.addTrustee);
  const updateTrustee = useMutation(api.trustees.updateTrustee);
  const removeTrustee = useMutation(api.trustees.removeTrustee);

  const list = useMemo(() => trustees || [], [trustees]);
  const atCap = list.length >= MAX_TRUSTEES;

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Trustee | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const openAdd = useCallback(() => {
    if (atCap) {
      Alert.alert(
        'Trustee limit reached',
        `You can have up to ${MAX_TRUSTEES} trustees. Remove an existing trustee first to add a new one.`,
      );
      return;
    }
    setEditing(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  }, [atCap]);

  const openEdit = useCallback((trustee: Trustee) => {
    setEditing(trustee);
    setForm({
      name: trustee.name || '',
      phone: trustee.phone || '',
      email: trustee.email || '',
      relationship: trustee.relationship || '',
    });
    setModalOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    if (submitting) return;
    setModalOpen(false);
    setEditing(null);
    setForm(EMPTY_FORM);
  }, [submitting]);

  const validate = useCallback((): string | null => {
    const name = form.name.trim();
    const phone = form.phone.trim();
    const email = form.email.trim();
    if (!name) return 'Please enter a name.';
    if (!phone && !email) return 'Please enter a phone number or email.';
    if (phone && phone.replace(/\D/g, '').length < 6) return 'Phone number looks too short.';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Please enter a valid email.';
    return null;
  }, [form]);

  const submit = useCallback(async () => {
    const errorMsg = validate();
    if (errorMsg) {
      Alert.alert('Check your entry', errorMsg);
      return;
    }
    setSubmitting(true);
    const payload: any = {
      name: form.name.trim(),
      phone: form.phone.trim() || undefined,
      email: form.email.trim() || undefined,
      relationship: form.relationship.trim() || undefined,
    };
    try {
      if (editing) {
        await updateTrustee({ trusteeId: editing._id, ...payload });
      } else {
        await addTrustee(payload);
      }
      await refetch();
      setModalOpen(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    } catch (errorValue: any) {
      Alert.alert(
        editing ? 'Could not update trustee' : 'Could not add trustee',
        errorValue?.message || 'Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }, [addTrustee, editing, form, refetch, updateTrustee, validate]);

  const onRemove = useCallback(
    (trustee: Trustee) => {
      Alert.alert(
        `Remove ${trustee.name || 'this trustee'}?`,
        'They will no longer be alerted in an emergency.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              setRemovingId(trustee._id);
              try {
                await removeTrustee({ trusteeId: trustee._id });
                await refetch();
              } catch (errorValue: any) {
                Alert.alert('Could not remove trustee', errorValue?.message || 'Please try again.');
              } finally {
                setRemovingId(null);
              }
            },
          },
        ],
      );
    },
    [refetch, removeTrustee],
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="trustees-screen">
      <Header
        title="Trustees"
        showBack
        onBack={() => router.back()}
        variant="dark"
        subtitle={`${list.length} of ${MAX_TRUSTEES}`}
        right={
          <TouchableOpacity
            onPress={openAdd}
            style={[styles.addBtn, atCap ? styles.addBtnDisabled : null]}
            disabled={atCap}
            testID="trustees-add"
          >
            <Ionicons name="add" size={18} color={atCap ? Colors.textMuted : Colors.headerBg} />
            <Text style={[styles.addBtnText, atCap ? { color: Colors.textMuted } : null]}>Add</Text>
          </TouchableOpacity>
        }
      />

      <ScrollView
        contentContainerStyle={{ paddingBottom: 48 }}
        refreshing={loading}
        testID="trustees-list"
      >
        <View style={styles.intro}>
          <View style={styles.introIconWrap}>
            <Ionicons name="shield-checkmark" size={28} color={Colors.primary} />
          </View>
          <Text style={styles.introTitle}>Your circle of trust</Text>
          <Text style={styles.introBody}>
            Add up to {MAX_TRUSTEES} contacts who will be notified instantly when you trigger an SOS. They’ll receive your last
            known location.
          </Text>
        </View>

        {loading && list.length === 0 ? (
          <View style={styles.loadingWrap} testID="trustees-loading">
            <ActivityIndicator size="small" color={Colors.primary} />
          </View>
        ) : list.length === 0 ? (
          <View style={styles.emptyWrap} testID="trustees-empty">
            <Ionicons name="people-outline" size={48} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>No trustees yet</Text>
            <Text style={styles.emptyBody}>Tap “Add” to add your first trusted contact.</Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={openAdd} testID="trustees-empty-add">
              <Ionicons name="add" size={20} color={Colors.white} />
              <Text style={styles.emptyBtnText}>Add Trustee</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.list}>
            {list.map((t, index) => (
              <View key={t._id} style={styles.row} testID={`trustees-row-${index}`}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{(t.name || 'T').charAt(0).toUpperCase()}</Text>
                </View>
                <TouchableOpacity
                  style={styles.rowMid}
                  onPress={() => openEdit(t)}
                  activeOpacity={0.7}
                  testID={`trustees-row-edit-${index}`}
                >
                  <Text style={styles.rowName} numberOfLines={1}>
                    {t.name || 'Trustee'}
                  </Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {t.phone || t.email || '—'}
                  </Text>
                  {t.relationship ? (
                    <Text style={styles.rowRel} numberOfLines={1}>
                      {t.relationship}
                    </Text>
                  ) : null}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.iconBtn}
                  onPress={() => openEdit(t)}
                  hitSlop={8}
                  testID={`trustees-edit-${index}`}
                >
                  <Ionicons name="create-outline" size={20} color={Colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.iconBtn}
                  onPress={() => onRemove(t)}
                  hitSlop={8}
                  disabled={removingId === t._id}
                  testID={`trustees-remove-${index}`}
                >
                  {removingId === t._id ? (
                    <ActivityIndicator size="small" color={Colors.danger} />
                  ) : (
                    <Ionicons name="trash-outline" size={20} color={Colors.danger} />
                  )}
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        <View style={styles.tipCard}>
          <Ionicons name="information-circle-outline" size={18} color={Colors.textSecondary} />
          <Text style={styles.tipText}>
            Tip: choose people who can quickly act on your behalf — a family member, a close friend, or a colleague who lives
            nearby.
          </Text>
        </View>
      </ScrollView>

      <Modal
        visible={modalOpen}
        animationType="slide"
        transparent
        onRequestClose={closeModal}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalBackdrop}
        >
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editing ? 'Edit trustee' : 'Add trustee'}
              </Text>
              <TouchableOpacity onPress={closeModal} hitSlop={10} testID="trustee-modal-close">
                <Ionicons name="close" size={24} color={Colors.textPrimary} />
              </TouchableOpacity>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 16 }}>
              <Text style={styles.label}>Name *</Text>
              <TextInput
                value={form.name}
                onChangeText={(v) => setForm((f) => ({ ...f, name: v }))}
                placeholder="e.g. Jane Smith"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="words"
                style={styles.input}
                editable={!submitting}
                testID="trustee-name-input"
              />

              <Text style={styles.label}>Phone</Text>
              <TextInput
                value={form.phone}
                onChangeText={(v) => setForm((f) => ({ ...f, phone: v }))}
                placeholder="+1 555 555 5555"
                placeholderTextColor={Colors.textMuted}
                keyboardType="phone-pad"
                style={styles.input}
                editable={!submitting}
                testID="trustee-phone-input"
              />

              <Text style={styles.label}>Email</Text>
              <TextInput
                value={form.email}
                onChangeText={(v) => setForm((f) => ({ ...f, email: v }))}
                placeholder="jane@example.com"
                placeholderTextColor={Colors.textMuted}
                keyboardType="email-address"
                autoCapitalize="none"
                style={styles.input}
                editable={!submitting}
                testID="trustee-email-input"
              />

              <Text style={styles.label}>Relationship</Text>
              <TextInput
                value={form.relationship}
                onChangeText={(v) => setForm((f) => ({ ...f, relationship: v }))}
                placeholder="e.g. Sister, Best friend, Doctor"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="sentences"
                style={styles.input}
                editable={!submitting}
                testID="trustee-relationship-input"
              />

              <Text style={styles.helper}>
                Provide at least a phone number or email so we can reach them in an emergency.
              </Text>
            </ScrollView>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={closeModal}
                disabled={submitting}
                testID="trustee-cancel"
              >
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnPrimary, submitting ? { opacity: 0.7 } : null]}
                onPress={submit}
                disabled={submitting}
                testID="trustee-submit"
              >
                {submitting ? (
                  <ActivityIndicator size="small" color={Colors.headerBg} />
                ) : (
                  <Text style={styles.modalBtnPrimaryText}>{editing ? 'Save changes' : 'Add trustee'}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.md,
  },
  addBtnDisabled: {
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  addBtnText: {
    color: Colors.headerBg,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.sm,
  },
  intro: {
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
    gap: 6,
  },
  introIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  introTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  introBody: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  loadingWrap: { paddingVertical: Spacing.xl, alignItems: 'center' },
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    gap: 8,
    paddingHorizontal: Spacing.lg,
  },
  emptyTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginTop: Spacing.sm,
  },
  emptyBody: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: Spacing.md,
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    borderRadius: Radius.pill,
  },
  emptyBtnText: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.base },
  list: { marginTop: Spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: Colors.primaryDark, fontWeight: FontWeight.bold, fontSize: FontSize.lg },
  rowMid: { flex: 1 },
  rowName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  rowMeta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  rowRel: { fontSize: FontSize.xs, color: Colors.primaryDark, marginTop: 2, fontWeight: FontWeight.semibold },
  iconBtn: {
    padding: 8,
    minWidth: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tipCard: {
    flexDirection: 'row',
    gap: Spacing.sm,
    margin: Spacing.base,
    padding: Spacing.md,
    backgroundColor: '#FFFBEB',
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  tipText: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.base,
    paddingBottom: Spacing.lg,
    maxHeight: '92%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  modalTitle: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  label: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: Spacing.md,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    backgroundColor: Colors.background,
  },
  helper: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: Spacing.md,
    lineHeight: 18,
  },
  modalActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.base,
  },
  modalBtn: {
    flex: 1,
    height: 48,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBtnGhost: { backgroundColor: Colors.borderLight },
  modalBtnGhostText: { color: Colors.textPrimary, fontWeight: FontWeight.semibold, fontSize: FontSize.base },
  modalBtnPrimary: { backgroundColor: Colors.primary },
  modalBtnPrimaryText: { color: Colors.headerBg, fontWeight: FontWeight.bold, fontSize: FontSize.base },
});
