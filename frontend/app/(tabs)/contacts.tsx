import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
import * as Contacts from 'expo-contacts';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import Header from '../../src/components/Header';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { getDisplayInitials, getDisplayNameFromUser } from '../../src/lib/displayName';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../src/theme';

type TabKey = 'my' | 'device';

interface DeviceContact {
  id: string;
  name: string;
  phone?: string;
  email?: string;
}

function getContactUserId(contact: any): string {
  const candidate = [
    contact?.userId,
    contact?.user?.userId,
    contact?.user?._id,
    contact?.user?.id,
    contact?._id,
    contact?.id,
  ].find((value) => typeof value === 'string' && value.trim().length > 0);

  return typeof candidate === 'string' ? candidate.trim() : '';
}

/**
 * iter-138: phone normaliser.
 *
 * Convex's `sendRequestByPhone` mutation strictly expects an E.164
 * number (e.g. `+39328…`). Mobile was previously forwarding the raw
 * device-contact phone (`"328 074 0584"`) which the backend rejects
 * with a generic `Server Error / Called by client`. We sanitize here
 * using `libphonenumber-js` with the user's own phone as the implicit
 * country hint when the input has no `+`.
 *
 * Returns the E.164 string on success or `null` on failure (caller
 * should surface a clear "Invalid number" alert instead of letting
 * Convex throw).
 */
function normalizePhoneE164(
  raw: string | null | undefined,
  defaultCountryCode?: string | null,
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Fast-path: already starts with `+` and parses cleanly.
  try {
    const direct = parsePhoneNumberFromString(trimmed);
    if (direct?.isValid()) return direct.number;
  } catch {
    /* fall through to country-hint parse */
  }

  // Convert "00XX…" prefix to "+XX…" (common European entry style).
  const intl00 = trimmed.replace(/^00/, '+');
  if (intl00.startsWith('+')) {
    try {
      const parsed = parsePhoneNumberFromString(intl00);
      if (parsed?.isValid()) return parsed.number;
    } catch {
      /* fall through */
    }
  }

  // Try with a country-code hint derived from the user's own phone.
  const hint: CountryCode | undefined = defaultCountryCode
    ? (defaultCountryCode.toUpperCase() as CountryCode)
    : undefined;
  if (hint) {
    try {
      const parsed = parsePhoneNumberFromString(trimmed, hint);
      if (parsed?.isValid()) return parsed.number;
    } catch {
      /* swallow */
    }
  }

  return null;
}

export default function ContactsScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('my');
  const [search, setSearch] = useState('');
  const [showAddSheet, setShowAddSheet] = useState(false);
  const [showAddByPhone, setShowAddByPhone] = useState(false);
  const [phoneInput, setPhoneInput] = useState('');
  const [addingPhone, setAddingPhone] = useState(false);
  const [deviceContacts, setDeviceContacts] = useState<DeviceContact[]>([]);
  const [devicePerm, setDevicePerm] = useState<'unknown' | 'granted' | 'denied' | 'web'>('unknown');
  const [deviceLoading, setDeviceLoading] = useState(false);

  const searchTerm = search.trim();

  // Convex queries.
  const contactsQuery = useSafeConvexQuery<any[]>(api.contacts.getContacts, {}, []);
  const pendingQuery = useSafeConvexQuery<any[]>(api.contacts.getPendingRequests, {}, []);
  const outgoingQuery = useSafeConvexQuery<any[]>(api.contacts.getOutgoingRequests, {}, []);
  const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);
  const sendRequest = useMutation(api.contacts.sendRequest);
  const sendRequestByPhone = useMutation(api.contacts.sendRequestByPhone);
  const acceptRequest = useMutation(api.contacts.acceptRequest);
  const rejectRequest = useMutation(api.contacts.rejectRequest);
  const cancelRequest = useMutation(api.contacts.cancelRequest);

  // iter-138: read the current user so we can derive a default country
  // hint for phone-number normalization in invite flows.
  const me = useQuery(api.users.getCurrentUser, {}) as any | undefined;
  const myDefaultCountry = useMemo<string | null>(() => {
    const myPhone = typeof me?.phone === 'string' ? me.phone : '';
    if (!myPhone) return null;
    try {
      const parsed = parsePhoneNumberFromString(myPhone);
      return parsed?.country || null;
    } catch {
      return null;
    }
  }, [me?.phone]);

  const list: any[] = Array.isArray(contactsQuery.data) ? contactsQuery.data : [];
  const pendingList: any[] = Array.isArray(pendingQuery.data) ? pendingQuery.data : [];
  const outgoingList: any[] = Array.isArray(outgoingQuery.data) ? outgoingQuery.data : [];

  // Load device contacts (when tab is opened or permission already granted).
  const loadDeviceContacts = useCallback(async () => {
    if (Platform.OS === 'web') {
      setDevicePerm('web');
      return;
    }
    setDeviceLoading(true);
    try {
      const current = await Contacts.getPermissionsAsync();
      let granted = current.granted;
      if (!granted && current.canAskAgain) {
        const next = await Contacts.requestPermissionsAsync();
        granted = next.granted;
      }
      if (!granted) {
        setDevicePerm('denied');
        return;
      }
      setDevicePerm('granted');
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
        pageSize: 5000,
      });
      const mapped: DeviceContact[] = data
        .map((c: any) => ({
          id: c.id,
          name: c.name || c.firstName || c.lastName || 'Unnamed',
          phone: c.phoneNumbers?.[0]?.number,
          email: c.emails?.[0]?.email,
        }))
        .filter((c) => !!c.name)
        .sort((a, b) => a.name.localeCompare(b.name));
      setDeviceContacts(mapped);
    } catch (errorValue) {
      console.warn('device contacts failed:', errorValue);
      setDevicePerm('denied');
    } finally {
      setDeviceLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'device' && devicePerm === 'unknown') {
      void loadDeviceContacts();
    }
  }, [devicePerm, loadDeviceContacts, tab]);

  // Filtered display lists.
  const myFiltered = useMemo(() => {
    const q = searchTerm.toLowerCase();
    if (!q) return list;
    return list.filter((c: any) => {
      const fields = `${c.name || ''} ${c.email || ''} ${c.phone || ''} ${c.about || ''}`.toLowerCase();
      return fields.includes(q);
    });
  }, [list, searchTerm]);

  const deviceFiltered = useMemo(() => {
    const q = searchTerm.toLowerCase();
    if (!q) return deviceContacts;
    return deviceContacts.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.phone || '').toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q),
    );
  }, [deviceContacts, searchTerm]);

  // ── Actions ──────────────────────────────────────
  const openChat = async (userId: string) => {
    if (!userId) {
      Alert.alert('Unavailable contact', 'This contact is missing a valid Smilers account reference.');
      return;
    }
    try {
      const conversation: any = await getOrCreateDirect({ otherUserId: userId });
      const conversationId =
        typeof conversation === 'string' ? conversation : conversation?._id || conversation?.conversationId;
      if (conversationId) router.push(`/chat/${conversationId}` as any);
    } catch (errorValue: any) {
      Alert.alert('Error', errorValue?.message || 'Could not open chat');
    }
  };

  const onInviteDevice = useCallback(
    async (c: DeviceContact) => {
      if (!c.phone) {
        Alert.alert('No phone number', 'This device contact has no phone number to invite.');
        return;
      }
      // iter-138: Convex `sendRequestByPhone` rejects anything that
      // isn't strict E.164. Raw device-contact phones look like
      // "328 074 0584" → must become "+39328…". Normalize before send.
      const e164 = normalizePhoneE164(c.phone, myDefaultCountry);
      if (!e164) {
        Alert.alert(
          'Invalid phone number',
          `Could not understand the number "${c.phone}". Add the country code (e.g. +39 …) and try again.`,
        );
        return;
      }
      try {
        await sendRequestByPhone({ phone: e164 });
        Alert.alert('Invite sent', `${c.name} will receive an SMS invite to join Smilers.`);
      } catch (errorValue: any) {
        Alert.alert('Could not invite', errorValue?.message || 'Try again later.');
      }
    },
    [sendRequestByPhone, myDefaultCountry],
  );

  const onAddByPhone = useCallback(async () => {
    const raw = phoneInput.trim();
    if (!raw) return;
    // iter-138: same E.164 normalization for the manual "Add by phone"
    // sheet. Surfaces a clear error before hitting Convex.
    const e164 = normalizePhoneE164(raw, myDefaultCountry);
    if (!e164) {
      Alert.alert(
        'Invalid phone number',
        'Please enter a valid phone number with country code (e.g. +1 555 123 4567).',
      );
      return;
    }
    setAddingPhone(true);
    try {
      await sendRequestByPhone({ phone: e164 });
      setPhoneInput('');
      setShowAddByPhone(false);
      Alert.alert('Request sent', `An invite was sent to ${e164}.`);
    } catch (errorValue: any) {
      Alert.alert('Could not send invite', errorValue?.message || 'Check the phone number and try again.');
    } finally {
      setAddingPhone(false);
    }
  }, [phoneInput, sendRequestByPhone, myDefaultCountry]);

  const myCount = list.length;
  const deviceCount = deviceContacts.length;

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="contacts-screen">
      <Header
        title="Contacts"
        variant="dark"
        right={
          <View style={styles.headerRight}>
            <TouchableOpacity
              hitSlop={10}
              style={styles.headerBtn}
              onPress={() => setShowAddByPhone(true)}
              testID="contacts-phone-btn"
            >
              <Feather name="smartphone" size={22} color={Colors.white} />
            </TouchableOpacity>
            <TouchableOpacity
              hitSlop={10}
              style={styles.headerBtn}
              onPress={() => router.push('/contact-qr?mode=scan' as any)}
              testID="contacts-qr-btn"
            >
              <MaterialCommunityIcons name="qrcode-scan" size={22} color={Colors.white} />
            </TouchableOpacity>
          </View>
        }
      />

      {/* Tabs */}
      <View style={styles.tabsRow}>
        <TouchableOpacity
          style={styles.tabBtn}
          onPress={() => setTab('my')}
          activeOpacity={0.7}
          testID="contacts-tab-my"
        >
          <Text style={[styles.tabText, tab === 'my' ? styles.tabTextActive : null]}>My Contacts</Text>
          {tab === 'my' ? <View style={styles.tabIndicator} /> : null}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.tabBtn}
          onPress={() => setTab('device')}
          activeOpacity={0.7}
          testID="contacts-tab-device"
        >
          <View style={styles.tabLabelRow}>
            <Text style={[styles.tabText, tab === 'device' ? styles.tabTextActive : null]}>Device Contacts</Text>
            {deviceCount > 0 ? (
              <View style={styles.countPill}>
                <Text style={styles.countPillText}>{deviceCount}</Text>
              </View>
            ) : null}
          </View>
          {tab === 'device' ? <View style={styles.tabIndicator} /> : null}
        </TouchableOpacity>
      </View>

      {/* Search bar */}
      <View style={styles.searchOuter}>
        <View style={styles.searchPill}>
          <Feather name="search" size={18} color={Colors.textMuted} />
          <TextInput
            placeholder="Search by name or email..."
            placeholderTextColor={Colors.textMuted}
            value={search}
            onChangeText={setSearch}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            testID="contacts-search"
          />
        </View>
      </View>

      {tab === 'my' ? (
        <FlatList
          data={myFiltered}
          keyExtractor={(item: any, idx: number) => getContactUserId(item) || String(idx)}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <>
              {/* Pending requests (only shown when no search) */}
              {pendingList.length > 0 && !searchTerm ? (
                <>
                  <Text style={styles.sectionLabel}>PENDING REQUESTS ({pendingList.length})</Text>
                  {pendingList.map((p: any) => (
                    <View key={p._id} style={styles.row} testID={`pending-${p._id}`}>
                      <ContactAvatar name={getDisplayNameFromUser(p)} online={false} />
                      <View style={styles.rowMid}>
                        <Text style={styles.rowName} numberOfLines={1}>
                          {getDisplayNameFromUser(p)}
                        </Text>
                        <Text style={styles.rowSub} numberOfLines={1}>
                          wants to connect
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={styles.rejectBtn}
                        onPress={() =>
                          rejectRequest({ contactId: p._id }).catch((errorValue: any) =>
                            Alert.alert('Failed', errorValue?.message),
                          )
                        }
                        testID={`reject-${p._id}`}
                      >
                        <Feather name="x" size={18} color={Colors.danger} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.acceptBtn}
                        onPress={() =>
                          acceptRequest({ contactId: p._id }).catch((errorValue: any) =>
                            Alert.alert('Failed', errorValue?.message),
                          )
                        }
                        testID={`accept-${p._id}`}
                      >
                        <Text style={styles.acceptText}>Accept</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </>
              ) : null}

              {outgoingList.length > 0 && !searchTerm ? (
                <>
                  <Text style={styles.sectionLabel}>SENT REQUESTS ({outgoingList.length})</Text>
                  {outgoingList.map((o: any) => (
                    <View key={o._id} style={styles.row} testID={`outgoing-${o._id}`}>
                      <ContactAvatar name={getDisplayNameFromUser(o)} online={false} />
                      <View style={styles.rowMid}>
                        <Text style={styles.rowName} numberOfLines={1}>
                          {getDisplayNameFromUser(o)}
                        </Text>
                        <Text style={styles.rowSub}>Awaiting response</Text>
                      </View>
                      <TouchableOpacity
                        style={styles.cancelBtn}
                        onPress={() =>
                          cancelRequest({ contactId: o._id }).catch((errorValue: any) =>
                            Alert.alert('Failed', errorValue?.message),
                          )
                        }
                        testID={`cancel-${o._id}`}
                      >
                        <Text style={styles.cancelText}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </>
              ) : null}

              <Text style={styles.sectionLabel}>
                MY CONTACTS ({searchTerm ? myFiltered.length : myCount})
              </Text>
            </>
          }
          renderItem={({ item }) => {
            const uid = getContactUserId(item);
            const online = !!item.online || !!item.isOnline;
            const displayName = getDisplayNameFromUser(item);
            const contactKey = uid || displayName.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'unknown-contact';
            return (
              <TouchableOpacity
                style={styles.row}
                activeOpacity={0.7}
                onPress={() => openChat(uid)}
                testID={`contact-${contactKey}`}
              >
                <ContactAvatar name={displayName} online={online} />
                <View style={styles.rowMid}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {displayName}
                  </Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {item.about || 'Hey there! I am using Smilers.'}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            contactsQuery.loading ? (
              <View style={styles.empty} testID="contacts-loading">
                <ActivityIndicator color={Colors.primary} size="small" />
                <Text style={styles.emptyText}>Loading contacts…</Text>
              </View>
            ) : (
              <View style={styles.empty}>
                <Feather name="users" size={36} color={Colors.textMuted} />
                <Text style={styles.emptyText}>
                  {searchTerm
                    ? 'No contacts match your search.'
                    : 'No contacts yet. Tap the phone or QR icon above to add a contact.'}
                </Text>
              </View>
            )
          }
        />
      ) : (
        // ── DEVICE CONTACTS TAB ─────────────────────
        <FlatList
          data={deviceFiltered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            devicePerm === 'granted' ? (
              <Text style={styles.sectionLabel}>
                DEVICE CONTACTS ({searchTerm ? deviceFiltered.length : deviceCount})
              </Text>
            ) : null
          }
          renderItem={({ item }) => (
            <View style={styles.row} testID={`device-contact-${item.id}`}>
              <ContactAvatar name={item.name} online={false} />
              <View style={styles.rowMid}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {item.phone || item.email || 'No contact info'}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.inviteBtn}
                onPress={() => onInviteDevice(item)}
                testID={`invite-${item.id}`}
              >
                <Text style={styles.inviteText}>Invite</Text>
              </TouchableOpacity>
            </View>
          )}
          ListEmptyComponent={
            devicePerm === 'web' ? (
              <View style={styles.empty}>
                <Feather name="smartphone" size={36} color={Colors.textMuted} />
                <Text style={styles.emptyText}>
                  Device contacts are only available on the mobile app — open Smilers on your phone.
                </Text>
              </View>
            ) : devicePerm === 'denied' ? (
              <View style={styles.empty}>
                <Feather name="lock" size={36} color={Colors.textMuted} />
                <Text style={styles.emptyText}>
                  Smilers doesn’t have access to your device contacts. Allow access to find friends already on Smilers.
                </Text>
                <TouchableOpacity
                  style={styles.permBtn}
                  onPress={() => {
                    setDevicePerm('unknown');
                    void loadDeviceContacts().then(() => {
                      // If still denied, open Settings.
                      Contacts.getPermissionsAsync().then((p) => {
                        if (!p.granted && !p.canAskAgain) Linking.openSettings();
                      });
                    });
                  }}
                  testID="device-allow"
                >
                  <Text style={styles.permBtnText}>Allow access</Text>
                </TouchableOpacity>
              </View>
            ) : deviceLoading ? (
              <View style={styles.empty} testID="device-loading">
                <ActivityIndicator color={Colors.primary} size="small" />
                <Text style={styles.emptyText}>Loading device contacts…</Text>
              </View>
            ) : (
              <View style={styles.empty}>
                <Feather name="users" size={36} color={Colors.textMuted} />
                <Text style={styles.emptyText}>
                  {searchTerm ? 'No matches in your device contacts.' : 'No contacts found on this device.'}
                </Text>
              </View>
            )
          }
        />
      )}

      {/* Add by phone modal */}
      <Modal visible={showAddByPhone} transparent animationType="slide" onRequestClose={() => setShowAddByPhone(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowAddByPhone(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined} testID="add-by-phone-sheet">
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <View style={styles.grabber} />
              <Text style={styles.sheetTitle}>Add by phone number</Text>
              <Text style={styles.sheetSub}>We’ll send an invite if they’re not on Smilers yet.</Text>
              <TextInput
                value={phoneInput}
                onChangeText={setPhoneInput}
                placeholder="+1 555 123 4567"
                placeholderTextColor={Colors.textMuted}
                style={styles.phoneInput}
                keyboardType="phone-pad"
                autoFocus
                testID="phone-input"
              />
              <TouchableOpacity
                style={[styles.primaryBtn, !phoneInput.trim() || addingPhone ? styles.primaryBtnDisabled : null]}
                onPress={onAddByPhone}
                disabled={!phoneInput.trim() || addingPhone}
                testID="phone-add-btn"
              >
                <Text style={styles.primaryBtnText}>{addingPhone ? 'Sending…' : 'Send invite'}</Text>
              </TouchableOpacity>
            </KeyboardAvoidingView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

/* ──────────────── Avatar with green online dot ──────────────── */
function ContactAvatar({ name, online, size = 48 }: { name?: string; online?: boolean; size?: number }) {
  const initial = getDisplayInitials(name);
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          avatarStyles.bubble,
          { width: size, height: size, borderRadius: size / 2 },
        ]}
      >
        <Text style={[avatarStyles.text, { fontSize: size * 0.42 }]}>{initial}</Text>
      </View>
      {online ? <View style={avatarStyles.dot} /> : null}
    </View>
  );
}

const avatarStyles = StyleSheet.create({
  bubble: {
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontWeight: FontWeight.bold,
    color: Colors.primary,
  },
  dot: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#22C55E',
    borderWidth: 2,
    borderColor: Colors.background,
  },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  headerRight: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },

  tabsRow: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
  },
  tabLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tabText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
  },
  tabTextActive: { color: Colors.primary, fontWeight: FontWeight.bold },
  tabIndicator: {
    position: 'absolute',
    bottom: 0,
    height: 3,
    width: 80,
    borderRadius: 2,
    backgroundColor: Colors.primary,
  },
  countPill: {
    backgroundColor: Colors.borderLight,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.pill,
    minWidth: 30,
    alignItems: 'center',
  },
  countPillText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
  },

  searchOuter: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.surface,
  },
  searchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#EDE5D2',
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    borderRadius: Radius.pill,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },

  listContent: { paddingBottom: 120 },
  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    letterSpacing: 1,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    backgroundColor: Colors.background,
    gap: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#00000010',
  },
  rowMid: { flex: 1 },
  rowName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  rowSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },

  inviteBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.pill,
  },
  inviteText: { color: Colors.headerBg, fontWeight: FontWeight.bold, fontSize: FontSize.sm },

  acceptBtn: { backgroundColor: Colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: Radius.pill },
  acceptText: { color: Colors.headerBg, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  rejectBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: '#FEE2E2',
  },
  cancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cancelText: { color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },

  empty: { alignItems: 'center', paddingTop: Spacing.xxl, paddingHorizontal: Spacing.lg, gap: Spacing.md },
  emptyText: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  permBtn: {
    marginTop: Spacing.sm,
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    borderRadius: Radius.pill,
  },
  permBtnText: { color: Colors.headerBg, fontWeight: FontWeight.bold, fontSize: FontSize.base },

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
    marginBottom: 4,
    textAlign: 'center',
  },
  sheetSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.md, textAlign: 'center' },
  phoneInput: {
    backgroundColor: Colors.background,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 14,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.md,
  },
  primaryBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 14,
    borderRadius: Radius.pill,
    alignItems: 'center',
    ...Shadow.md,
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: Colors.headerBg, fontSize: FontSize.base, fontWeight: FontWeight.bold },
});
