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

import React, { useMemo, useState } from 'react';
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

  const handleStart = async () => {
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
      //   2. create a `screenSharingSessions` row via
      //      api.screenSharing.requestScreenShare (status "requesting"),
      //   3. open the screen-only WebRTC view as the SHARER.
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

      const audio = includeAudio ? 1 : 0;
      router.replace(
        `/call/${sessionId}?type=screen&screenOnly=1&audio=${audio}&role=sharer&convId=${conversationId}&peerUserId=${selectedId}` as any,
      );
    } catch (errorValue: any) {
      Alert.alert(
        'Could not share screen',
        String(errorValue?.message || errorValue || 'Please try again.').slice(0, 140),
      );
    } finally {
      setSubmitting(false);
    }
  };

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
            !selectedId || submitting ? styles.startBtnDisabled : null,
          ]}
          onPress={handleStart}
          disabled={!selectedId || submitting}
          activeOpacity={0.85}
          testID="screen-share-start-btn"
        >
          {submitting ? (
            <ActivityIndicator color="#3D2A00" />
          ) : (
            <>
              <MaterialCommunityIcons name="monitor-share" size={20} color="#3D2A00" />
              <Text style={styles.startBtnText}>Start Screen Share</Text>
            </>
          )}
        </TouchableOpacity>
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
  startBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: '#3D2A00' },
});
