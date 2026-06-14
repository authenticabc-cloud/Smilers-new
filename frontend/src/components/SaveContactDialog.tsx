/**
 * SaveContactDialog — iter-206
 *
 * Canonical spec: docs/SAVE_CONTACT_NATIVE_CONTRACT.md
 *
 *   • Mutation: `api.contacts.saveContact({ contactId, name?, saveToDevice? })`
 *   • `name` is OPTIONAL, max 80 chars (trimmed). Empty ⇒ omitted.
 *   • `saveToDevice` is a HINT — the backend never writes to the device
 *     address book. When the user picks "Phone & Smilers", THIS DIALOG
 *     is responsible for the device-book write via `expo-contacts`
 *     `Contacts.addContactAsync`. (The web version downloads a vCard;
 *     that's a browser-only fallback we deliberately don't replicate.)
 *   • If contacts permission is denied we keep the Smilers save and
 *     show a soft toast — never block the primary action.
 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import * as Contacts from 'expo-contacts';
import { api } from '../convexApi';
import { Colors, FontWeight, Spacing } from '../theme';

const NAME_MAX = 80;

type SaveTarget = 'both' | 'smilers-only';

interface Props {
  visible: boolean;
  onClose: () => void;
  contactId: string;
  /** Pre-filled nickname (the user's display name from the profile). */
  initialName?: string | null;
  /** For the post-save device-book write. */
  defaultPhone?: string | null;
  defaultEmail?: string | null;
  onSaved?: (result: any) => void;
}

export default function SaveContactDialog({
  visible,
  onClose,
  contactId,
  initialName,
  defaultPhone,
  defaultEmail,
  onSaved,
}: Props) {
  const saveContact = useMutation(api.contacts.saveContact);
  const [name, setName] = useState(initialName || '');
  const [target, setTarget] = useState<SaveTarget>('both');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setName(initialName || '');
      setTarget('both');
      setSaving(false);
    }
  }, [visible, initialName]);

  const handleSave = async () => {
    if (saving) return;
    const trimmed = name.trim();
    if (trimmed.length > NAME_MAX) {
      Alert.alert('Name too long', `Please keep the name within ${NAME_MAX} characters.`);
      return;
    }
    const saveToDevice = target === 'both';
    setSaving(true);
    try {
      // Step 1: write to Smilers (the canonical mutation). saveToDevice
      // is a hint the backend echoes back — it doesn't touch the
      // address book itself.
      const result: any = await saveContact({
        contactId: contactId as any,
        ...(trimmed ? { name: trimmed } : {}),
        saveToDevice,
      });

      // Step 2: optional device-book write. We do this AFTER the
      // Smilers save succeeds, and we never fail the whole action
      // when the device write fails / permission denied.
      if (saveToDevice) {
        try {
          const perm = await Contacts.requestPermissionsAsync();
          if (perm.status !== 'granted') {
            Alert.alert(
              'Saved to Smilers',
              `${result?.name || trimmed || 'Contact'} was saved on Smilers. We couldn\u2019t add to your phone contacts because permission was denied.`
            );
            onSaved?.(result);
            onClose();
            return;
          }
          const phone = String(result?.phone || defaultPhone || '').trim();
          const email = String(result?.email || defaultEmail || '').trim();
          const writeName = String(result?.name || trimmed || 'Contact').trim();
          await Contacts.addContactAsync({
            [Contacts.Fields.Name]: writeName,
            [Contacts.Fields.FirstName]: writeName,
            [Contacts.Fields.PhoneNumbers]: phone
              ? [{ label: 'mobile', number: phone }]
              : undefined,
            [Contacts.Fields.Emails]: email
              ? [{ label: 'home', email }]
              : undefined,
            contactType: Contacts.ContactTypes.Person,
          } as any);
          Alert.alert(
            'Contact saved',
            `${writeName} was saved to Smilers and added to your phone contacts.`
          );
        } catch {
          Alert.alert(
            'Saved to Smilers',
            `${result?.name || trimmed || 'Contact'} was saved on Smilers, but couldn\u2019t be added to your phone contacts.`
          );
        }
      } else {
        Alert.alert('Contact saved', `${result?.name || trimmed || 'Contact'} was saved on Smilers.`);
      }
      onSaved?.(result);
      onClose();
    } catch (errorValue: any) {
      const code = errorValue?.data?.code;
      const msg =
        code === 'BAD_REQUEST'
          ? 'You can\u2019t save yourself, or the name is too long (max 80 characters).'
          : errorValue?.data?.message || errorValue?.message || 'Could not save contact.';
      Alert.alert("Couldn\u2019t save", String(msg));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <MaterialCommunityIcons name="account-plus-outline" size={22} color={Colors.primary} />
            <Text style={styles.headerTitle}>Save contact</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} testID="save-contact-close">
              <Ionicons name="close" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Name to remember"
            placeholderTextColor={Colors.textSecondary}
            maxLength={NAME_MAX}
            testID="save-contact-name"
          />
          <Text style={styles.helper}>{name.trim().length}/{NAME_MAX}</Text>

          <Text style={[styles.label, { marginTop: 14 }]}>Save to</Text>
          <TargetRow
            selected={target === 'both'}
            onPress={() => setTarget('both')}
            icon="cellphone-link"
            title="Phone & Smilers"
            subtitle="Save here and in your phone\u2019s contacts."
            testID="save-target-both"
          />
          <TargetRow
            selected={target === 'smilers-only'}
            onPress={() => setTarget('smilers-only')}
            icon="cloud-outline"
            title="Smilers only"
            subtitle="Save here without touching your phone\u2019s contacts."
            testID="save-target-smilers"
          />

          <TouchableOpacity
            onPress={handleSave}
            disabled={saving}
            style={[styles.primaryBtn, saving ? styles.btnDisabled : null]}
            testID="save-contact-confirm"
          >
            {saving ? (
              <ActivityIndicator color={Colors.headerBg} />
            ) : (
              <Text style={styles.primaryBtnText}>Save</Text>
            )}
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function TargetRow({
  selected,
  onPress,
  icon,
  title,
  subtitle,
  testID,
}: {
  selected: boolean;
  onPress: () => void;
  icon: any;
  title: string;
  subtitle: string;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.targetRow, selected ? styles.targetRowOn : null]}
      testID={testID}
    >
      <View style={[styles.targetIcon, selected ? styles.targetIconOn : null]}>
        <MaterialCommunityIcons name={icon} size={20} color={selected ? '#FFFFFF' : Colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.targetTitle}>{title}</Text>
        <Text style={styles.targetSubtitle}>{subtitle}</Text>
      </View>
      <View style={[styles.radio, selected ? styles.radioOn : null]}>
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: Colors.background,
    borderRadius: 18,
    padding: Spacing.lg,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  closeBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  label: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    fontSize: 15,
    color: Colors.textPrimary,
  },
  helper: { fontSize: 11, color: Colors.textSecondary, alignSelf: 'flex-end', marginTop: 4 },
  targetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    marginTop: 8,
    borderRadius: 12,
    backgroundColor: 'rgba(60, 40, 0, 0.04)',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  targetRowOn: {
    backgroundColor: 'rgba(202, 138, 4, 0.08)',
    borderColor: Colors.primary,
  },
  targetIcon: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(202, 138, 4, 0.15)',
  },
  targetIconOn: { backgroundColor: Colors.primary },
  targetTitle: { fontSize: 14, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  targetSubtitle: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  radio: {
    width: 20, height: 20, borderRadius: 10, borderWidth: 1.5,
    borderColor: '#C7C7C7', alignItems: 'center', justifyContent: 'center',
  },
  radioOn: { borderColor: Colors.primary },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.primary },
  primaryBtn: {
    marginTop: 18,
    paddingVertical: 13,
    borderRadius: 999,
    backgroundColor: Colors.primary,
    alignItems: 'center',
  },
  primaryBtnText: { color: Colors.headerBg, fontWeight: '700', fontSize: 15 },
  btnDisabled: { opacity: 0.6 },
});
