import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { buildInviteUrl, buildInviteMessage } from '../../src/lib/inviteLink';
import { friendlyConvexError } from '../../src/lib/friendlyError';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useConvex } from 'convex/react';
import * as Contacts from 'expo-contacts';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import Header from '../../src/components/Header';
import { api } from '../../src/convexApi';
import { lookupUsersByPhones } from '../../src/lib/phoneLookup';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { getDisplayInitials, getDisplayNameFromUser, getResolvedDisplayName } from '../../src/lib/displayName';
import { useDeviceContactIndex, useDeviceContactRefresh, lookupDeviceContactName, fetchAllDeviceContacts } from '../../src/lib/deviceContactIndex';
import { isPresenceOnline } from '../../src/lib/presence';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../src/theme';

type TabKey = 'my' | 'device';

interface DeviceContact {
  id: string;
  name: string;
  phone?: string;
  email?: string;
}

function formatContactLastSeen(lastSeen?: string | number): string {
  if (lastSeen == null) return '';
  const t = typeof lastSeen === 'number' ? lastSeen : new Date(lastSeen).getTime();
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `Last seen ${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `Last seen ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `Last seen ${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `Last seen ${day}d ago`;
  return '';
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
  const convex = useConvex();
  const deviceIndex = useDeviceContactIndex();
  const refreshDeviceIndex = useDeviceContactRefresh();
  // iter-223: which device contacts are ALREADY on Smilers (registered but not
  // yet your contact). Populated via the batch `users.getByPhones` lookup —
  // dormant until the backend ships that query, then auto-activates so those
  // rows show "Message" instead of "Invite". Keyed by last-10-digits.
  const [registeredByDigits, setRegisteredByDigits] = useState<
    Map<string, { userId: string; name?: string }>
  >(new Map());
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

  // iter-148: read the user's referral code (best-effort) so the
  // invite Share message carries a deep link with the code (matches
  // earnings page behavior). Falls back to a plain link.
  const earningsProfile = useQuery((api as any).earnings?.getMyProfile, {}) as any | undefined;
  // iter-200: ALWAYS ensure a referral code exists — the backend creates
  // it lazily (canonical: earnings.getOrCreateReferralCode, idempotent,
  // no args). Previously gated on the profile query resolving first,
  // which left invites code-less when that query was slow or unavailable.
  const generateCodeM = useMutation((api as any).earnings?.getOrCreateReferralCode);
  const [localReferralCode, setLocalReferralCode] = useState<string | null>(null);
  const triedCreateCodeRef = useRef(false);
  const profileCode: string =
    (earningsProfile?.referralCode && String(earningsProfile.referralCode)) ||
    (earningsProfile?.code && String(earningsProfile.code)) ||
    '';
  useEffect(() => {
    if (triedCreateCodeRef.current) return;
    if (typeof generateCodeM !== 'function') return;
    triedCreateCodeRef.current = true;
    (async () => {
      try {
        const result: any = await (generateCodeM as any)({});
        const value =
          typeof result === 'string' ? result : (result?.code || result?.referralCode || '');
        if (value) setLocalReferralCode(String(value));
      } catch (errorValue: any) {
        console.warn('[contacts] getOrCreateReferralCode failed:', errorValue?.message);
      }
    })();
  }, [generateCodeM]);
  const referralCode: string = profileCode || localReferralCode || '';
  // iter-186: invites now deep-link to the published Play Store listing
  // (with the referral code in both the referrer param and the text).
  const inviteUrl = buildInviteUrl(referralCode);
  const inviteMessage = buildInviteMessage(referralCode);

  // iter-138: read the current user so we can derive a default country
  // hint for phone-number normalization in invite flows.
  const me = useQuery(api.users.getCurrentUser, {}) as any | undefined;
  const myDefaultCountry = useMemo<string | null>(() => {
    // iter-166: prefer canonical E.164, fall back to legacy `phone`.
    const myPhone = (typeof me?.phoneE164 === 'string' && me.phoneE164)
      || (typeof me?.phone === 'string' && me.phone)
      || '';
    if (!myPhone) return null;
    try {
      const parsed = parsePhoneNumberFromString(myPhone);
      return parsed?.country || null;
    } catch {
      return null;
    }
  }, [me?.phone, me?.phoneE164]);

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
      const data = await fetchAllDeviceContacts([
        Contacts.Fields.Name,
        Contacts.Fields.PhoneNumbers,
        Contacts.Fields.Emails,
      ]);
      // iter-148: align device-contacts surface with the web app.
      // The web shows "INVITE TO SMILERS (N)" with canonical names — only
      // contacts that actually have a usable name and a unique phone.
      // The native list was showing 2,700+ rows including:
      //   • "null" string names (Android quirk for SIM/no-name entries),
      //   • duplicate phones in two formats (e.g. spaced + unspaced),
      //   • placeholder entries with no phone at all.
      // This collapses the surface to what's actually invitable.
      const seenPhones = new Set<string>();
      const cleaned: DeviceContact[] = [];
      for (const raw of data as any[]) {
        const rawName: string =
          (typeof raw?.name === 'string' && raw.name.trim() && raw.name.trim().toLowerCase() !== 'null' && raw.name.trim()) ||
          (typeof raw?.firstName === 'string' && raw.firstName.trim()) ||
          (typeof raw?.lastName === 'string' && raw.lastName.trim()) ||
          '';
        const rawPhone: string | undefined = raw?.phoneNumbers?.[0]?.number;
        const e164 = normalizePhoneE164(rawPhone, myDefaultCountry || null) || (rawPhone || '').trim();
        // Skip rows with neither a real name nor any phone — those are
        // pure noise (SIM "null" entries, placeholder rows).
        if (!rawName && !e164) continue;
        // Dedupe by E.164 — Android often lists the same contact twice
        // because the OS keeps both raw + formatted variants.
        const dedupeKey = e164 || `name:${rawName.toLowerCase()}`;
        if (seenPhones.has(dedupeKey)) continue;
        seenPhones.add(dedupeKey);
        cleaned.push({
          id: raw.id,
          // Always prefer the actual saved name; only fall back to the
          // phone when there really is no name at all.
          name: rawName || e164 || 'Contact',
          phone: e164 || rawPhone,
          email: raw?.emails?.[0]?.email,
        });
      }
      // Sort canonically — names first, then phone-only rows last.
      cleaned.sort((a, b) => {
        const aHasName = /[A-Za-z]/.test(a.name);
        const bHasName = /[A-Za-z]/.test(b.name);
        if (aHasName && !bHasName) return -1;
        if (!aHasName && bHasName) return 1;
        return a.name.localeCompare(b.name);
      });
      setDeviceContacts(cleaned);
      // iter-176: also refresh the GLOBAL device-contact name index so
      // the chats list / chat header / contacts-list pick up the names
      // immediately after the user grants the contacts permission.
      try { void refreshDeviceIndex({ requestPermission: false }); } catch {}
    } catch (errorValue) {
      console.warn('device contacts failed:', errorValue);
      setDevicePerm('denied');
    } finally {
      setDeviceLoading(false);
    }
  }, [refreshDeviceIndex]);

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
    // iter-148: hide device contacts whose phone is already in
    // "My Contacts" (= already a registered Smilers user). Mirrors the
    // web app which shows "INVITE TO SMILERS" — only people NOT yet on
    // Smilers should appear here.
    const myContactPhones = new Set<string>();
    for (const c of list as any[]) {
      const e164 = normalizePhoneE164(c?.phone, myDefaultCountry || null);
      if (e164) myContactPhones.add(e164);
    }
    const q = searchTerm.toLowerCase();
    return deviceContacts.filter((c) => {
      // Drop any device contact whose normalized phone matches a saved
      // Smilers contact — they don't need an invite.
      const e164 = normalizePhoneE164(c.phone, myDefaultCountry || null);
      if (e164 && myContactPhones.has(e164)) return false;
      if (!q) return true;
      return (
        (c.name || '').toLowerCase().includes(q) ||
        (c.phone || '').toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q)
      );
    });
  }, [deviceContacts, list, myDefaultCountry, searchTerm]);

  // iter-223: batch-classify which device contacts are already on Smilers
  // (registered but not yet your contact) via `users.getByPhones`. Dormant
  // until the backend ships that query (lookupUsersByPhones returns empty),
  // then those rows render "Message" instead of "Invite". Runs once per
  // loaded device-contact set, not on every keystroke.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (deviceContacts.length === 0) {
      setRegisteredByDigits(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const phones = deviceContacts.map((c) => c.phone).filter(Boolean) as string[];
      const found = await lookupUsersByPhones(convex, phones, myDefaultCountry);
      if (cancelled || found.size === 0) return;
      // `found` is keyed by full E.164.
      const byE164 = new Map<string, { userId: string; name?: string }>();
      found.forEach((v, e164) => byE164.set(e164, { userId: v.userId, name: v.displayName }));
      if (!cancelled) setRegisteredByDigits(byE164);
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceContacts, convex, myDefaultCountry]);


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
      Alert.alert('Could not open chat', friendlyConvexError(errorValue, 'Could not open chat'));
    }
  };

  const onInviteDevice = useCallback(
    async (c: DeviceContact) => {
      if (!c.phone) {
        Alert.alert('No phone number', 'This device contact has no phone number to invite.');
        return;
      }
      // iter-149: server-side `contacts.sendRequestByPhone` was returning
      // generic "Server Error - Called by client" on every invite, so we
      // now mirror what the web app actually does: open the native share
      // sheet with a pre-baked invite message that carries the user's
      // referral code (if any). User can pick SMS, WhatsApp, Telegram,
      // etc. — works on iOS + Android with zero backend dependency.
      try {
        const result = await Share.share({
          message: `Hi ${c.name?.split(' ')[0] || 'there'} — ${inviteMessage}`,
          title: 'Join me on Smilers',
          url: inviteUrl,
        } as any);
        if (
          (result as any)?.action === Share.dismissedAction &&
          Platform.OS === 'android'
        ) {
          // Android falls through silently when the user cancels — no
          // alert needed. Otherwise we'd nag the user on every dismiss.
        }
      } catch (errorValue: any) {
        Alert.alert('Could not open share sheet', errorValue?.message || 'Try again later.');
      }
    },
    [inviteMessage, inviteUrl],
  );

  // iter-149: top-of-tab "Share invite link" CTA (parity with the
  // dedicated section the web app shows above device contacts).
  const onShareInviteLink = useCallback(async () => {
    try {
      await Share.share({
        message: inviteMessage,
        title: 'Join me on Smilers',
        url: inviteUrl,
      } as any);
    } catch (errorValue: any) {
      if (!String(errorValue?.message || '').toLowerCase().includes('cancel')) {
        Alert.alert('Could not share', errorValue?.message || 'Please try again.');
      }
    }
  }, [inviteMessage, inviteUrl]);

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
  // iter-148: count = the filtered-invitable count (matches web app's
  // "INVITE TO SMILERS (N)" header — only contacts not yet on Smilers).
  const deviceCount = deviceFiltered.length;

  // iter-223: how many of the shown device contacts are already on Smilers
  // (resolved via the batch lookup) — drives the top-of-tab nudge banner.
  const onSmilersCount = useMemo(() => {
    if (registeredByDigits.size === 0) return 0;
    let n = 0;
    for (const c of deviceFiltered) {
      const d = normalizePhoneE164(c.phone, myDefaultCountry) || (c.phone || '').trim();
      if (d && registeredByDigits.has(d)) n += 1;
    }
    return n;
  }, [deviceFiltered, registeredByDigits, myDefaultCountry]);

  // iter-223: tapping the nudge banner filters the Device list to ONLY the
  // contacts already on Smilers, so the user can message them in one tap.
  const [onSmilersOnly, setOnSmilersOnly] = useState(false);
  const deviceListData = useMemo(() => {
    if (!onSmilersOnly) return deviceFiltered;
    return deviceFiltered.filter((c) => {
      const d = normalizePhoneE164(c.phone, myDefaultCountry) || (c.phone || '').trim();
      return d && registeredByDigits.has(d);
    });
  }, [onSmilersOnly, deviceFiltered, registeredByDigits, myDefaultCountry]);
  // Don't get stuck in an empty filtered state (e.g. after a search).
  useEffect(() => {
    if (onSmilersOnly && onSmilersCount === 0) setOnSmilersOnly(false);
  }, [onSmilersOnly, onSmilersCount]);

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
              onPress={() => router.push('/find-by-phone' as any)}
              testID="contacts-find-by-phone-btn"
              accessibilityLabel="Find a Smilers user by phone number"
            >
              <Feather name="user-plus" size={22} color={Colors.white} />
            </TouchableOpacity>
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
                  {pendingList.map((p: any) => {
                    const pName = getResolvedDisplayName(p, deviceIndex, lookupDeviceContactName, getDisplayNameFromUser(p));
                    return (
                    <View key={p._id} style={styles.row} testID={`pending-${p._id}`}>
                      <ContactAvatar name={pName} online={false} />
                      <View style={styles.rowMid}>
                        <Text style={styles.rowName} numberOfLines={1}>
                          {pName}
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
                    );
                  })}
                </>
              ) : null}

              {outgoingList.length > 0 && !searchTerm ? (
                <>
                  <Text style={styles.sectionLabel}>SENT REQUESTS ({outgoingList.length})</Text>
                  {outgoingList.map((o: any) => {
                    const oName = getResolvedDisplayName(o, deviceIndex, lookupDeviceContactName, getDisplayNameFromUser(o));
                    return (
                    <View key={o._id} style={styles.row} testID={`outgoing-${o._id}`}>
                      <ContactAvatar name={oName} online={false} />
                      <View style={styles.rowMid}>
                        <Text style={styles.rowName} numberOfLines={1}>
                          {oName}
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
                    );
                  })}
                </>
              ) : null}

              <Text style={styles.sectionLabel}>
                MY CONTACTS ({searchTerm ? myFiltered.length : myCount})
              </Text>
            </>
          }
          renderItem={({ item }) => {
            const uid = getContactUserId(item);
            // Online only if isOnline is true AND lastSeen is fresh (<2 min) —
            // avoids a stale cached flag showing a permanent green dot.
            const online = isPresenceOnline(item);
            // iter-176: device address-book name takes priority over the
            // Smilers display name. If you have this user's number saved
            // as "ABC Albania", you see "ABC Albania" here.
            const displayName = getResolvedDisplayName(item, deviceIndex, lookupDeviceContactName, getDisplayNameFromUser(item));
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
                    {online
                      ? 'Online'
                      : formatContactLastSeen(item.lastSeen) ||
                        item.about ||
                        'Hey there! I am using Smilers.'}
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
          data={deviceListData}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <>
              {/* iter-149: top-of-list "Share Invite Link" CTA — parity
                  with the web app's dedicated invite-link section above
                  the device contacts list. Opens the native share sheet
                  so users can post the invite to WhatsApp, SMS, etc. */}
              <TouchableOpacity
                style={styles.shareLinkCard}
                onPress={onShareInviteLink}
                activeOpacity={0.8}
                testID="contacts-share-invite-link"
              >
                <View style={styles.shareLinkIcon}>
                  <Feather name="share-2" size={20} color={Colors.primary} />
                </View>
                <View style={styles.shareLinkBody}>
                  <Text style={styles.shareLinkTitle}>Share invite link</Text>
                  <Text style={styles.shareLinkSub} numberOfLines={2}>
                    {referralCode
                      ? `Invite friends and earn rewards · Code ${referralCode}`
                      : 'Invite friends to join you on Smilers'}
                  </Text>
                </View>
                <Feather name="chevron-right" size={20} color={Colors.textMuted} />
              </TouchableOpacity>
              {onSmilersCount > 0 ? (
                <TouchableOpacity
                  style={[styles.onSmilersBanner, onSmilersOnly ? styles.onSmilersBannerActive : null]}
                  onPress={() => setOnSmilersOnly((v) => !v)}
                  activeOpacity={0.8}
                  testID="device-on-smilers-banner"
                >
                  <View style={styles.onSmilersIcon}>
                    <Feather name="smile" size={18} color={Colors.primary} />
                  </View>
                  <Text style={styles.onSmilersText}>
                    {onSmilersOnly
                      ? `Showing ${onSmilersCount} on Smilers · Tap to show all`
                      : onSmilersCount === 1
                        ? '1 of your contacts is already on Smilers — tap to message'
                        : `${onSmilersCount} of your contacts are already on Smilers — tap to message`}
                  </Text>
                  <Feather
                    name={onSmilersOnly ? 'x' : 'chevron-right'}
                    size={18}
                    color={Colors.textMuted}
                  />
                </TouchableOpacity>
              ) : null}
              {devicePerm === 'granted' ? (
                <Text style={styles.sectionLabel}>
                  {onSmilersOnly
                    ? `ON SMILERS (${onSmilersCount})`
                    : `INVITE TO SMILERS (${deviceFiltered.length})`}
                </Text>
              ) : null}
            </>
          }
          renderItem={({ item }) => {
            // iter-223/iter-315: if this device number is already on Smilers,
            // offer "Message"; otherwise "Invite". Keyed by full E.164.
            const digits = normalizePhoneE164(item.phone, myDefaultCountry) || (item.phone || '').trim();
            const registered = digits ? registeredByDigits.get(digits) : undefined;
            return (
              <View style={styles.row} testID={`device-contact-${item.id}`}>
                <ContactAvatar name={item.name} online={false} />
                <View style={styles.rowMid}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {registered ? 'On Smilers' : item.phone || item.email || 'No contact info'}
                  </Text>
                </View>
                {registered ? (
                  <TouchableOpacity
                    style={styles.messageBtn}
                    onPress={() => openChat(registered.userId)}
                    testID={`message-${item.id}`}
                  >
                    <Text style={styles.messageBtnText}>Message</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={styles.inviteBtn}
                    onPress={() => onInviteDevice(item)}
                    testID={`invite-${item.id}`}
                  >
                    <Text style={styles.inviteText}>Invite</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          }}
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
            <KeyboardAvoidingView behavior="padding">
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
  shareLinkCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.base,
    marginBottom: Spacing.sm,
    padding: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  shareLinkIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareLinkBody: { flex: 1 },
  shareLinkTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  shareLinkSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
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
  messageBtn: {
    backgroundColor: Colors.headerBg,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.pill,
  },
  messageBtnText: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.sm },
  onSmilersBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.primaryLight,
    borderRadius: Radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
  },
  onSmilersBannerActive: {
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  onSmilersIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  onSmilersText: { flex: 1, color: Colors.textPrimary, fontWeight: FontWeight.medium, fontSize: FontSize.sm },

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
