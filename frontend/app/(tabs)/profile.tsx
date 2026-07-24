import React, { useCallback, useEffect, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useConvex, useMutation, useQuery } from 'convex/react';
import * as ImagePicker from 'expo-image-picker';
import { pickImageLibrary, pickCamera } from '../../src/lib/nativePickers';
import * as MediaLibrary from 'expo-media-library';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import Header from '../../src/components/Header';
import Avatar from '../../src/components/Avatar';
import SosButton from '../../src/components/SosButton';
import DriveModeToggle from '../../src/components/DriveModeToggle';
import { api } from '../../src/convexApi';
import { getLanguageByCode } from '../../src/lib/languages';
import { buildPersonalChatShareMessage } from '../../src/lib/personalChatLink';
import { useAuth } from '../../src/providers/AuthProvider';
import { uploadFile } from '../../src/lib/uploadFile';
import { safeMutation } from '../../src/lib/safeMutation';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../../src/theme';

/**
 * Coerce any value to a renderable string. Prevents Hermes
 * `TypeError: Cannot determine default value of object` when the backend
 * returns a non-string for a field we render in <Text>{...}</Text>.
 */
function safeString(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Object / array — never let Hermes coerce it directly.
  try {
    return fallback;
  } catch {
    return fallback;
  }
}

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
  const setAvatar = useMutation((api as any).users.setAvatar);

  const [uploading, setUploading] = useState(false);
  const [editingField, setEditingField] = useState<EditableField | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  // iter-224: tap profile photo → full-screen viewer with download.
  const [viewerOpen, setViewerOpen] = useState(false);
  const [savingPhoto, setSavingPhoto] = useState(false);

  const name = safeString(me?.name ?? userInfo?.name, 'Smilers');
  const email = safeString(me?.email ?? userInfo?.email, '');
  const about = safeString(me?.about, 'Hey there! I am using Smilers.');
  const language = safeString(
    getLanguageByCode(safeString(me?.preferredLanguage))?.name,
    'No preference — show original',
  );
  // Per backend spec: getCurrentUser auto-resolves storageId → URL on `avatar`.
  // Some backend revisions may temporarily return objects instead of strings —
  // we ONLY pass through string URIs to avoid Hermes TypeError on image loaders.
  const avatarUriRaw =
    (me as any)?.avatar ??
    (me as any)?.avatarUrl ??
    (me as any)?.photoUrl ??
    undefined;
  const avatarUri = typeof avatarUriRaw === 'string' && avatarUriRaw.length > 0
    ? avatarUriRaw
    : undefined;

  // iter-221: phone-number section (web parity). Web shows the verified
  // number above YOUR NAME. Prefer the human-friendly `phone` display value
  // and fall back to canonical `phoneE164` (per web backend guidance).
  const phone = safeString((me as any)?.phone ?? (me as any)?.phoneE164, '');
  const phoneVerified = Boolean((me as any)?.phoneVerified);

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
      const payload = { [editingField]: trimmed };
      await safeMutation(
        `users.updateProfile(${editingField})`,
        () => updateProfile(payload),
        payload,
      );
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
        // Web-team contract: the dedicated `users.setAvatar({ storageId })`
        // mutation is the correct path — it sets `avatarStorageId`, backfills
        // the legacy `avatar` URL, garbage-collects the old image, and returns
        // { url }. (`updateProfile({ avatar })` is the legacy URL-string path
        // and silently no-ops for a storage id.)
        const payload = { storageId };
        await safeMutation(
          'users.setAvatar',
          () => setAvatar(payload as any),
          payload,
        );
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
    [convex, setAvatar],
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
    const result = await pickImageLibrary({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.6,
      exif: false,
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
    const result = await pickCamera({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.6,
      exif: false,
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

  // iter-224: save the (full-size) profile photo to the device gallery.
  const saveProfilePhoto = useCallback(async () => {
    if (!avatarUri || savingPhoto) return;
    try {
      setSavingPhoto(true);
      let perm = await MediaLibrary.getPermissionsAsync();
      if (perm.status !== 'granted' && perm.canAskAgain) {
        perm = await MediaLibrary.requestPermissionsAsync();
      }
      if (perm.status !== 'granted') {
        Alert.alert(
          'Photo access needed',
          'Allow photo access to save the picture to your gallery.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ],
        );
        return;
      }
      let localUri = avatarUri;
      if (!avatarUri.startsWith('file://')) {
        const fs: any = LegacyFileSystem;
        const target = `${fs.cacheDirectory}smilers_profile_${Date.now()}.jpg`;
        if (avatarUri.startsWith('data:')) {
          const comma = avatarUri.indexOf(',');
          await fs.writeAsStringAsync(target, avatarUri.slice(comma + 1), { encoding: 'base64' });
        } else {
          const res = await fs.downloadAsync(avatarUri, target);
          if (res?.status && res.status >= 400) throw new Error('download failed');
        }
        localUri = target;
      }
      await MediaLibrary.saveToLibraryAsync(localUri);
      Alert.alert('Saved', 'Profile picture saved to your gallery.');
    } catch {
      Alert.alert('Could not save', 'Something went wrong saving the picture. Please try again.');
    } finally {
      setSavingPhoto(false);
    }
  }, [avatarUri, savingPhoto]);

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="profile-screen">
      <Header title="Profile" variant="dark" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.avatarSection}>
          <View style={styles.avatarWrap}>
            <TouchableOpacity
              activeOpacity={avatarUri ? 0.85 : 1}
              onPress={() => {
                if (avatarUri) setViewerOpen(true);
              }}
              testID="profile-avatar-open"
            >
              <Avatar name={name} size={120} uri={avatarUri} />
            </TouchableOpacity>
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

        {/* iter-224: full-screen profile-photo viewer with download */}
        <Modal
          visible={viewerOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setViewerOpen(false)}
        >
          <View style={styles.viewerBackdrop}>
            <TouchableOpacity
              style={styles.viewerClose}
              onPress={() => setViewerOpen(false)}
              hitSlop={12}
              testID="profile-viewer-close"
            >
              <Feather name="x" size={26} color={Colors.white} />
            </TouchableOpacity>
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.viewerImage} resizeMode="contain" />
            ) : null}
            <TouchableOpacity
              style={styles.viewerDownload}
              onPress={saveProfilePhoto}
              activeOpacity={0.85}
              disabled={savingPhoto}
              testID="profile-viewer-download"
            >
              {savingPhoto ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <Feather name="download" size={20} color={Colors.white} />
              )}
              <Text style={styles.viewerDownloadText}>
                {savingPhoto ? 'Saving…' : 'Save to gallery'}
              </Text>
            </TouchableOpacity>
          </View>
        </Modal>

        {phone ? (
          <Section
            label="PHONE NUMBER"
            icon={<Feather name="phone" size={14} color={Colors.primary} />}
          >
            <View style={styles.phoneRow}>
              <Text style={styles.phoneNumber} numberOfLines={1} testID="profile-phone">
                {phone}
              </Text>
              {phoneVerified ? (
                <View style={styles.verifiedPill} testID="profile-phone-verified">
                  <MaterialCommunityIcons name="shield-check" size={13} color="#15803D" />
                  <Text style={styles.verifiedText}>Verified</Text>
                </View>
              ) : null}
              <View style={styles.flexSpacer} />
              <TouchableOpacity
                onPress={() => router.push('/phone-verify' as any)}
                hitSlop={8}
                testID="profile-phone-edit"
              >
                <Feather name="edit-2" size={16} color={Colors.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={styles.phoneHelper}>
              Your phone number is how friends find and recognize you on Smilers.
            </Text>
          </Section>
        ) : null}

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
            style={styles.premiumBtn}
            onPress={() => router.push('/premium' as any)}
            testID="premium-btn"
            activeOpacity={0.85}
          >
            <MaterialCommunityIcons name="crown" size={20} color={Colors.primaryDark} />
            <Text style={styles.premiumBtnText}>Premium</Text>
          </TouchableOpacity>

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
            onPress={async () => {
              if (!me?._id) {
                Alert.alert('Not ready', 'Please wait a moment and try again.');
                return;
              }
              try {
                await Share.share({ message: buildPersonalChatShareMessage(me?.name, me._id) });
              } catch {
                /* user dismissed the share sheet */
              }
            }}
            testID="share-chat-link-btn"
          >
            <Ionicons name="link-outline" size={20} color={Colors.primary} />
            <Text style={styles.linkText}>Share my chat link</Text>
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
      <DriveModeToggle />

      {/* Edit-field modal (Name / About) */}
      <Modal
        visible={editingField !== null}
        animationType="slide"
        transparent
        onRequestClose={closeEditor}
      >
        <KeyboardAvoidingView
          behavior="padding"
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
  // Defense-in-depth: even though props are typed `string`, defensively
  // coerce here so a backend regression returning an object does NOT
  // surface as the Hermes "Cannot determine default value of object" crash.
  const displayValue =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '';
  const content = (
    <View style={styles.valueRow} testID={testID}>
      <Text style={styles.valueText} numberOfLines={2}>
        {displayValue}
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
  // iter-142: align Profile background with the web app — the entire
  // page is a uniform cream (`Colors.background`). Native previously
  // used `Colors.surface` (#FFFFFF) for the avatar block which created
  // a visible white "bar" at the top and made the cream sections below
  // appear comparatively grey.
  avatarSection: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    backgroundColor: Colors.background,
  },
  avatarWrap: { position: 'relative' },
  viewerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerClose: {
    position: 'absolute',
    top: 48,
    left: 20,
    zIndex: 2,
    padding: 6,
  },
  viewerImage: { width: '100%', height: '70%' },
  viewerDownload: {
    position: 'absolute',
    bottom: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.16)',
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: Radius.pill,
  },
  viewerDownloadText: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.base },
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
  // iter-221: cards restyled to MATCH THE WEB APP (user-provided screenshots):
  //   • Premium: pale gold fill + subtle gold border, gold crown + gold text,
  //     no chevron (flat — web has no shadow/arrow).
  //   • Starred + Settings: near-white subtle fill + hairline border, gold
  //     icon + dark text. (Native previously used a deep/solid yellow.)
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: '#FAF7EC',
    borderWidth: 1,
    borderColor: '#ECE7D8',
    paddingHorizontal: Spacing.base,
    paddingVertical: 16,
    borderRadius: Radius.lg,
  },
  linkText: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    letterSpacing: 0.2,
  },
  premiumBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: '#FBF1CD',
    borderWidth: 1,
    borderColor: '#EAD68C',
    paddingHorizontal: Spacing.base,
    paddingVertical: 16,
    borderRadius: Radius.lg,
  },
  premiumBtnText: {
    flex: 1,
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.primaryDark,
    letterSpacing: 0.2,
  },
  // iter-221: phone-number section (web parity).
  phoneRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  flexSpacer: { flex: 1 },
  phoneNumber: {
    fontSize: FontSize.lg,
    color: Colors.textPrimary,
    fontWeight: FontWeight.regular,
    flexShrink: 1,
  },
  verifiedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: Radius.pill,
  },
  verifiedText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, color: '#15803D' },
  phoneHelper: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: Spacing.sm,
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
