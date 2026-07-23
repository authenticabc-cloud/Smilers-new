import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Modal, Pressable, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery, useMutation, useConvex } from 'convex/react';
import * as ImagePicker from 'expo-image-picker';
import { pickImageLibrary } from '../../src/lib/nativePickers';
import Header from '../../src/components/Header';
import Avatar from '../../src/components/Avatar';
import { api } from '../../src/convexApi';
import { uploadFile } from '../../src/lib/uploadFile';
import { useDeviceContactIndex, lookupDeviceContactName } from '../../src/lib/deviceContactIndex';
import { getResolvedDisplayName, getSavedContactRecord } from '../../src/lib/displayName';
import { Colors, FontSize, FontWeight, Spacing, Shadow } from '../../src/theme';

export default function StatusScreen() {
  const router = useRouter();
  const convex = useConvex();
  const statusGroups = useQuery(api.statuses.listStatusGroups);
  const myStatuses = useQuery(api.statuses.getMyStatuses);
  const createStatus = useMutation(api.statuses.create);

  // iter-239: resolve each status author's name from the device address book
  // (e.g. "ABC Albania") instead of the Smilers/Google account name — same
  // resolver the chats list and status viewer use. Falls back to the Smilers
  // name when no device contact matches.
  const me = useQuery(api.users.getCurrentUser);
  const myContacts = useQuery(api.contacts.getContacts, {}) as any[] | undefined;
  const deviceIndex = useDeviceContactIndex();
  const resolveContactName = useCallback(
    (item: any): string => {
      const fallback = item?.name && String(item.name).trim() ? String(item.name) : 'Smilers user';
      const saved = item?.userId
        ? getSavedContactRecord(myContacts, { userId: item.userId }, me?._id)
        : null;
      const record = saved || { _id: item?.userId, name: fallback, phoneE164: item?.phoneE164, phone: item?.phone };
      return getResolvedDisplayName(record, deviceIndex, lookupDeviceContactName, fallback);
    },
    [myContacts, me, deviceIndex],
  );

  const [showSheet, setShowSheet] = useState(false);
  const [uploading, setUploading] = useState(false);

  const others: any[] = Array.isArray(statusGroups) ? statusGroups : [];
  const mine: any[] = Array.isArray(myStatuses) ? myStatuses : [];
  const data = [...others];

  const openSheet = () => setShowSheet(true);
  const closeSheet = () => setShowSheet(false);

  const pickAndUpload = useCallback(
    async (kind: 'image' | 'video') => {
      closeSheet();
      // Wait for the RN Modal (the "add status" sheet) to FULLY dismiss before
      // launching the native picker. On Android the Modal is a separate window;
      // launching expo-image-picker while that window is still tearing down
      // throws "Attempting to launch an unregistered ActivityResultLauncher"
      // (the ActivityResultLauncher is bound to the Activity, not the Modal
      // window that currently holds focus). A short delay past the fade
      // animation lets the Activity regain focus so the launcher is valid.
      await new Promise((resolve) => setTimeout(resolve, 450));
      try {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          Alert.alert('Permission required', 'Please allow media library access.');
          return;
        }

        const result = await pickImageLibrary({
          mediaTypes: kind === 'image' ? ImagePicker.MediaTypeOptions.Images : ImagePicker.MediaTypeOptions.Videos,
          quality: kind === 'image' ? 0.7 : 0.5,
          allowsEditing: false,
          videoMaxDuration: 60,
          exif: false,
        });

        if (result.canceled || !result.assets?.[0]) return;

        const asset = result.assets[0];
        setUploading(true);
        const mime = asset.mimeType || (kind === 'image' ? 'image/jpeg' : 'video/mp4');
        const storageId = await uploadFile(convex, asset.uri, mime);
        await createStatus({
          type: kind,
          storageId,
          mimeType: mime,
          width: asset.width,
          height: asset.height,
          duration: kind === 'video' ? Math.round((asset.duration || 0) / 1000) : undefined,
        });
      } catch (errorValue: any) {
        Alert.alert('Failed to post status', errorValue?.message || 'Unknown error');
      } finally {
        setUploading(false);
      }
    },
    [convex, createStatus]
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="status-screen">
      <Header title="Status" variant="dark" />

      <FlatList
        data={data}
        keyExtractor={(item: any, idx: number) => item.userId || String(idx)}
        contentContainerStyle={{ paddingBottom: 100 }}
        ListHeaderComponent={
          <>
            <TouchableOpacity
              style={styles.myRow}
              activeOpacity={0.7}
              onPress={() => {
                if (mine.length > 0) router.push('/status-view/me');
                else openSheet();
              }}
              onLongPress={openSheet}
              testID="my-status-row"
            >
              <View style={styles.myAvatarWrap}>
                <Avatar name="Me" size={52} />
                <TouchableOpacity style={styles.plusBadge} onPress={openSheet} testID="my-status-add">
                  <Feather name="plus" size={14} color={Colors.white} />
                </TouchableOpacity>
              </View>
              <View style={styles.rowMid}>
                <Text style={styles.rowName}>My Status</Text>
                <Text style={styles.rowSub}>
                  {mine.length > 0 ? `${mine.length} active update${mine.length === 1 ? '' : 's'}` : 'Tap to add status update'}
                </Text>
              </View>
              {uploading ? <ActivityIndicator color={Colors.primary} /> : null}
            </TouchableOpacity>
            {others.length > 0 && <Text style={styles.section}>RECENT UPDATES</Text>}
          </>
        }
        renderItem={({ item }) => {
          const displayName = resolveContactName(item);
          return (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.7}
              onPress={() => router.push(`/status-view/${item.userId}` as any)}
              testID={`status-row-${item.userId}`}
            >
              <View style={[styles.statusRing]}>
                <Avatar name={displayName} size={50} />
              </View>
              <View style={styles.rowMid}>
                <Text style={styles.rowName}>{displayName}</Text>
                <Text style={styles.rowSub}>{item.count || 1} update{(item.count || 1) === 1 ? '' : 's'}</Text>
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          statusGroups !== undefined ? (
            <View style={styles.empty}>
              <Ionicons name="disc-outline" size={36} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No updates yet</Text>
              <Text style={styles.emptySub}>Statuses you share will appear here for 24h</Text>
            </View>
          ) : null
        }
      />

      <TouchableOpacity style={styles.fab} onPress={openSheet} testID="status-fab" activeOpacity={0.85}>
        <Feather name="edit-2" size={20} color={Colors.white} />
      </TouchableOpacity>

      <Modal visible={showSheet} transparent animationType="fade" onRequestClose={closeSheet}>
        <Pressable style={styles.backdrop} onPress={closeSheet}>
          <Pressable style={styles.sheet} onPress={() => {}} testID="status-sheet">
            <View style={styles.grabber} />
            <Text style={styles.sheetTitle}>Share status</Text>
            <View style={styles.tileRow}>
              <Tile
                color="#7C3AED"
                icon="type"
                lib="feather"
                label="Text"
                onPress={() => {
                  closeSheet();
                  router.push('/status-compose');
                }}
                testID="status-text-tile"
              />
              <Tile
                color="#3B82F6"
                icon="image"
                lib="feather"
                label="Photo"
                onPress={() => pickAndUpload('image')}
                testID="status-photo-tile"
              />
              <Tile
                color="#EF4444"
                icon="video-outline"
                lib="mc"
                label="Video"
                onPress={() => pickAndUpload('video')}
                testID="status-video-tile"
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function Tile({
  color,
  icon,
  lib,
  label,
  onPress,
  testID,
}: {
  color: string;
  icon: string;
  lib: 'feather' | 'mc';
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  const Icon: any = lib === 'mc' ? MaterialCommunityIcons : Feather;

  return (
    <TouchableOpacity style={styles.tile} onPress={onPress} testID={testID} activeOpacity={0.8}>
      <View style={[styles.tileIcon, { backgroundColor: color }]}>
        <Icon name={icon as any} size={26} color={Colors.white} />
      </View>
      <Text style={styles.tileLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  myRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.base,
    gap: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  myAvatarWrap: { position: 'relative' },
  plusBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    backgroundColor: Colors.primary,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    padding: 0,
    borderColor: Colors.background,
  },
  section: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.primary,
    letterSpacing: 1,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.base,
    gap: Spacing.md,
  },
  statusRing: {
    padding: 2,
    borderRadius: 50,
    borderWidth: 2,
    borderColor: Colors.primary,
  },
  rowMid: { flex: 1 },
  rowName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  rowSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  // ─── Devotional broadcasts entry card (iter-100) ───
  devotionalCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.base,
    gap: Spacing.md,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
    marginBottom: Spacing.lg,
    backgroundColor: Colors.white,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  devotionalIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    alignItems: 'center',
    paddingTop: Spacing.xxl * 2,
    gap: 6,
  },
  emptyTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    marginTop: Spacing.sm,
  },
  emptySub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    paddingHorizontal: Spacing.lg,
    textAlign: 'center',
  },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.lg,
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: Spacing.sm,
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.xl,
    ...Shadow.lg,
  },
  grabber: {
    width: 40,
    height: 4,
    backgroundColor: Colors.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginVertical: Spacing.sm,
  },
  sheetTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginBottom: Spacing.lg,
    textAlign: 'center',
  },
  tileRow: { flexDirection: 'row', justifyContent: 'space-around', gap: Spacing.base },
  tile: { alignItems: 'center', gap: 8, flex: 1 },
  tileIcon: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
  tileLabel: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
});
