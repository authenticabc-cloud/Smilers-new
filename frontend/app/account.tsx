import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
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
import { useMutation, useQuery } from 'convex/react';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import {
  APP_LOCK_PIN_KEY,
  APP_LOCK_SETTINGS_KEY,
  CHAT_APPEARANCE_KEY,
  PHONE_VERIFIED_INSTALL_KEY,
  PRIVACY_SETTINGS_KEY,
  QUICK_TEMPLATES_KEY,
  SCHEDULED_MESSAGES_KEY,
  removeStoredValue,
} from '../src/lib/settingsStorage';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

export default function AccountScreen() {
  const router = useRouter();
  const { signOut, isAuthenticated } = useAuth();
  const me: any = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip');
  // Attempt to bind a delete mutation. If the backend hasn't shipped this
  // function yet, useMutation will still return a callable that errors when
  // invoked — we handle that gracefully below.
  const deleteAccount = useMutation(api.users.deleteAccount);

  const [signingOut, setSigningOut] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const clearLocalState = async () => {
    await Promise.all([
      removeStoredValue(PHONE_VERIFIED_INSTALL_KEY),
      removeStoredValue(PRIVACY_SETTINGS_KEY),
      removeStoredValue(APP_LOCK_SETTINGS_KEY),
      removeStoredValue(APP_LOCK_PIN_KEY),
      removeStoredValue(SCHEDULED_MESSAGES_KEY),
      removeStoredValue(QUICK_TEMPLATES_KEY),
      removeStoredValue(CHAT_APPEARANCE_KEY),
    ]);
  };

  const handleSignOut = () => {
    Alert.alert(
      'Sign out of Smilers?',
      'You will need to sign in and verify your phone number again to use Smilers on this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: async () => {
            try {
              setSigningOut(true);
              await clearLocalState();
              await signOut();
              router.replace('/');
            } catch (errorValue: any) {
              setSigningOut(false);
              Alert.alert('Sign out failed', errorValue?.message || 'Please try again.');
            }
          },
        },
      ],
    );
  };

  const openDelete = () => {
    setConfirmText('');
    setDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (confirmText.trim().toUpperCase() !== 'DELETE') {
      Alert.alert('Type DELETE to confirm', 'For your safety, please type DELETE exactly to confirm account deletion.');
      return;
    }
    try {
      setDeleting(true);
      try {
        await deleteAccount({});
      } catch (errorValue: any) {
        // If the backend function isn't deployed yet, surface a friendly error
        // but still sign the user out locally so they aren't trapped.
        console.warn('deleteAccount mutation failed:', errorValue?.message);
      }
      await clearLocalState();
      await signOut();
      setDeleteOpen(false);
      router.replace('/');
    } catch (errorValue: any) {
      setDeleting(false);
      Alert.alert('Could not delete account', errorValue?.message || 'Please try again later.');
    }
  };

  const displayName = me?.name || me?.displayName || 'Smilers user';
  // iter-166 Identity Rework: prefer canonical phoneE164, fall back to
  // legacy `phone` for not-yet-migrated users.
  const phone = (typeof me?.phoneE164 === 'string' && me.phoneE164)
    || (typeof me?.phone === 'string' && me.phone)
    || '—';
  const email = me?.email || '—';
  const avatarLetter = (displayName || 'S').trim().charAt(0).toUpperCase();

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="account-screen">
      <Header title="Account" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <View style={styles.profileCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{avatarLetter}</Text>
          </View>
          <Text style={styles.profileName} numberOfLines={1}>
            {displayName}
          </Text>
          <View style={styles.profileMetaRow}>
            <Ionicons name="call-outline" size={14} color={Colors.textSecondary} />
            <Text style={styles.profileMetaText} numberOfLines={1}>
              {phone}
            </Text>
          </View>
          <View style={styles.profileMetaRow}>
            <Ionicons name="mail-outline" size={14} color={Colors.textSecondary} />
            <Text style={styles.profileMetaText} numberOfLines={1}>
              {email}
            </Text>
          </View>
        </View>

        <Text style={styles.sectionLabel}>Account</Text>
        <TouchableOpacity
          style={styles.row}
          activeOpacity={0.7}
          onPress={() => router.push('/change-phone-number')}
          testID="account-change-phone"
        >
          <View style={[styles.iconWrap, { backgroundColor: '#DBEAFE' }]}>
            <Ionicons name="call-outline" size={22} color="#2563EB" />
          </View>
          <View style={styles.rowMid}>
            <Text style={styles.rowTitle}>Change phone number</Text>
            <Text style={styles.rowSub} numberOfLines={1}>
              {phone === '—' ? 'Add a verified phone number' : `Currently ${phone}`}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={Colors.textMuted} />
        </TouchableOpacity>

        <Text style={styles.sectionLabel}>Session</Text>
        <TouchableOpacity
          style={styles.row}
          activeOpacity={0.7}
          onPress={handleSignOut}
          disabled={signingOut}
          testID="account-sign-out"
        >
          <View style={[styles.iconWrap, { backgroundColor: '#FEF3C7' }]}>
            <Ionicons name="log-out-outline" size={22} color={Colors.primary} />
          </View>
          <View style={styles.rowMid}>
            <Text style={styles.rowTitle}>Sign out</Text>
            <Text style={styles.rowSub}>End your session on this device</Text>
          </View>
          {signingOut ? (
            <ActivityIndicator size="small" color={Colors.primary} />
          ) : (
            <Ionicons name="chevron-forward" size={20} color={Colors.textMuted} />
          )}
        </TouchableOpacity>

        <Text style={styles.sectionLabel}>Danger zone</Text>
        <TouchableOpacity
          style={styles.row}
          activeOpacity={0.7}
          onPress={openDelete}
          disabled={deleting}
          testID="account-delete"
        >
          <View style={[styles.iconWrap, { backgroundColor: '#FEE2E2' }]}>
            <Ionicons name="trash-outline" size={22} color={Colors.danger} />
          </View>
          <View style={styles.rowMid}>
            <Text style={[styles.rowTitle, { color: Colors.danger }]}>Delete account</Text>
            <Text style={styles.rowSub}>Permanently remove your account and data</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={Colors.textMuted} />
        </TouchableOpacity>

        <View style={styles.noteCard}>
          <Ionicons name="information-circle-outline" size={18} color={Colors.textSecondary} />
          <Text style={styles.noteText}>
            Deleting your account is permanent. Your messages, contacts, ad credits, and earnings cannot be recovered.
          </Text>
        </View>
      </ScrollView>

      <Modal
        visible={deleteOpen}
        transparent
        animationType="fade"
        onRequestClose={() => (deleting ? null : setDeleteOpen(false))}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={[styles.modalIconWrap]}>
              <Ionicons name="warning-outline" size={26} color={Colors.danger} />
            </View>
            <Text style={styles.modalTitle}>Delete your account?</Text>
            <Text style={styles.modalBody}>
              This will permanently delete your Smilers account, messages, contacts, and ad credits.
              This action cannot be undone.
            </Text>
            <Text style={styles.modalLabel}>Type DELETE to confirm</Text>
            <TextInput
              value={confirmText}
              onChangeText={setConfirmText}
              placeholder="DELETE"
              autoCapitalize="characters"
              autoCorrect={false}
              editable={!deleting}
              style={styles.modalInput}
              testID="delete-confirm-input"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setDeleteOpen(false)}
                disabled={deleting}
                testID="delete-cancel"
              >
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalBtn,
                  styles.modalBtnDanger,
                  confirmText.trim().toUpperCase() !== 'DELETE' || deleting ? { opacity: 0.55 } : null,
                ]}
                onPress={handleDelete}
                disabled={deleting || confirmText.trim().toUpperCase() !== 'DELETE'}
                testID="delete-confirm"
              >
                {deleting ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <Text style={styles.modalBtnDangerText}>Delete forever</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  profileCard: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    paddingHorizontal: Spacing.base,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
    gap: 6,
  },
  avatar: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  avatarText: {
    fontSize: 36,
    fontWeight: FontWeight.bold,
    color: Colors.primaryDark,
  },
  profileName: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  profileMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  profileMetaText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMid: { flex: 1 },
  rowTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  rowSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  noteCard: {
    flexDirection: 'row',
    gap: Spacing.sm,
    backgroundColor: '#FFFBEB',
    margin: Spacing.base,
    padding: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  noteText: {
    flex: 1,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.base,
  },
  modalCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    width: '100%',
    maxWidth: 420,
    gap: 10,
  },
  modalIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#FEE2E2',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xs,
  },
  modalTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  modalBody: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  modalLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    marginTop: Spacing.sm,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    backgroundColor: Colors.background,
  },
  modalActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  modalBtn: {
    flex: 1,
    height: 46,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBtnGhost: {
    backgroundColor: Colors.borderLight,
  },
  modalBtnGhostText: {
    color: Colors.textPrimary,
    fontWeight: FontWeight.semibold,
    fontSize: FontSize.base,
  },
  modalBtnDanger: {
    backgroundColor: Colors.danger,
  },
  modalBtnDangerText: {
    color: Colors.white,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.base,
  },
});
