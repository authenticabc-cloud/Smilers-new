/**
 * Screen Share — sender entry screen.
 *
 * User can begin to share their screen with another user **without being
 * in a call**. The recipient receives a request that they must accept;
 * once accepted, both clients route into the existing call screen running
 * in screen-only mode (`?type=screen&screenOnly=1&audio=<0|1>`).
 *
 * See /app/CONVEX_BACKEND_INSTRUCTIONS_SCREEN_SHARE.md for the full
 * request/accept Convex contract this screen targets.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { useAuth } from '../src/providers/AuthProvider';
import { getDisplayNameFromUser, getDisplayInitials } from '../src/lib/displayName';
import { useDeviceContactIndex, resolveDeviceContactNameFromUser } from '../src/lib/deviceContactIndex';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

interface ContactRow {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
  rawUserId?: string | null;
}

function normalizeContact(record: any): ContactRow | null {
  if (!record) return null;
  const otherUser =
    record.otherUser || record.user || record.contact || record;
  const userId =
    otherUser?.userId || otherUser?._id || otherUser?.id || record?.userId;
  if (!userId) return null;
  return {
    id: String(userId),
    displayName: getDisplayNameFromUser(otherUser, 'Smilers user'),
    avatarUrl: otherUser?.avatar || otherUser?.avatarUrl || otherUser?.photoURL || null,
    rawUserId: String(userId),
  };
}

// Session statuses that mean the request was NOT accepted (drop back to idle).
const DECLINED_STATUSES = ['declined', 'rejected', 'ended', 'cancelled', 'canceled', 'expired'];


export default function ScreenShareSenderScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useAuth();
  const params = useLocalSearchParams<{ recipient?: string; name?: string }>();

  const [search, setSearch] = useState('');
  const [includeAudio, setIncludeAudio] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(
    typeof params.recipient === 'string' && params.recipient.length > 5
      ? params.recipient
      : null,
  );
  const [submitting, setSubmitting] = useState(false);
  // Two-phase screen-share gate: after sending the request we WAIT here (button
  // disabled) until the recipient accepts; only then does the button turn green
  // and the sharer proceeds into the call screen (which triggers the OS capture
  // dialog). Previously we navigated immediately, so tapping the system "Start"
  // before the recipient accepted did nothing.
  const [waiting, setWaiting] = useState(false);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);

  const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);
  const requestScreenShare = useMutation((api as any).screenSharing.requestScreenShare);

  const { data: contacts, loading: contactsLoading } = useSafeConvexQuery<any[]>(
    api.contacts.getContacts,
    {},
    [],
    isAuthenticated,
  );

  const { data: me } = useSafeConvexQuery<any>(
    (api as any).users.getCurrentUser,
    {},
    null,
    isAuthenticated,
  );

  // Poll the session while waiting for the recipient to accept.
  const { data: pendingSession } = useSafeConvexQuery<any>(
    (api as any).screenSharing?.getActiveSession,
    waiting && pendingConversationId ? { conversationId: pendingConversationId } : 'skip',
    null,
    waiting && !!pendingConversationId,
  );
  const shareStatus = String(pendingSession?.status || '').toLowerCase();
  const accepted = useMemo(() => {
    if (!pendingSession) return false;
    if (DECLINED_STATUSES.includes(shareStatus)) return false;
    return (
      ['accepted', 'active', 'sharing', 'approved', 'connected', 'live'].includes(shareStatus) ||
      !!pendingSession?.acceptedAt ||
      pendingSession?.accepted === true
    );
  }, [pendingSession, shareStatus]);

  // iter-188: prefer the name saved in the user's own phone address book
  // over the Convex profile name (which is the Google-account name or a
  // raw phone number). Same resolution the Chats list and Share Picker use.
  const deviceIndex = useDeviceContactIndex();

  const contactRows = useMemo<ContactRow[]>(() => {
    const list = Array.isArray(contacts) ? contacts : [];
    const normalized = list
      .map((r) => {
        const row = normalizeContact(r);
        if (!row) return null;
        const deviceName = resolveDeviceContactNameFromUser(deviceIndex, r);
        if (deviceName) row.displayName = deviceName;
        return row;
      })
      .filter((c): c is ContactRow => !!c);
    const query = search.trim().toLowerCase();
    if (!query) return normalized;
    return normalized.filter((c) =>
      c.displayName.toLowerCase().includes(query),
    );
  }, [contacts, search, deviceIndex]);

  const selected: ContactRow | null = useMemo(() => {
    if (!selectedId) return null;
    return contactRows.find((c) => c.id === selectedId) || null;
  }, [contactRows, selectedId]);

  const handleRequest = async () => {
    if (!selectedId) {
      Alert.alert('Pick a recipient', 'Choose someone to share your screen with.');
      return;
    }
    const myId = String((me as any)?._id || '');
    if (!myId) {
      Alert.alert('Please wait', 'Still loading your account — try again in a moment.');
      return;
    }
    setSubmitting(true);
    try {
      // Screen-share is its own request/accept flow (NOT a call). We:
      //   1. resolve/create the direct conversation with the recipient,
      //   2. create a `screenSharingSessions` row via requestScreenShare
      //      (status "requesting"),
      //   3. WAIT on this screen (button disabled) until the recipient accepts.
      // The recipient is notified via IncomingScreenShareModal (polls
      // screenSharing.listIncoming) + a backend push — NO ringtone, no call.
      const convResult: any = await getOrCreateDirect({ otherUserId: selectedId });
      const conversationId = String(
        typeof convResult === 'string'
          ? convResult
          : convResult?.conversationId || convResult?._id || convResult?.id || '',
      );
      if (!conversationId) {
        throw new Error('Could not open a conversation with this contact.');
      }

      const sessionResult: any = await requestScreenShare({ conversationId });
      const sessionId = String(
        typeof sessionResult === 'string'
          ? sessionResult
          : sessionResult?.sessionId || sessionResult?._id || sessionResult?.id || '',
      );
      if (!sessionId) {
        throw new Error('Could not start the screen-share session.');
      }

      // Enter the WAITING state — do NOT navigate yet. The button becomes green
      // and tappable once `accepted` flips true from the polled session.
      setPendingConversationId(conversationId);
      setPendingSessionId(sessionId);
      setWaiting(true);
    } catch (errorValue: any) {
      Alert.alert(
        'Could not share screen',
        String(errorValue?.message || errorValue || 'Please try again.').slice(0, 140),
      );
    } finally {
      setSubmitting(false);
    }
  };

  // The recipient accepted → sharer taps the green button to open the
  // screen-only WebRTC view as the SHARER (where the OS capture dialog appears).
  const handleGo = () => {
    if (!accepted || !pendingSessionId || !pendingConversationId) return;
    const audio = includeAudio ? 1 : 0;
    router.replace(
      `/call/${pendingSessionId}?type=screen&screenOnly=1&audio=${audio}&role=sharer&convId=${pendingConversationId}&peerUserId=${selectedId}` as any,
    );
  };

  const resetWaiting = () => {
    setWaiting(false);
    setPendingSessionId(null);
    setPendingConversationId(null);
  };

  // Recipient declined / session ended before acceptance → drop back to idle.
  useEffect(() => {
    if (waiting && shareStatus && DECLINED_STATUSES.includes(shareStatus)) {
      resetWaiting();
      Alert.alert(
        'Request declined',
        `${selected?.displayName || 'They'} declined the screen-share request.`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareStatus, waiting]);

  const headerSubtitle = selected
    ? `Sharing with ${selected.displayName}`
    : 'Pick someone to share your screen with';

  return (
    <View style={styles.container} testID="screen-share-screen">
      <SafeAreaView edges={['top']} style={styles.headerSafe}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            style={styles.headerBackBtn}
            onPress={() => router.back()}
            hitSlop={10}
            testID="screen-share-back"
          >
            <Feather name="arrow-left" size={22} color={Colors.white} />
          </TouchableOpacity>
          <MaterialCommunityIcons name="monitor-share" size={24} color={Colors.white} />
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Share Screen</Text>
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {headerSubtitle}
            </Text>
          </View>
        </View>
      </SafeAreaView>

      {/* Info card */}
      <View style={styles.infoCard} testID="screen-share-info-card">
        <View style={styles.infoIconWrap}>
          <Feather name="info" size={18} color={Colors.primary} />
        </View>
        <Text style={styles.infoText}>
          The recipient gets an incoming call. Once they answer, your screen
          starts broadcasting to them over a secure Twilio connection.
        </Text>
      </View>

      {/* Search */}
      <View style={styles.searchWrap}>
        <Feather name="search" size={18} color={Colors.textSecondary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search contacts"
          placeholderTextColor={Colors.textMuted}
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
          autoCapitalize="none"
          testID="screen-share-search"
        />
      </View>

      {/* Contacts list */}
      <View style={styles.listWrap}>
        {contactsLoading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={Colors.primary} />
          </View>
        ) : contactRows.length === 0 ? (
          <View style={styles.emptyWrap} testID="screen-share-empty">
            <Feather name="users" size={36} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>No contacts yet</Text>
            <Text style={styles.emptyBody}>
              Add someone in your Contacts tab before sharing your screen with
              them.
            </Text>
          </View>
        ) : (
          <FlatList
            data={contactRows}
            keyExtractor={(item) => item.id}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[
                  styles.contactRow,
                  selectedId === item.id ? styles.contactRowSelected : null,
                ]}
                onPress={() => setSelectedId(item.id)}
                activeOpacity={0.85}
                testID={`screen-share-contact-${item.id}`}
              >
                <View style={styles.contactAvatar}>
                  {item.avatarUrl ? (
                    <Image
                      source={{ uri: item.avatarUrl }}
                      style={styles.contactAvatarImg}
                      resizeMode="cover"
                    />
                  ) : (
                    <Text style={styles.contactAvatarText}>
                      {getDisplayInitials(item.displayName)}
                    </Text>
                  )}
                </View>
                <Text style={styles.contactName} numberOfLines={1}>
                  {item.displayName}
                </Text>
                {selectedId === item.id ? (
                  <Feather name="check-circle" size={22} color={Colors.primary} />
                ) : (
                  <Feather name="circle" size={22} color={Colors.textMuted} />
                )}
              </TouchableOpacity>
            )}
          />
        )}
      </View>

      {/* Audio toggle */}
      <View style={styles.audioRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.audioTitle}>Include microphone narration</Text>
          <Text style={styles.audioBody}>
            Recipient can hear you talking over the shared screen.
          </Text>
        </View>
        <Switch
          value={includeAudio}
          onValueChange={setIncludeAudio}
          trackColor={{ false: '#D1D5DB', true: Colors.primary }}
          thumbColor={includeAudio ? Colors.white : '#F4F4F5'}
          testID="screen-share-audio-toggle"
        />
      </View>

      {/* Start button */}
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 18) }]}>
        <TouchableOpacity
          style={[
            styles.startBtn,
            accepted ? styles.startBtnAccepted : null,
            (!selectedId || submitting || (waiting && !accepted)) ? styles.startBtnDisabled : null,
          ]}
          onPress={accepted ? handleGo : waiting ? undefined : handleRequest}
          disabled={!selectedId || submitting || (waiting && !accepted)}
          activeOpacity={0.85}
          testID="screen-share-start-btn"
        >
          {submitting || (waiting && !accepted) ? (
            <>
              <ActivityIndicator color={accepted ? '#FFFFFF' : '#3D2A00'} />
              <Text style={styles.startBtnText}>
                {submitting
                  ? 'Sending request…'
                  : `Waiting for ${selected?.displayName || 'them'} to accept…`}
              </Text>
            </>
          ) : accepted ? (
            <>
              <MaterialCommunityIcons name="check-circle" size={20} color="#FFFFFF" />
              <Text style={[styles.startBtnText, styles.startBtnTextAccepted]}>
                Accepted — Start sharing
              </Text>
            </>
          ) : (
            <>
              <MaterialCommunityIcons name="monitor-share" size={20} color="#3D2A00" />
              <Text style={styles.startBtnText}>Start Screen Share</Text>
            </>
          )}
        </TouchableOpacity>

        {waiting && !accepted ? (
          <TouchableOpacity
            style={styles.cancelWaitBtn}
            onPress={resetWaiting}
            activeOpacity={0.7}
            testID="screen-share-cancel-btn"
          >
            <Text style={styles.cancelWaitText}>Cancel request</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  // Header
  headerSafe: { backgroundColor: Colors.headerBg },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
    minHeight: 80,
  },
  headerBackBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 20, fontWeight: FontWeight.bold, color: Colors.white },
  headerSubtitle: {
    fontSize: FontSize.sm,
    color: 'rgba(255,255,255,0.78)',
    marginTop: 2,
  },

  // Info card
  infoCard: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    backgroundColor: '#FBEFC9',
    borderColor: '#F4DC8A',
    borderWidth: 1,
    borderRadius: Radius.md,
    margin: Spacing.base,
    padding: 14,
  },
  infoIconWrap: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  infoText: { flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary, lineHeight: 20 },

  // Search
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.md,
    marginHorizontal: Spacing.base,
    borderWidth: 1,
    borderColor: '#EBE5D5',
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 4,
  },

  // List
  listWrap: { flex: 1, marginTop: Spacing.md },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: 10,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  emptyBody: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },

  separator: { height: 1, backgroundColor: '#EBE5D5', marginLeft: 70 },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    backgroundColor: Colors.background,
  },
  contactRowSelected: { backgroundColor: '#FFF7DE' },
  contactAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  contactAvatarImg: { width: 44, height: 44, borderRadius: 22 },
  contactAvatarText: { fontSize: FontSize.lg, color: Colors.primary, fontWeight: FontWeight.bold },
  contactName: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },

  // Audio row
  audioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: '#EBE5D5',
    backgroundColor: Colors.surface,
  },
  audioTitle: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  audioBody: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },

  // Footer / start button
  footer: { paddingHorizontal: Spacing.base, paddingTop: Spacing.md, backgroundColor: Colors.background },
  startBtn: {
    minHeight: 54,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  startBtnDisabled: { opacity: 0.5 },
  startBtnAccepted: { backgroundColor: '#16A34A' },
  startBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: '#3D2A00' },
  startBtnTextAccepted: { color: '#FFFFFF' },
  cancelWaitBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  cancelWaitText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textMuted },
});
