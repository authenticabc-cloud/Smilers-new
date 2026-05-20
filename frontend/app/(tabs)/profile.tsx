import React, { useCallback, useEffect, useState } from 'react';
import {
  ActionSheetIOS,
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
import { Ionicons, Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useConvex, useMutation, useQuery } from 'convex/react';
import * as ImagePicker from 'expo-image-picker';
import Header from '../../src/components/Header';
import Avatar from '../../src/components/Avatar';
import SosButton from '../../src/components/SosButton';
import { api } from '../../src/convexApi';
import { getLanguageByCode } from '../../src/lib/languages';
import { useAuth } from '../../src/providers/AuthProvider';
import { uploadFile } from '../../src/lib/uploadFile';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../../src/theme';

type EditableField = 'name' | 'about';

interface FieldConfig {
  title: string;
  placeholder: string;
  multiline: boolean;
  maxLength: number;
}

const FIELD_CONFIG: Record<EditableField, FieldConfig> = {
  name: {
    title: 'Your name',
    placeholder: 'Enter your name',
    multiline: false,
    maxLength: 60,
  },
  about: {
    title: 'About',
    placeholder: 'Add a few words about yourself',
    multiline: true,
    maxLength: 140,
  },
};

export default function ProfileScreen() {
  const router = useRouter();
  const { userInfo } = useAuth();
  const me = useQuery(api.users.getCurrentUser);
  const convex = useConvex();
  const updateProfile = useMutation(api.users.updateProfile);

  const [uploading, setUploading] = useState(false);
  const [editingField, setEditingField] = useState<EditableField | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  const name = me?.name || userInfo?.name || 'Smilers';
  const email = me?.email || userInfo?.email || '';
  const about = me?.about || 'Hey there! I am using Smilers.';
  const language = getLanguageByCode(me?.preferredLanguage || '')?.name || 'No preference — show original';
  const avatarUri = (me as any)?.avatarUrl || (me as any)?.photoUrl || undefined;

  const openEditor = useCallback(
    (field: EditableField) => {
      setEditingField(field);
      if (field === 'name') setEditValue(me?.name || '');
      else if (field === 'about') setEditValue(me?.about || '');
    },
    [me?.name, me?.about],
  );

  const closeEditor = useCallback(() => {
    setEditingField(null);
    setEditValue('');
  }, []);

  const saveField = useCallback(async () => {
    if (!editingField) return;
    const trimmed = editValue.trim();
    if (editingField === 'name' && !trimmed) {
      Alert.alert('Name required', 'Your display name cannot be empty.');
      return;
    }
    setSaving(true);
    try {
      await updateProfile({ [editingField]: trimmed });
      closeEditor();
    } catch (errorValue: any) {
      Alert.alert(
        'Could not save',
        errorValue?.message || 'Please check your connection and try again.',
      );
    } finally {
      setSaving(false);
    }
  }, [closeEditor, editValue, editingField, updateProfile]);

  const goToLanguagePicker = useCallback(() => {
    router.push('/message-language' as any);
  }, [router]);

  const performUpload = useCallback(
    async (uri: string, mime: string) => {
      setUploading(true);
      try {
        const storageId = await uploadFile(convex, uri, mime);
        // Per Smilers backend contract: `avatar` field accepts a storageId
        // string and `getCurrentUser` auto-resolves it to a URL.
        await updateProfile({ avatar: storageId });
      } catch (errorValue: any) {
        const detail =
          errorValue?.data?.message ||
          errorValue?.message ||
          'Could not upload your profile picture. Please check your connection and try again.';
        Alert.alert('Upload failed', detail);
      } finally {
        setUploading(false);
      }
    },
    [convex, updateProfile],
  );

  const pickFromLibrary = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        'Photo access needed',
        'Allow Smilers to access your photos in your device settings to change your profile picture.',
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled || !result.assets || !result.assets[0]) return;
    const asset = result.assets[0];
    await performUpload(asset.uri, asset.mimeType || 'image/jpeg');
  }, [performUpload]);

  const pickFromCamera = useCallback(async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        'Camera access needed',
        'Allow Smilers to access your camera in your device settings to take a profile picture.',
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled || !result.assets || !result.assets[0]) return;
    const asset = result.assets[0];
    await performUpload(asset.uri, asset.mimeType || 'image/jpeg');
  }, [performUpload]);

  const onPressCameraBadge = useCallback(() => {
    if (uploading) return;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: 'Change profile picture',
          options: ['Take photo', 'Choose from library', 'Cancel'],
          cancelButtonIndex: 2,
        },
        (idx) => {
          if (idx === 0) void pickFromCamera();
          else if (idx === 1) void pickFromLibrary();
        },
      );
    } else {
      Alert.alert(
        'Change profile picture',
        undefined,
        [
          { text: 'Take photo', onPress: pickFromCamera },
          { text: 'Choose from library', onPress: pickFromLibrary },
          { text: 'Cancel', style: 'cancel' },
        ],
        { cancelable: true },
      );
    }
  }, [pickFromCamera, pickFromLibrary, uploading]);

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="profile-screen">
      <Header title="Profile" variant="dark" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.avatarSection}>
          <View style={styles.avatarWrap}>
            <Avatar name={name} size={120} uri={avatarUri} />
            <TouchableOpacity
              style={styles.cameraBadge}
              onPress={onPressCameraBadge}
              activeOpacity={0.8}
              disabled={uploading}
              testID="profile-camera-btn"
            >
              {uploading ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <Feather name="camera" size={16} color={Colors.white} />
              )}
            </TouchableOpacity>
          </View>
        </View>

        <Section label="YOUR NAME">
          <Row value={name} onEdit={() => openEditor('name')} testID="profile-name" />
        </Section>

        <Section label="ABOUT">
          <Row value={about} onEdit={() => openEditor('about')} testID="profile-about" />
        </Section>

        <Section
          label="MESSAGE LANGUAGE"
          icon={<Feather name="globe" size={14} color={Colors.primary} />}
          helper="All messages you receive will be auto-translated into this language."
        >
          <Row value={language} onEdit={goToLanguagePicker} testID="profile-language" />
        </Section>

        <Section label="EMAIL">
          <Row value={email} editable={false} testID="profile-email" />
        </Section>

        <View style={styles.buttonsBlock}>
          <TouchableOpacity
            style={styles.linkBtn}
            onPress={() => router.push('/starred' as any)}
            testID="starred-btn"
          >
            <Ionicons name="star-outline" size={20} color={Colors.primary} />
            <Text style={styles.linkText}>Starred Messages</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.linkBtn}
            onPress={() => router.push('/settings')}
            testID="settings-privacy-btn"
          >
            <Ionicons name="settings-outline" size={20} color={Colors.primary} />
            <Text style={styles.linkText}>Settings & Privacy</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 80 }} />
      </ScrollView>
      <SosButton onPress={() => router.push('/emergency' as any)} />

      {/* Edit-field modal (Name / About) */}
      <Modal
        visible={editingField !== null}
        animationType="slide"
        transparent
        onRequestClose={closeEditor}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalRoot}
        >
          <TouchableOpacity
            style={styles.modalBackdrop}
            activeOpacity={1}
            onPress={closeEditor}
            testID="edit-field-backdrop"
          />
          <View style={styles.modalSheet}>
            <View style={styles.modalHandleWrap}>
              <View style={styles.modalHandle} />
            </View>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>
                {editingField ? FIELD_CONFIG[editingField].title : ''}
              </Text>
              <TouchableOpacity onPress={closeEditor} hitSlop={10} testID="edit-field-close">
                <Ionicons name="close" size={24} color={Colors.textPrimary} />
              </TouchableOpacity>
            </View>
            {editingField ? (
              <>
                <TextInput
                  value={editValue}
                  onChangeText={setEditValue}
                  placeholder={FIELD_CONFIG[editingField].placeholder}
                  placeholderTextColor={Colors.textMuted}
                  style={[
                    styles.modalInput,
                    FIELD_CONFIG[editingField].multiline ? styles.modalInputMulti : null,
                  ]}
                  multiline={FIELD_CONFIG[editingField].multiline}
                  maxLength={FIELD_CONFIG[editingField].maxLength}
                  autoFocus
                  testID="edit-field-input"
                />
                <View style={styles.modalCounterRow}>
                  <Text style={styles.modalCounter}>
                    {editValue.length}/{FIELD_CONFIG[editingField].maxLength}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.modalSaveBtn, saving ? styles.modalSaveBtnDisabled : null]}
                  onPress={saveField}
                  disabled={saving}
                  activeOpacity={0.85}
                  testID="edit-field-save"
                >
                  {saving ? (
                    <ActivityIndicator color={Colors.headerBg} />
                  ) : (
                    <Text style={styles.modalSaveText}>Save</Text>
                  )}
                </TouchableOpacity>
              </>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function Section({
  label,
  icon,
  helper,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionLabelRow}>
        {icon}
        <Text style={styles.sectionLabel}>{label}</Text>
      </View>
      {helper ? <Text style={styles.helper}>{helper}</Text> : null}
      {children}
    </View>
  );
}

function Row({
  value,
  editable = true,
  onEdit,
  testID,
}: {
  value: string;
  editable?: boolean;
  onEdit?: () => void;
  testID?: string;
}) {
  const content = (
    <View style={styles.valueRow} testID={testID}>
      <Text style={styles.valueText} numberOfLines={2}>
        {value}
      </Text>
      {editable ? <Feather name="edit-2" size={16} color={Colors.textMuted} /> : null}
    </View>
  );
  if (editable && onEdit) {
    return (
      <TouchableOpacity onPress={onEdit} activeOpacity={0.7} testID={testID ? `${testID}-edit` : undefined}>
        {content}
      </TouchableOpacity>
    );
  }
  return content;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scroll: { paddingBottom: Spacing.xxl },
  avatarSection: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    backgroundColor: Colors.surface,
  },
  avatarWrap: { position: 'relative' },
  cameraBadge: {
    position: 'absolute',
    right: 0,
    bottom: 5,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: Colors.surface,
    ...Shadow.sm,
  },
  section: {
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.base,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: Spacing.sm,
  },
  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.primary,
    letterSpacing: 1,
  },
  helper: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.sm,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
  },
  valueText: {
    flex: 1,
    fontSize: FontSize.lg,
    color: Colors.textPrimary,
    fontWeight: FontWeight.regular,
  },
  buttonsBlock: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.base,
    gap: 10,
  },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    borderRadius: Radius.lg,
  },
  linkText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },

  /* Edit-field modal */
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  modalSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    paddingHorizontal: Spacing.base,
    paddingTop: 6,
    paddingBottom: Spacing.xl,
    ...Shadow.lg,
  },
  modalHandleWrap: {
    alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  modalHandle: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
  },
  modalHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
  },
  modalTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  modalInput: {
    marginTop: Spacing.md,
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    backgroundColor: Colors.background,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  modalInputMulti: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  modalCounterRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 6,
  },
  modalCounter: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  modalSaveBtn: {
    marginTop: Spacing.lg,
    backgroundColor: Colors.primary,
    paddingVertical: 14,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  modalSaveBtnDisabled: {
    opacity: 0.6,
  },
  modalSaveText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.headerBg,
  },
});
