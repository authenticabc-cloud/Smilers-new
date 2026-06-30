import React, { useCallback, useMemo, useState } from 'react';
import {
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
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { useAuth } from '../src/providers/AuthProvider';
import { getResolvedDisplayName } from '../src/lib/displayName';
import { useDeviceContactIndex, lookupDeviceContactName } from '../src/lib/deviceContactIndex';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

const MAX_TRUSTEES = 5;

interface Trustee {
  _id: string;
  name?: string;
  phone?: string;
  email?: string;
  contactId?: string;
}

interface SmilersContact {
  _id?: string;
  id?: string;
  userId?: string;
  name?: string;
  phone?: string;
  email?: string;
}

function normalizeValue(value?: string) {
  return (value || '').trim().toLowerCase();
}

function normalizePhone(value?: string) {
  return (value || '').replace(/\D/g, '');
}

function getContactKey(contact: SmilersContact) {
  return String(contact.userId || contact._id || contact.id || contact.phone || contact.email || contact.name || 'contact');
}

export default function TrusteesScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { data: trustees, loading, refetch } = useSafeConvexQuery<Trustee[]>(
    api.trustees.getMyTrustees,
    {},
    [],
    isAuthenticated,
  );
  const { data: contacts, loading: contactsLoading } = useSafeConvexQuery<SmilersContact[]>(
    api.contacts.getContacts,
    {},
    [],
    isAuthenticated,
  );
  // iter-181: DM conversation peers are GUARANTEED registered Smilers
  // users (they have a user `_id`), unlike `contacts.getContacts` rows
  // whose user-link field varies by backend shape. Merging both sources
  // fixes "No Smilers contacts available" appearing for users who
  // clearly have active chats.
  const { data: conversations, loading: conversationsLoading } = useSafeConvexQuery<any[]>(
    api.conversations.listConversations,
    {},
    [],
    isAuthenticated,
  );
  const deviceIndex = useDeviceContactIndex();
  const addTrustee = useMutation(api.trustees.addTrustee);
  const removeTrustee = useMutation(api.trustees.removeTrustee);

  const trusteeList = useMemo(() => trustees || [], [trustees]);
  const atCap = trusteeList.length >= MAX_TRUSTEES;

  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const existingTrusteeKeys = useMemo(() => {
    const keys = new Set<string>();
    trusteeList.forEach((item) => {
      if (item.contactId) keys.add(normalizeValue(item.contactId));
      if (item.phone) keys.add(normalizePhone(item.phone));
      if (item.email) keys.add(normalizeValue(item.email));
      if (item.name) keys.add(normalizeValue(item.name));
    });
    return keys;
  }, [trusteeList]);

  const availableContacts = useMemo(() => {
    const query = search.trim().toLowerCase();
    const byUser = new Map<string, SmilersContact & { userId: string }>();
    const seenPhones = new Set<string>();

    const pushCandidate = (raw: any, userIdValue: string) => {
      const id = String(userIdValue || '').trim();
      if (!id || byUser.has(id)) return;
      const phoneRaw = raw?.phone || raw?.phoneE164 || '';
      const phoneKey = normalizePhone(phoneRaw);
      if (phoneKey && seenPhones.has(phoneKey)) return;
      // iter-181: device-saved contact name first (matches Chats/Contacts).
      const name =
        getResolvedDisplayName(raw, deviceIndex, lookupDeviceContactName, '') ||
        (typeof raw?.name === 'string' && raw.name.trim()) ||
        'Smilers Contact';
      byUser.set(id, { userId: id, name, phone: phoneRaw || undefined, email: raw?.email });
      if (phoneKey) seenPhones.add(phoneKey);
    };

    // Source 1 — DM conversation peers: guaranteed registered users.
    for (const conv of Array.isArray(conversations) ? conversations : []) {
      if (conv?.isGroup || conv?.type === 'group') continue;
      const peer = conv?.otherUser || conv?.peer || {};
      const peerId = peer?._id || peer?.userId || conv?.otherUserId;
      if (peerId) pushCandidate(peer, String(peerId));
    }

    // Source 2 — Smilers contacts. iter-181: ALSO accept the row `_id`
    // as the user reference (exactly like the Contacts tab's
    // getContactUserId helper, which successfully opens chats with it).
    // The previous strict field list filtered out EVERY contact on
    // backends that return user-shaped rows → "No Smilers contacts
    // available". Pending invites (status pending/invited/requested)
    // are still excluded — they're not registered users yet.
    for (const contact of Array.isArray(contacts) ? contacts : []) {
      const status = normalizeValue((contact as any)?.status);
      if (/pending|invit|request/.test(status)) continue;
      const linkedUserId =
        (contact as any)?.userId ||
        (contact as any)?.user?._id ||
        (contact as any)?.user?.userId ||
        (contact as any)?.contactUserId ||
        (contact as any)?.targetUserId ||
        (contact as any)?.otherUserId ||
        (contact as any)?.linkedUserId ||
        (contact as any)?._id ||
        (contact as any)?.id;
      if (linkedUserId) pushCandidate(contact, String(linkedUserId));
    }

    return Array.from(byUser.values())
      .filter((contact) => {
        const phoneKey = normalizePhone(contact.phone);
        const emailKey = normalizeValue(contact.email);
        const idKey = normalizeValue(contact.userId);
        const nameKey = normalizeValue(contact.name);
        if (
          (idKey && existingTrusteeKeys.has(idKey)) ||
          (phoneKey && existingTrusteeKeys.has(phoneKey)) ||
          (emailKey && existingTrusteeKeys.has(emailKey)) ||
          (nameKey && existingTrusteeKeys.has(nameKey))
        ) {
          return false;
        }
        if (!query) return true;
        const haystack = `${contact.name || ''} ${contact.phone || ''}`.toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [contacts, conversations, deviceIndex, existingTrusteeKeys, search]);

  const openAdd = useCallback(() => {
    if (atCap) {
      Alert.alert('Trustee limit reached', `You can add up to ${MAX_TRUSTEES} trustees.`);
      return;
    }
    setSearch('');
    setModalOpen(true);
  }, [atCap]);

  const closeModal = useCallback(() => {
    if (submittingKey) return;
    setModalOpen(false);
    setSearch('');
  }, [submittingKey]);

  const onAddContact = useCallback(
    async (contact: SmilersContact) => {
      const contactKey = getContactKey(contact);
      if (atCap) {
        Alert.alert('Trustee limit reached', `You can add up to ${MAX_TRUSTEES} trustees.`);
        return;
      }
      // iter-141: expanded `userId` resolution. Different Convex
      // contact response shapes have been observed: `userId`,
      // `user._id`, `contactUserId`, even `targetUserId`. We probe all
      // common variants so users can be added as trustees regardless
      // of which field the backend populated for this contact row.
      const trusteeUserId =
        (contact as any)?.userId ||
        (contact as any)?.user?._id ||
        (contact as any)?.user?.userId ||
        (contact as any)?.contactUserId ||
        (contact as any)?.targetUserId ||
        (contact as any)?.otherUserId ||
        (contact as any)?.linkedUserId;
      if (!trusteeUserId) {
        Alert.alert(
          'Not a Smilers user',
          'You can only add registered Smilers users as trustees. Ask this contact to install Smilers and accept your invite first.',
        );
        return;
      }
      setSubmittingKey(contactKey);
      try {
        await addTrustee({ trusteeId: trusteeUserId });
        await refetch();
        setModalOpen(false);
        setSearch('');
      } catch (errorValue: any) {
        Alert.alert('Could not add trustee', errorValue?.message || 'Please try again.');
      } finally {
        setSubmittingKey(null);
      }
    },
    [addTrustee, atCap, refetch],
  );

  const onRemove = useCallback(
    (trustee: Trustee) => {
      const displayName =
        getResolvedDisplayName(
          trustee,
          deviceIndex,
          lookupDeviceContactName,
          trustee.name || 'this trustee',
        ) || 'this trustee';
      Alert.alert(
        `Remove ${displayName}?`,
        'They will no longer be notified in an emergency.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              setRemovingId(trustee._id);
              try {
                // iter-137: canonical arg key is `trusteeEntryId`
                // (the Convex row `_id`), NOT `trusteeId` (which is the
                // user id). `trustee._id` here IS the entry row id
                // (came from `getMyTrustees`), so the value is correct;
                // only the key name was wrong.
                await removeTrustee({ trusteeEntryId: trustee._id });
                await refetch();
              } catch (errorValue: any) {
                Alert.alert('Could not remove trustee', errorValue?.message || 'Please try again.');
              } finally {
                setRemovingId(null);
              }
            },
          },
        ],
      );
    },
    [refetch, removeTrustee, deviceIndex],
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="trustees-screen">
      <View style={styles.header} testID="trustees-header">
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton} testID="trustees-back-button">
          <Ionicons name="arrow-back" size={28} color={Colors.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} testID="trustees-header-title">Trustees</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} testID="trustees-scroll-view">
        <View style={styles.introPanel} testID="trustees-intro-panel">
          <Text style={styles.introText}>
            Trustees are your emergency contacts (max 5). They will be notified with your live location when you trigger an emergency alert.
          </Text>
        </View>

        {loading && trusteeList.length === 0 ? (
          <View style={styles.loadingWrap} testID="trustees-loading-state">
            <ActivityIndicator color={Colors.primary} />
          </View>
        ) : (
          <View style={styles.cardsWrap} testID="trustees-cards-wrap">
            {trusteeList.map((trustee, index) => {
              // iter-303: device address-book name wins on the saved cards too.
              const resolvedName =
                getResolvedDisplayName(
                  trustee,
                  deviceIndex,
                  lookupDeviceContactName,
                  trustee.name || 'Trustee',
                ) || 'Trustee';
              return (
              <View key={trustee._id} style={styles.trusteeCard} testID={`trustees-card-${index}`}>
                <View style={styles.trusteeBadgeCircle}>
                  <Ionicons name="shield-checkmark-outline" size={26} color={Colors.primary} />
                </View>
                <View style={styles.trusteeTextWrap}>
                  <Text style={styles.trusteeName} numberOfLines={1} testID={`trustees-name-${index}`}>
                    {resolvedName.toUpperCase()}
                  </Text>
                  <Text style={styles.trusteeMeta} numberOfLines={1} testID={`trustees-meta-${index}`}>
                    {trustee.phone || trustee.email || 'Smilers Contact'}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => onRemove(trustee)}
                  style={styles.removeButton}
                  disabled={removingId === trustee._id}
                  testID={`trustees-remove-${index}`}
                >
                  {removingId === trustee._id ? (
                    <ActivityIndicator size="small" color={Colors.danger} />
                  ) : (
                    <Ionicons name="close" size={34} color={Colors.danger} />
                  )}
                </TouchableOpacity>
              </View>
              );
            })}

            {!atCap ? (
              <TouchableOpacity style={styles.addTrusteeCard} onPress={openAdd} testID="trustees-add-card">
                <View style={styles.addBadgeCircle}>
                  <Ionicons name="add" size={30} color={Colors.primary} />
                </View>
                <Text style={styles.addTrusteeText}>Add Trustee ({trusteeList.length}/{MAX_TRUSTEES})</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}
      </ScrollView>

      <Modal visible={modalOpen} transparent animationType="slide" onRequestClose={closeModal}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalBackdrop}>
          <TouchableOpacity style={styles.modalScrim} activeOpacity={1} onPress={closeModal} testID="trustees-modal-scrim" />
          <View style={styles.modalSheet} testID="trustees-modal-sheet">
            <View style={styles.modalHeader}>
              <View style={styles.modalHeaderSpacer} />
              <Text style={styles.modalTitle} testID="trustees-modal-title">Add Trustee</Text>
              <TouchableOpacity onPress={closeModal} style={styles.modalCloseButton} testID="trustees-modal-close">
                <Ionicons name="close" size={26} color={Colors.textPrimary} />
              </TouchableOpacity>
            </View>

            <View style={styles.searchShell} testID="trustees-search-shell">
              <Ionicons name="search-outline" size={28} color={Colors.textMuted} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search by name or phone..."
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.searchInput}
                testID="trustees-search-input"
              />
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalListContent} testID="trustees-modal-list">
              {contactsLoading || conversationsLoading ? (
                <View style={styles.loadingWrap} testID="trustees-contacts-loading">
                  <ActivityIndicator color={Colors.primary} />
                </View>
              ) : availableContacts.length === 0 ? (
                <View style={styles.emptyModal} testID="trustees-contacts-empty">
                  <Ionicons name="people-outline" size={34} color={Colors.textMuted} />
                  <Text style={styles.emptyModalTitle}>No Smilers contacts available</Text>
                  <Text style={styles.emptyModalBody}>
                    Trustees must be registered Smilers users. Invite a contact from the Contacts tab — once they accept and install Smilers, they&apos;ll appear here.
                  </Text>
                </View>
              ) : (
                availableContacts.map((contact, index) => {
                  const contactKey = getContactKey(contact);
                  const adding = submittingKey === contactKey;
                  return (
                    <View key={contactKey} style={styles.contactRow} testID={`trustees-contact-row-${index}`}>
                      <View style={styles.trusteeBadgeCircle}>
                        <Ionicons name="shield-checkmark-outline" size={26} color={Colors.primary} />
                      </View>
                      <View style={styles.contactTextWrap}>
                        <Text style={styles.contactName} numberOfLines={1} testID={`trustees-contact-name-${index}`}>
                          {contact.name || 'Smilers Contact'}
                        </Text>
                        <Text style={styles.contactMeta} numberOfLines={1} testID={`trustees-contact-meta-${index}`}>
                          {contact.phone || contact.email || 'Smilers user'}
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => onAddContact(contact)}
                        style={styles.contactAddButton}
                        disabled={adding}
                        testID={`trustees-contact-add-${index}`}
                      >
                        {adding ? (
                          <ActivityIndicator size="small" color={Colors.primary} />
                        ) : (
                          <Ionicons name="add" size={30} color={Colors.primary} />
                        )}
                      </TouchableOpacity>
                    </View>
                  );
                })
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F6F1E7',
  },
  header: {
    minHeight: 116,
    backgroundColor: Colors.headerBg,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 20,
  },
  headerButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: FontWeight.bold,
    color: Colors.white,
    marginLeft: 18,
  },
  headerSpacer: {
    flex: 1,
  },
  content: {
    paddingBottom: 48,
  },
  introPanel: {
    backgroundColor: '#EFE6D6',
    paddingHorizontal: 22,
    paddingVertical: 28,
    borderBottomWidth: 1,
    borderBottomColor: '#DDD2BF',
  },
  introText: {
    fontSize: 17,
    lineHeight: 42 / 1.5,
    color: '#6C655A',
  },
  loadingWrap: {
    paddingTop: Spacing.xxl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardsWrap: {
    paddingHorizontal: 18,
    paddingTop: 18,
    gap: 16,
  },
  trusteeCard: {
    minHeight: 110,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#E1D7C8',
    backgroundColor: '#F7F2E7',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    gap: 16,
  },
  trusteeBadgeCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#FBF4DB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trusteeTextWrap: {
    flex: 1,
  },
  trusteeName: {
    fontSize: 16,
    fontWeight: FontWeight.semibold,
    color: '#1F1711',
  },
  trusteeMeta: {
    marginTop: 2,
    fontSize: 13,
    color: '#6E665B',
  },
  removeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addTrusteeCard: {
    minHeight: 122,
    borderRadius: 22,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#E8CC74',
    backgroundColor: '#F9F4EA',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    gap: 18,
  },
  addBadgeCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#FBF4DB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addTrusteeText: {
    fontSize: 21,
    fontWeight: FontWeight.medium,
    color: '#E0B82B',
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.34)',
  },
  modalSheet: {
    maxHeight: '76%',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    backgroundColor: '#F8F2E8',
    paddingTop: 18,
    paddingHorizontal: 16,
    paddingBottom: 20,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  modalHeaderSpacer: {
    width: 44,
  },
  modalTitle: {
    fontSize: 24,
    fontWeight: FontWeight.bold,
    color: '#1F1711',
  },
  modalCloseButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchShell: {
    minHeight: 78,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: '#E7BF3B',
    backgroundColor: '#FCF7EE',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
  },
  searchInput: {
    flex: 1,
    fontSize: 18,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },
  modalListContent: {
    paddingTop: 18,
    paddingBottom: 24,
  },
  contactRow: {
    minHeight: 92,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#ECE1D2',
  },
  contactTextWrap: {
    flex: 1,
  },
  contactName: {
    fontSize: 18,
    fontWeight: FontWeight.semibold,
    color: '#1F1711',
  },
  contactMeta: {
    marginTop: 3,
    fontSize: 15,
    color: '#6E665B',
  },
  contactAddButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyModal: {
    alignItems: 'center',
    gap: 8,
    paddingTop: Spacing.xl,
    paddingHorizontal: Spacing.lg,
  },
  emptyModalTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  emptyModalBody: {
    fontSize: FontSize.sm,
    textAlign: 'center',
    color: Colors.textSecondary,
  },
});