import React, { useMemo, useState } from 'react';
import {
  Alert,
  Dimensions,
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
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { useAuth } from '../../src/providers/AuthProvider';
import SaveContactDialog from '../../src/components/SaveContactDialog';
import {
  getDisplayInitials,
  getDisplayNameFromUser,
} from '../../src/lib/displayName';
import { formatLastSeenLabel } from '../../src/lib/presence';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../src/theme';

type MediaTab = 'photos' | 'videos' | 'files';

const SCREEN_W = Dimensions.get('window').width;
const GRID_GAP = 8;
const GRID_PADDING = Spacing.lg;
const GRID_COLS = 3;
const GRID_TILE = Math.floor(
  (SCREEN_W - GRID_PADDING * 2 - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS,
);

export default function UserProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { userId, conversationId } = useLocalSearchParams<{
    userId: string;
    conversationId?: string;
  }>();
  const { isAuthenticated } = useAuth();
  const hasValidUserId =
    typeof userId === 'string' && userId.length > 5;
  const hasValidConversationId =
    typeof conversationId === 'string' && conversationId.length > 5;

  const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);

  // --- Data ---------------------------------------------------------------
  const { data: user } = useSafeConvexQuery<any | null>(
    api.users.getUserById,
    userId ? { userId } : {},
    null,
    isAuthenticated && hasValidUserId,
  );

  // iter-206: detect whether the viewed user is already saved as a
  // contact. We hit `api.contacts.getContacts` (warm cache from chats
  // tab) and look for a row matching this userId. Drives the "Save"
  // action — per the canonical spec, Save is shown ONLY when
  // `isContact === false`.
  const myContacts = useQuery(api.contacts.getContacts, isAuthenticated ? {} : 'skip') as
    | any[]
    | undefined;
  const isContact = useMemo(() => {
    if (!Array.isArray(myContacts) || !userId) return null; // unknown while loading
    return myContacts.some(
      (c: any) => String(c?._id || c?.userId) === String(userId) && c?.contactStatus === 'accepted'
    );
  }, [myContacts, userId]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  // Shared media is sourced from the existing conversation messages.
  const { data: messagesPage } = useSafeConvexQuery<any>(
    api.messages.list,
    hasValidConversationId
      ? { conversationId, paginationOpts: { numItems: 200, cursor: null } }
      : { conversationId: '', paginationOpts: { numItems: 0, cursor: null } },
    null,
    isAuthenticated && hasValidConversationId,
  );

  // Groups in common — filter the user's conversations to groups that include
  // the target user as a participant.
  const { data: conversationsList } = useSafeConvexQuery<any[]>(
    api.conversations.listConversations,
    {},
    [],
    isAuthenticated,
  );

  const sharedMedia = useMemo(() => {
    const items: any[] = Array.isArray(messagesPage?.page)
      ? messagesPage.page
      : Array.isArray(messagesPage)
        ? (messagesPage as any[])
        : [];
    const photos = items.filter((m: any) => m?.type === 'image');
    const videos = items.filter((m: any) => m?.type === 'video');
    const files = items.filter(
      (m: any) => m?.type === 'file' || m?.type === 'document',
    );
    return { photos, videos, files };
  }, [messagesPage]);

  const groupsInCommon = useMemo(() => {
    if (!Array.isArray(conversationsList) || !hasValidUserId) return [];
    return conversationsList.filter((conv: any) => {
      if (!conv || conv.type !== 'group') return false;
      const memberIds = [
        ...(Array.isArray(conv?.participantIds) ? conv.participantIds : []),
        ...(Array.isArray(conv?.memberIds) ? conv.memberIds : []),
        ...(Array.isArray(conv?.participants)
          ? conv.participants.map(
              (p: any) => p?.userId || p?._id || p?.id || '',
            )
          : []),
        ...(Array.isArray(conv?.members)
          ? conv.members.map((p: any) => p?.userId || p?._id || p?.id || '')
          : []),
      ].filter(Boolean);
      return memberIds.map(String).includes(String(userId));
    });
  }, [conversationsList, hasValidUserId, userId]);

  // --- UI state -----------------------------------------------------------
  const [mediaTab, setMediaTab] = useState<MediaTab>('photos');
  const [muted, setMuted] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  // --- Derived ------------------------------------------------------------
  const displayName = getDisplayNameFromUser(user, 'Smilers user');
  const initials = getDisplayInitials(displayName);
  const avatarUri: string | null =
    user?.avatar || user?.avatarUrl || user?.photoURL || null;
  const aboutText =
    (typeof user?.about === 'string' && user.about) ||
    (typeof user?.bio === 'string' && user.bio) ||
    (typeof user?.status === 'string' && user.status) ||
    '';
  const lastSeenLabel = formatLastSeenLabel(user, 'last seen recently');
  const level: string =
    (typeof user?.level === 'string' && user.level) ||
    (typeof user?.tier === 'string' && user.tier) ||
    '';
  const engagementCount: number =
    Number(
      user?.engagements ??
        user?.engagementCount ??
        user?.engagements_count ??
        0,
    ) || 0;

  // --- Actions ------------------------------------------------------------
  const openChat = async () => {
    if (hasValidConversationId) {
      router.push(`/chat/${conversationId}` as any);
      return;
    }
    if (!userId) return;
    try {
      const result: any = await getOrCreateDirect({ otherUserId: userId });
      const newConvId =
        typeof result === 'string'
          ? result
          : result?._id || result?.conversationId;
      if (newConvId) {
        router.push(`/chat/${newConvId}` as any);
      }
    } catch (e: any) {
      Alert.alert('Could not open chat', e?.message || 'Try again later.');
    }
  };

  const openCall = (type: 'voice' | 'video') => {
    if (hasValidConversationId) {
      router.push(
        `/call/${conversationId}?type=${type}&displayName=${encodeURIComponent(
          displayName,
        )}` as any,
      );
      return;
    }
    Alert.alert(
      'Start a chat first',
      'Open a conversation with this contact before placing a call.',
    );
  };

  const handleBlock = () => {
    Alert.alert(
      `Block ${displayName}`,
      "They won't be able to send you messages or call you. You can unblock them at any time.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: () => Alert.alert('Blocked', `${displayName} has been blocked.`),
        },
      ],
    );
  };

  // --- Loading / fallback -------------------------------------------------
  if (!isAuthenticated || !hasValidUserId) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.fallbackWrap} testID="user-profile-fallback">
          <Feather
            name={!isAuthenticated ? 'lock' : 'alert-circle'}
            size={42}
            color={Colors.textMuted}
          />
          <Text style={styles.fallbackTitle}>
            {!isAuthenticated
              ? 'Sign in to view profiles'
              : 'User not found'}
          </Text>
          <Text style={styles.fallbackBody}>
            {!isAuthenticated
              ? 'Open this profile after signing in to Smilers.'
              : 'This user link looks invalid or incomplete.'}
          </Text>
          <TouchableOpacity
            style={styles.fallbackBtn}
            onPress={() => router.back()}
          >
            <Text style={styles.fallbackBtnText}>Go back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // --- Render -------------------------------------------------------------
  return (
    <View style={styles.container} testID="user-profile-screen">
      <ScrollView
        style={styles.scrollWrap}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom, 24) + 100 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Brown hero header */}
        <View style={[styles.hero, { paddingTop: insets.top + 16 }]} testID="user-profile-hero">
          <TouchableOpacity
            style={styles.heroBackBtn}
            onPress={() => router.back()}
            hitSlop={10}
            testID="user-profile-back"
          >
            <Ionicons name="arrow-back" size={22} color={Colors.white} />
          </TouchableOpacity>
        </View>

        {/* Floating avatar overlapping the brown/cream boundary */}
        <View style={styles.avatarWrap} testID="user-profile-avatar-wrap">
          <View style={styles.avatarRing}>
            {avatarUri ? (
              <Image
                source={{ uri: avatarUri }}
                style={styles.avatarImage}
                resizeMode="cover"
              />
            ) : (
              <Text style={styles.avatarInitial}>{initials}</Text>
            )}
          </View>
        </View>

        {/* Name + last seen */}
        <View style={styles.identityBlock}>
          <Text style={styles.name} numberOfLines={1} testID="user-profile-name">
            {displayName}
          </Text>
          <Text style={styles.lastSeen} numberOfLines={1} testID="user-profile-last-seen">
            {lastSeenLabel}
          </Text>

          {(level || engagementCount > 0) ? (
            <View style={styles.levelPill} testID="user-profile-level-pill">
              <MaterialCommunityIcons name="crown" size={14} color="#E11D48" />
              <Text style={styles.levelText}>
                {level ? `Level ${level}` : 'Member'}
              </Text>
              <View style={styles.levelDivider} />
              <Text style={styles.engagementText}>
                {engagementCount} {engagementCount === 1 ? 'engagement' : 'engagements'}
              </Text>
            </View>
          ) : null}

          {/* Action row */}
          <View style={styles.actionRow} testID="user-profile-actions">
            <ActionButton
              icon="message-square"
              label="Chat"
              onPress={openChat}
              testID="user-profile-chat-btn"
            />
            <ActionButton
              icon="phone"
              label="Call"
              onPress={() => openCall('voice')}
              testID="user-profile-call-btn"
            />
            <ActionButton
              icon="video"
              label="Video"
              onPress={() => openCall('video')}
              testID="user-profile-video-btn"
            />
            {/* iter-206 Save Contact (canonical: SAVE_CONTACT_NATIVE_CONTRACT.md).
                Only shown when the viewer hasn't saved this user yet —
                `isContact === false`. `null` means contacts list is
                still loading; we hide the button to avoid flicker. */}
            {isContact === false ? (
              <ActionButton
                icon="user-plus"
                label="Save"
                onPress={() => setShowSaveDialog(true)}
                testID="user-profile-save-btn"
              />
            ) : null}
          </View>
        </View>

        {/* ABOUT */}
        <View style={styles.sectionDivider} />
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>ABOUT</Text>
          <Text style={styles.sectionBody} testID="user-profile-about">
            {aboutText || 'No bio yet.'}
          </Text>
        </View>

        {/* GROUPS IN COMMON */}
        <View style={styles.sectionDivider} />
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            GROUPS IN COMMON ({groupsInCommon.length})
          </Text>
          {groupsInCommon.length === 0 ? (
            <Text style={styles.sectionEmpty}>No shared groups yet.</Text>
          ) : (
            <View style={styles.groupsList}>
              {groupsInCommon.map((group: any) => (
                <TouchableOpacity
                  key={group._id}
                  style={styles.groupRow}
                  activeOpacity={0.85}
                  onPress={() =>
                    router.push(`/group/${group._id}` as any)
                  }
                  testID={`user-profile-group-${group._id}`}
                >
                  <View style={styles.groupAvatar}>
                    {group?.avatar || group?.avatarUrl ? (
                      <Image
                        source={{ uri: group.avatar || group.avatarUrl }}
                        style={styles.groupAvatarImg}
                        resizeMode="cover"
                      />
                    ) : (
                      <Ionicons
                        name="people"
                        size={18}
                        color={Colors.primary}
                      />
                    )}
                  </View>
                  <Text style={styles.groupName} numberOfLines={1}>
                    {group?.name || 'Group'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* SHARED MEDIA */}
        <View style={styles.sectionDivider} />
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>SHARED MEDIA</Text>
          <View style={styles.mediaTabs}>
            <MediaTabBtn
              active={mediaTab === 'photos'}
              icon="image"
              label={`Photos (${sharedMedia.photos.length})`}
              onPress={() => setMediaTab('photos')}
              testID="user-profile-tab-photos"
            />
            <MediaTabBtn
              active={mediaTab === 'videos'}
              icon="film"
              label={`Videos (${sharedMedia.videos.length})`}
              onPress={() => setMediaTab('videos')}
              testID="user-profile-tab-videos"
            />
            <MediaTabBtn
              active={mediaTab === 'files'}
              icon="file-text"
              label={`Files (${sharedMedia.files.length})`}
              onPress={() => setMediaTab('files')}
              testID="user-profile-tab-files"
            />
          </View>

          <MediaGrid
            tab={mediaTab}
            items={
              mediaTab === 'photos'
                ? sharedMedia.photos
                : mediaTab === 'videos'
                  ? sharedMedia.videos
                  : sharedMedia.files
            }
            onPreview={(uri) => setPreviewUri(uri)}
          />
        </View>

        {/* Block button */}
        <View style={styles.blockSection}>
          <TouchableOpacity
            style={styles.blockBtn}
            onPress={handleBlock}
            activeOpacity={0.85}
            testID="user-profile-block-btn"
          >
            <Feather name="slash" size={18} color={Colors.danger} />
            <Text style={styles.blockBtnText}>Block {displayName}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* iter-206 Save Contact dialog. Renders only when invoked from
          the action row's Save button. Spec: SAVE_CONTACT_NATIVE_CONTRACT.md */}
      {hasValidUserId ? (
        <SaveContactDialog
          visible={showSaveDialog}
          onClose={() => setShowSaveDialog(false)}
          contactId={String(userId)}
          initialName={user?.name || user?.displayName || ''}
          defaultPhone={user?.phoneE164 || user?.phone || ''}
          defaultEmail={user?.email || ''}
        />
      ) : null}

      {/* Floating mute FAB */}
      <TouchableOpacity
        style={[styles.muteFab, { bottom: Math.max(insets.bottom, 24) + 28 }]}
        onPress={() => setMuted((current) => !current)}
        activeOpacity={0.85}
        testID="user-profile-mute-fab"
      >
        <Feather
          name={muted ? 'mic' : 'mic-off'}
          size={20}
          color={muted ? Colors.textSecondary : Colors.primary}
        />
      </TouchableOpacity>

      {/* Image preview modal */}
      <Modal
        visible={!!previewUri}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewUri(null)}
      >
        <Pressable
          style={styles.previewBackdrop}
          onPress={() => setPreviewUri(null)}
        >
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

// --- Sub-components -------------------------------------------------------
function ActionButton({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: any;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      style={styles.actionItem}
      activeOpacity={0.85}
      onPress={onPress}
      testID={testID}
    >
      <View style={styles.actionCircle}>
        <Feather name={icon} size={22} color={Colors.primary} />
      </View>
      <Text style={styles.actionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function MediaTabBtn({
  active,
  icon,
  label,
  onPress,
  testID,
}: {
  active: boolean;
  icon: any;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.mediaTab, active ? styles.mediaTabActive : null]}
      onPress={onPress}
      activeOpacity={0.85}
      testID={testID}
    >
      <Feather
        name={icon}
        size={15}
        color={active ? Colors.textPrimary : Colors.textSecondary}
      />
      <Text
        style={[
          styles.mediaTabLabel,
          active ? styles.mediaTabLabelActive : null,
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function MediaGrid({
  tab,
  items,
  onPreview,
}: {
  tab: MediaTab;
  items: any[];
  onPreview: (uri: string) => void;
}) {
  if (items.length === 0) {
    return (
      <View style={styles.mediaEmptyWrap}>
        <Feather
          name={tab === 'photos' ? 'image' : tab === 'videos' ? 'film' : 'file-text'}
          size={28}
          color={Colors.textMuted}
        />
        <Text style={styles.mediaEmptyText}>
          {tab === 'photos'
            ? 'No shared photos yet.'
            : tab === 'videos'
              ? 'No shared videos yet.'
              : 'No shared files yet.'}
        </Text>
      </View>
    );
  }

  if (tab === 'files') {
    return (
      <View style={styles.filesList}>
        {items.map((file: any) => (
          <View key={file._id} style={styles.fileRow}>
            <View style={styles.fileIcon}>
              <Feather name="file-text" size={20} color={Colors.primary} />
            </View>
            <View style={styles.fileMeta}>
              <Text style={styles.fileName} numberOfLines={1}>
                {file?.fileName || 'Document'}
              </Text>
              <Text style={styles.fileSub}>
                {file?.mimeType
                  ? String(file.mimeType).split('/').pop()?.toUpperCase()
                  : 'FILE'}
              </Text>
            </View>
          </View>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.mediaGrid}>
      {items.map((item: any) => {
        const src: string | null =
          item?.mediaUrl ||
          item?.url ||
          item?.imageUrl ||
          item?.thumbnailUrl ||
          null;
        return (
          <TouchableOpacity
            key={item._id}
            style={styles.mediaTile}
            activeOpacity={0.85}
            onPress={() => (src ? onPreview(src) : undefined)}
          >
            {src && /^https?:/i.test(src) ? (
              <Image
                source={{ uri: src }}
                style={styles.mediaTileImg}
                resizeMode="cover"
              />
            ) : (
              <View style={styles.mediaTilePlaceholder}>
                <Feather
                  name={tab === 'videos' ? 'film' : 'image'}
                  size={20}
                  color={Colors.textMuted}
                />
              </View>
            )}
            {tab === 'videos' ? (
              <View style={styles.mediaVideoOverlay}>
                <Feather name="play" size={18} color={Colors.white} />
              </View>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// --- Styles ---------------------------------------------------------------
const HERO_HEIGHT = 220;
const AVATAR_SIZE = 132;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scrollWrap: { flex: 1 },
  scrollContent: { paddingBottom: 80 },

  // Hero
  hero: {
    height: HERO_HEIGHT,
    backgroundColor: '#6B3E00',
    paddingHorizontal: 16,
  },
  heroBackBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Avatar
  avatarWrap: {
    alignItems: 'center',
    marginTop: -(AVATAR_SIZE / 2 + 12),
    marginBottom: 8,
  },
  avatarRing: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: Colors.primaryLight,
    borderWidth: 4,
    borderColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    ...(Platform_shadow()),
  },
  avatarImage: {
    width: AVATAR_SIZE - 8,
    height: AVATAR_SIZE - 8,
    borderRadius: (AVATAR_SIZE - 8) / 2,
  },
  avatarInitial: {
    fontSize: 56,
    color: Colors.primary,
    fontWeight: FontWeight.bold,
  },

  // Identity
  identityBlock: {
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: 4,
    paddingBottom: Spacing.lg,
  },
  name: {
    fontSize: 26,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  lastSeen: {
    marginTop: 4,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
  },

  // Level pill
  levelPill: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: Radius.pill,
    backgroundColor: '#FCE7E7',
    gap: 6,
  },
  levelText: {
    fontSize: FontSize.sm,
    color: '#E11D48',
    fontWeight: FontWeight.bold,
  },
  levelDivider: {
    width: 1,
    height: 14,
    backgroundColor: '#F4B6B6',
    marginHorizontal: 4,
  },
  engagementText: {
    fontSize: FontSize.sm,
    color: '#6B7280',
    fontWeight: FontWeight.medium,
  },

  // Action row
  actionRow: {
    marginTop: 18,
    flexDirection: 'row',
    gap: 36,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  actionItem: {
    alignItems: 'center',
    minWidth: 70,
  },
  actionCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: {
    marginTop: 8,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: FontWeight.medium,
  },

  // Sections
  sectionDivider: {
    height: 1,
    backgroundColor: '#E8E1D2',
    marginHorizontal: 0,
  },
  section: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
  },
  sectionLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: FontWeight.bold,
    letterSpacing: 1,
    marginBottom: 12,
  },
  sectionBody: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    lineHeight: 22,
  },
  sectionEmpty: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    fontStyle: 'italic',
  },

  // Groups in common
  groupsList: { gap: 18 },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  groupAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  groupAvatarImg: { width: 46, height: 46, borderRadius: 23 },
  groupName: {
    flex: 1,
    fontSize: FontSize.lg,
    color: Colors.textPrimary,
    fontWeight: FontWeight.semibold,
  },

  // Media tabs
  mediaTabs: {
    flexDirection: 'row',
    backgroundColor: '#EFE7D6',
    borderRadius: Radius.md,
    padding: 4,
    gap: 4,
  },
  mediaTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: Radius.md,
  },
  mediaTabActive: {
    backgroundColor: Colors.white,
  },
  mediaTabLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: FontWeight.medium,
  },
  mediaTabLabelActive: {
    color: Colors.textPrimary,
    fontWeight: FontWeight.semibold,
  },
  mediaGrid: {
    marginTop: 14,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
  mediaTile: {
    width: GRID_TILE,
    height: GRID_TILE,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#EFE7D6',
    borderWidth: 1,
    borderColor: '#E0D6C0',
    position: 'relative',
  },
  mediaTileImg: { width: '100%', height: '100%' },
  mediaTilePlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaVideoOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  mediaEmptyWrap: {
    marginTop: 14,
    paddingVertical: Spacing.xl,
    alignItems: 'center',
    gap: 8,
  },
  mediaEmptyText: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    fontStyle: 'italic',
  },

  // Files list
  filesList: { marginTop: 12, gap: 12 },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  fileIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileMeta: { flex: 1 },
  fileName: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    fontWeight: FontWeight.semibold,
  },
  fileSub: {
    marginTop: 2,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },

  // Block
  blockSection: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.lg,
  },
  blockBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 16,
    borderRadius: Radius.md,
    backgroundColor: '#FDE2E2',
  },
  blockBtnText: {
    fontSize: FontSize.base,
    color: Colors.danger,
    fontWeight: FontWeight.semibold,
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

  // Image preview
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

  // Fallback
  fallbackWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: 12,
  },
  fallbackTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  fallbackBody: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  fallbackBtn: {
    marginTop: 16,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
  },
  fallbackBtnText: {
    color: Colors.white,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.base,
  },
});

// Tiny helper — keeps the styles object literal-friendly while applying
// platform-correct shadow on the avatar ring.
function Platform_shadow() {
  return {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 8,
    elevation: 4,
  };
}
