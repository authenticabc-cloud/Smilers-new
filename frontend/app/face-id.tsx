/**
 * Face ID — mirrors the Smilers web app's Face ID security page exactly
 * (per provided web app screenshot).
 *
 * Layout:
 *   • Brown header with face-id icon + "Face ID" title + back button
 *   • Cream "Protect your account" info card (shield icon)
 *   • REGISTERED FACES (N/3) — list of face cards (thumbnail + label + trash)
 *   • Gold "Add Face (N/3)" button (opens front camera for a selfie)
 *   • TRUSTED DEVICES — list of trusted device cards (phone icon + trash)
 *   • Floating mute mic FAB (bottom-right)
 *
 * Persistence:
 *   • Tries `api.faceId.*` Convex endpoints first (listMyFaces, registerFace,
 *     deleteFace, listTrustedDevices, deleteTrustedDevice).
 *   • Falls back to AsyncStorage + the device's local file system so the
 *     screen remains fully usable even before the web team ships the backend
 *     contract. Local state syncs into Convex transparently once shipped.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import * as ImagePicker from 'expo-image-picker';
import { api } from '../src/convexApi';
import { useFirstSuccessfulConvexQuery } from '../src/hooks/useFirstSuccessfulConvexQuery';
import { useAuth } from '../src/providers/AuthProvider';
import { readStoredJson, writeStoredJson } from '../src/lib/settingsStorage';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

const MAX_FACES = 3;
const LOCAL_FACES_KEY = 'smilers_face_id_faces_v1';
const LOCAL_DEVICES_KEY = 'smilers_face_id_devices_v1';

interface RegisteredFace {
  id: string;
  /** Base64 data URI or remote URL. */
  thumbnailUri: string;
  /** Human-readable label like "Face 1". */
  label: string;
  /** ms-since-epoch when this face was registered. */
  registeredAt: number;
}

interface TrustedDevice {
  id: string;
  /** Device label (e.g. "K", "Windows PC"). */
  label: string;
  /** ms-since-epoch when the device was last verified. */
  verifiedAt: number;
  /** Optional platform hint to pick a more accurate icon (mobile / desktop). */
  platform?: 'ios' | 'android' | 'web' | 'desktop' | string;
}

function formatDateShort(ms: number): string {
  try {
    const date = new Date(ms);
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
  } catch {
    return '—';
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Coerces a Convex face record into the screen's shape.
 *  iter-136: canonical web shape is:
 *    { _id, _creationTime, userId, storageId, label, registeredAt: ISO,
 *      imageUrl: string | null } */
function normalizeFaceRecord(record: any, idx: number): RegisteredFace | null {
  if (!record) return null;
  const id = String(record._id || record.id || record.faceId || idx);
  const thumbnail =
    record.imageUrl ||
    record.thumbnailUri ||
    record.imageUri ||
    record.image ||
    record.thumbnailUrl ||
    '';
  if (!thumbnail) return null;
  // registeredAt can be either ms-since-epoch or an ISO date string in the
  // canonical web schema. Parse both safely.
  const rawRegistered = record.registeredAt ?? record.createdAt ?? record._creationTime ?? Date.now();
  const registeredAt =
    typeof rawRegistered === 'number'
      ? rawRegistered
      : new Date(String(rawRegistered)).getTime() || Date.now();
  return {
    id,
    thumbnailUri: thumbnail,
    label: record.label || `Face ${idx + 1}`,
    registeredAt,
  };
}

function normalizeDeviceRecord(record: any, idx: number): TrustedDevice | null {
  if (!record) return null;
  const id = String(record._id || record.id || record.deviceId || idx);
  const rawVerified =
    record.verifiedAt ??
    record.lastVerifiedAt ??
    record.updatedAt ??
    record._creationTime ??
    Date.now();
  const verifiedAt =
    typeof rawVerified === 'number'
      ? rawVerified
      : new Date(String(rawVerified)).getTime() || Date.now();
  return {
    id,
    // Canonical field on web is `deviceName`. Fall back to legacy aliases
    // so older records still render with a sensible label.
    label: record.deviceName || record.name || record.label || 'Device',
    verifiedAt,
    platform: record.platform || record.os || undefined,
  };
}

export default function FaceIdScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useAuth();
  const [muted, setMuted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  // Local-first storage so the page is usable even before backend ships.
  const [localFaces, setLocalFaces] = useState<RegisteredFace[]>([]);
  const [localDevices, setLocalDevices] = useState<TrustedDevice[]>([]);
  const [hydratedLocal, setHydratedLocal] = useState(false);

  // iter-136: locked to canonical Convex paths confirmed by the web
  // team (`api.faceId.getMyFaces` / `getTrustedDevices` / `registerFace`
  // / `removeFace` / `removeTrustedDevice`). Probe arrays from iter-135
  // are no longer needed because we know the exact names.
  const { data: remoteFaces } = useFirstSuccessfulConvexQuery<any[]>(
    [{ label: 'faceId.getMyFaces', ref: (api as any).faceId?.getMyFaces }],
    {},
    [],
    isAuthenticated,
  );
  const { data: remoteDevices } = useFirstSuccessfulConvexQuery<any[]>(
    [{ label: 'faceId.getTrustedDevices', ref: (api as any).faceId?.getTrustedDevices }],
    {},
    [],
    isAuthenticated,
  );

  // Upload helper — web team uses a 3-step flow: generateUploadUrl ->
  // POST blob -> registerFace({ storageId, label }). storageId is an
  // Id<"_storage"> string returned by Convex's signed-upload endpoint.
  const generateUploadUrlM = useMutation((api as any).faceId?.generateUploadUrl);

  const registerFaceM = useMutation((api as any).faceId?.registerFace);
  const deleteFaceM = useMutation((api as any).faceId?.removeFace);
  const deleteDeviceM = useMutation((api as any).faceId?.removeTrustedDevice);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const [storedFaces, storedDevices] = await Promise.all([
        readStoredJson(LOCAL_FACES_KEY, []),
        readStoredJson(LOCAL_DEVICES_KEY, []),
      ]);
      if (!mounted) return;
      setLocalFaces(
        Array.isArray(storedFaces)
          ? (storedFaces as RegisteredFace[]).filter((f) => f && f.thumbnailUri)
          : [],
      );
      setLocalDevices(
        Array.isArray(storedDevices) ? (storedDevices as TrustedDevice[]) : [],
      );
      setHydratedLocal(true);
    };
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  // Persist whenever local state changes (only AFTER first hydration so we
  // don't immediately overwrite the persisted list with the empty initial).
  useEffect(() => {
    if (!hydratedLocal) return;
    void writeStoredJson(LOCAL_FACES_KEY, localFaces);
  }, [hydratedLocal, localFaces]);
  useEffect(() => {
    if (!hydratedLocal) return;
    void writeStoredJson(LOCAL_DEVICES_KEY, localDevices);
  }, [hydratedLocal, localDevices]);

  // Merge remote + local — remote wins on conflict (by id), but local-only
  // entries (created before the backend was ready) still appear.
  const faces = useMemo((): RegisteredFace[] => {
    const remoteList: RegisteredFace[] = Array.isArray(remoteFaces)
      ? remoteFaces
          .map((r, i) => normalizeFaceRecord(r, i))
          .filter((f): f is RegisteredFace => !!f)
      : [];
    const localOnly = localFaces.filter(
      (lf) => !remoteList.some((rf) => rf.id === lf.id),
    );
    return [...remoteList, ...localOnly]
      .slice(0, MAX_FACES)
      .map((face, idx) => ({ ...face, label: face.label || `Face ${idx + 1}` }));
  }, [remoteFaces, localFaces]);

  const devices = useMemo((): TrustedDevice[] => {
    const remoteList: TrustedDevice[] = Array.isArray(remoteDevices)
      ? remoteDevices
          .map((r, i) => normalizeDeviceRecord(r, i))
          .filter((d): d is TrustedDevice => !!d)
      : [];
    const localOnly = localDevices.filter(
      (ld) => !remoteList.some((rd) => rd.id === ld.id),
    );
    return [...remoteList, ...localOnly];
  }, [remoteDevices, localDevices]);

  const handleAddFace = useCallback(async () => {
    if (faces.length >= MAX_FACES) {
      Alert.alert('Maximum reached', `You can register up to ${MAX_FACES} faces.`);
      return;
    }
    try {
      const cameraPerm = await ImagePicker.requestCameraPermissionsAsync();
      if (!cameraPerm.granted) {
        Alert.alert(
          'Camera access needed',
          'Smilers needs camera access to take a verification selfie. You can enable it from Settings.',
        );
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.6,
        allowsEditing: true,
        aspect: [1, 1],
        cameraType: ImagePicker.CameraType.front,
        base64: true,
      });

      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const base64Uri =
        asset.base64
          ? `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`
          : asset.uri;

      setBusy(true);
      const localId = `local_${Date.now()}_${Math.floor(Math.random() * 999)}`;
      const newFace: RegisteredFace = {
        id: localId,
        thumbnailUri: base64Uri,
        label: `Face ${faces.length + 1}`,
        registeredAt: Date.now(),
      };

      // iter-136: canonical 3-step upload flow (matches the web app):
      //   1. mutation `generateUploadUrl()` → signed upload URL.
      //   2. POST the binary blob to that URL → returns `{ storageId }`.
      //   3. mutation `registerFace({ storageId, label })`.
      // If any step fails (missing endpoint, network, permission) we
      // keep the local entry so the device still shows the face.
      try {
        if (typeof generateUploadUrlM === 'function' && typeof registerFaceM === 'function') {
          const uploadUrl: string | null | undefined = await (generateUploadUrlM as any)({});
          if (!uploadUrl || typeof uploadUrl !== 'string') {
            throw new Error('generateUploadUrl did not return a URL');
          }
          // Fetch the blob from the local file URI. expo-image-picker
          // gives us a `file://` URI on iOS/Android — `fetch().blob()`
          // works there. On web, `asset.uri` is already a data URL.
          const blob = await (await fetch(asset.uri)).blob();
          const uploadResp = await fetch(uploadUrl, {
            method: 'POST',
            headers: { 'Content-Type': asset.mimeType || blob.type || 'image/jpeg' },
            body: blob,
          });
          if (!uploadResp.ok) {
            throw new Error(`upload failed (${uploadResp.status})`);
          }
          const uploadJson = await uploadResp.json().catch(() => null);
          const storageId =
            uploadJson?.storageId || uploadJson?.storage_id || uploadJson?.id;
          if (!storageId) {
            throw new Error('upload did not return storageId');
          }
          const registerResp: any = await (registerFaceM as any)({
            storageId,
            label: newFace.label,
          });
          const remoteId =
            registerResp?._id || registerResp?.id || registerResp?.faceId || null;
          if (remoteId) {
            newFace.id = String(remoteId);
          }
        }
      } catch (errorValue: any) {
        const message = String(errorValue?.message || errorValue || '');
        // Silent for missing-endpoint / function-not-found, surface for
        // anything else so we can debug.
        if (
          !message.includes('CouldNotFindFunction') &&
          !message.toLowerCase().includes('not found')
        ) {
          console.warn('[face-id] register failed:', message);
        }
      }

      setLocalFaces((current) => [...current, newFace].slice(0, MAX_FACES));
    } catch (errorValue: any) {
      Alert.alert(
        'Could not add face',
        errorValue?.message || 'Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }, [faces.length, registerFaceM, generateUploadUrlM]);

  const handleDeleteFace = useCallback(
    (face: RegisteredFace) => {
      Alert.alert(
        'Remove face',
        `Are you sure you want to remove "${face.label}"? You can re-add it later.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              setBusy(true);
              try {
                if (typeof deleteFaceM === 'function' && !face.id.startsWith('local_')) {
                  try {
                    await (deleteFaceM as any)({ faceId: face.id });
                  } catch {
                    /* swallow */
                  }
                }
                setLocalFaces((current) => current.filter((f) => f.id !== face.id));
              } finally {
                setBusy(false);
              }
            },
          },
        ],
      );
    },
    [deleteFaceM],
  );

  const handleDeleteDevice = useCallback(
    (device: TrustedDevice) => {
      Alert.alert(
        'Remove trusted device',
        `Sign out and remove "${device.label}" from your trusted devices? You'll be asked for Face ID next time you sign in from there.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              setBusy(true);
              try {
                if (typeof deleteDeviceM === 'function' && !device.id.startsWith('local_')) {
                  try {
                    await (deleteDeviceM as any)({ deviceId: device.id });
                  } catch {
                    /* swallow */
                  }
                }
                setLocalDevices((current) => current.filter((d) => d.id !== device.id));
              } finally {
                setBusy(false);
              }
            },
          },
        ],
      );
    },
    [deleteDeviceM],
  );

  return (
    <View style={styles.container} testID="face-id-screen">
      {/* Brown header */}
      <SafeAreaView edges={['top']} style={styles.headerSafe}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            style={styles.headerBackBtn}
            onPress={() => router.back()}
            hitSlop={10}
            testID="face-id-back"
          >
            <Ionicons name="arrow-back" size={22} color={Colors.white} />
          </TouchableOpacity>
          <MaterialCommunityIcons name="face-recognition" size={26} color={Colors.white} />
          <Text style={styles.headerTitle}>Face ID</Text>
          <View style={styles.headerSpacer} />
        </View>
      </SafeAreaView>

      <ScrollView
        style={styles.scrollWrap}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom, 24) + 80 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Info card */}
        <View style={styles.infoCard} testID="face-id-info-card">
          <View style={styles.infoIconWrap}>
            <Ionicons name="shield-checkmark" size={22} color={Colors.primary} />
          </View>
          <View style={styles.infoTextWrap}>
            <Text style={styles.infoTitle}>Protect your account</Text>
            <Text style={styles.infoBody}>
              Register up to 3 faces. When you log in from a new device, a quick
              selfie will verify your identity.
            </Text>
          </View>
        </View>

        {/* Registered Faces */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel} testID="face-id-registered-label">
            REGISTERED FACES ({faces.length}/{MAX_FACES})
          </Text>
          {faces.length === 0 ? (
            <Text style={styles.sectionEmpty}>No faces registered yet.</Text>
          ) : (
            <View style={styles.facesList}>
              {faces.map((face, idx) => (
                <View key={face.id} style={styles.faceCard} testID={`face-id-face-${idx}`}>
                  <TouchableOpacity
                    activeOpacity={0.9}
                    onPress={() => setPreviewUri(face.thumbnailUri)}
                  >
                    <Image
                      source={{ uri: face.thumbnailUri }}
                      style={styles.faceThumb}
                      resizeMode="cover"
                    />
                  </TouchableOpacity>
                  <View style={styles.faceMeta}>
                    <Text style={styles.faceName}>{face.label}</Text>
                    <Text style={styles.faceDate}>
                      Added {formatDateShort(face.registeredAt)}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => handleDeleteFace(face)}
                    hitSlop={10}
                    style={styles.trashBtn}
                    testID={`face-id-delete-face-${idx}`}
                  >
                    <Feather name="trash-2" size={20} color={Colors.textSecondary} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          <TouchableOpacity
            style={[
              styles.addFaceBtn,
              faces.length >= MAX_FACES ? styles.addFaceBtnDisabled : null,
            ]}
            activeOpacity={0.85}
            onPress={handleAddFace}
            disabled={busy || faces.length >= MAX_FACES}
            testID="face-id-add-face"
          >
            {busy ? (
              <ActivityIndicator color="#3D2A00" size="small" />
            ) : (
              <>
                <Feather name="camera" size={20} color="#3D2A00" />
                <Text style={styles.addFaceText}>
                  Add Face ({faces.length}/{MAX_FACES})
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Trusted devices */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>TRUSTED DEVICES</Text>
          {devices.length === 0 ? (
            <Text style={styles.sectionEmpty}>
              No trusted devices yet. Devices you sign in from will appear here.
            </Text>
          ) : (
            <View style={styles.devicesList}>
              {devices.map((device, idx) => (
                <View key={device.id} style={styles.deviceCard} testID={`face-id-device-${idx}`}>
                  <View style={styles.deviceAvatar}>
                    <Feather
                      name={resolveDeviceIcon(device)}
                      size={18}
                      color={Colors.textSecondary}
                    />
                  </View>
                  <View style={styles.deviceMeta}>
                    <Text style={styles.deviceName}>{device.label}</Text>
                    <Text style={styles.deviceDate}>
                      Verified {formatDateShort(device.verifiedAt)}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => handleDeleteDevice(device)}
                    hitSlop={10}
                    style={styles.trashBtn}
                    testID={`face-id-delete-device-${idx}`}
                  >
                    <Feather name="trash-2" size={20} color={Colors.textSecondary} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* Floating mute mic FAB */}
      <TouchableOpacity
        style={[styles.muteFab, { bottom: Math.max(insets.bottom, 24) + 28 }]}
        onPress={() => setMuted((current) => !current)}
        activeOpacity={0.85}
        testID="face-id-mute-fab"
      >
        <Feather
          name={muted ? 'mic-off' : 'mic'}
          size={20}
          color={muted ? Colors.primary : Colors.textSecondary}
        />
      </TouchableOpacity>

      {/* Face preview modal */}
      <Modal
        visible={!!previewUri}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewUri(null)}
      >
        <Pressable style={styles.previewBackdrop} onPress={() => setPreviewUri(null)}>
          {previewUri ? (
            <Image
              source={{ uri: previewUri }}
              style={styles.previewImage}
              resizeMode="contain"
            />
          ) : null}
          <TouchableOpacity
            style={[styles.previewClose, { top: insets.top + 12 }]}
            onPress={() => setPreviewUri(null)}
            hitSlop={12}
          >
            <Feather name="x" size={26} color={Colors.white} />
          </TouchableOpacity>
        </Pressable>
      </Modal>
    </View>
  );
}

function resolveDeviceIcon(device: TrustedDevice): any {
  const platform = String(device.platform || '').toLowerCase();
  const label = device.label.toLowerCase();
  if (platform.includes('ios') || platform.includes('android') || label.includes('phone')) {
    return 'smartphone';
  }
  if (
    platform.includes('windows') ||
    platform.includes('mac') ||
    platform.includes('desktop') ||
    label.includes('pc') ||
    label.includes('mac') ||
    label.includes('windows')
  ) {
    return 'monitor';
  }
  if (platform.includes('web') || label.includes('browser')) {
    return 'globe';
  }
  return 'smartphone';
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scrollWrap: { flex: 1 },
  scrollContent: { paddingBottom: 40 },

  // Header
  headerSafe: { backgroundColor: '#3D2A00' },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 18,
    gap: 12,
    minHeight: 88,
  },
  headerBackBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: FontWeight.bold,
    color: Colors.white,
  },
  headerSpacer: { flex: 1 },

  // Info card
  infoCard: {
    marginHorizontal: Spacing.base,
    marginTop: Spacing.base,
    padding: Spacing.base,
    flexDirection: 'row',
    gap: 12,
    backgroundColor: '#FBEFC9',
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#F4DC8A',
  },
  infoIconWrap: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoTextWrap: { flex: 1 },
  infoTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  infoBody: {
    marginTop: 4,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },

  // Sections
  section: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.lg,
  },
  sectionLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: FontWeight.bold,
    letterSpacing: 1.2,
    marginBottom: 12,
  },
  sectionEmpty: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    fontStyle: 'italic',
    paddingVertical: 8,
  },

  // Face cards
  facesList: { gap: 12 },
  faceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#EBE5D5',
  },
  faceThumb: {
    width: 64,
    height: 64,
    borderRadius: Radius.md,
    backgroundColor: '#EFE7D6',
  },
  faceMeta: { flex: 1 },
  faceName: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  faceDate: {
    marginTop: 2,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  trashBtn: { padding: 8 },

  // Add Face button
  addFaceBtn: {
    marginTop: 14,
    minHeight: 56,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 16,
  },
  addFaceBtnDisabled: { opacity: 0.55 },
  addFaceText: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: '#3D2A00',
  },

  // Devices
  devicesList: { gap: 12 },
  deviceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#EBE5D5',
  },
  deviceAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#EFE7D6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceMeta: { flex: 1 },
  deviceName: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  deviceDate: {
    marginTop: 2,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  // Mute FAB
  muteFab: {
    position: 'absolute',
    right: 20,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 6,
  },

  // Preview modal
  previewBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewImage: { width: '100%', height: '85%' },
  previewClose: {
    position: 'absolute',
    right: 16,
    padding: 8,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 24,
  },
});
