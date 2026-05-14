import React, { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  Alert,
  Modal,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery, useMutation } from 'convex/react';
import Header from '../../src/components/Header';
import Avatar from '../../src/components/Avatar';
import { api } from '../../src/convexApi';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../../src/theme';

export default function ContactsScreen() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [showAddSheet, setShowAddSheet] = useState(false);
  const [showAddByPhone, setShowAddByPhone] = useState(false);
  const [phoneInput, setPhoneInput] = useState('');
  const [addingPhone, setAddingPhone] = useState(false);

  const contacts = useQuery(api.contacts.getContacts);
  const pending = useQuery(api.contacts.getPendingRequests);
  const outgoing = useQuery(api.contacts.getOutgoingRequests);
  const searchResults = useQuery(api.users.searchUsers, search.trim().length >= 2 ? { query: search.trim() } : 'skip');
  const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);
  const sendRequest = useMutation(api.contacts.sendRequest);
  const sendRequestByPhone = useMutation(api.contacts.sendRequestByPhone);
  const acceptRequest = useMutation(api.contacts.acceptRequest);
  const rejectRequest = useMutation(api.contacts.rejectRequest);
  const cancelRequest = useMutation(api.contacts.cancelRequest);

  const list: any[] = Array.isArray(contacts) ? contacts : [];
  const pendingList: any[] = Array.isArray(pending) ? pending : [];
  const outgoingList: any[] = Array.isArray(outgoing) ? outgoing : [];
  const results: any[] = Array.isArray(searchResults) ? searchResults : [];

  const contactIds = useMemo(() => new Set(list.map((contact) => contact.userId || contact._id)), [list]);
  const outgoingIds = useMemo(
    () => new Set(outgoingList.map((contact) => contact.userId || contact.targetUserId || contact._id)),
    [outgoingList]
  );
  const incomingIds = useMemo(() => new Set(pendingList.map((contact) => contact.userId || contact._id)), [pendingList]);

  const openChat = async (userId: string) => {
    try {
      const conversation: any = await getOrCreateDirect({ otherUserId: userId });
      const conversationId =
        typeof conversation === 'string' ? conversation : conversation?._id || conversation?.conversationId;
      if (conversationId) {
        router.push(`/chat/${conversationId}` as any);
      }
    } catch (errorValue: any) {
      Alert.alert('Error', errorValue?.message || 'Could not open chat');
    }
  };

  const onAddByPhone = useCallback(async () => {
    const phone = phoneInput.trim();
    if (!phone) return;

    setAddingPhone(true);
    try {
      await sendRequestByPhone({ phone });
      setPhoneInput('');
      setShowAddByPhone(false);
      Alert.alert('Request sent', `An invite was sent to ${phone}.`);
    } catch (errorValue: any) {
      Alert.alert('Could not send invite', errorValue?.message || 'Check the phone number and try again.');
    } finally {
      setAddingPhone(false);
    }
  }, [phoneInput, sendRequestByPhone]);

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="contacts-screen">
      <Header
        title="Contacts"
        variant="dark"
        right={
          <TouchableOpacity
            onPress={() => setShowAddSheet(true)}
            hitSlop={10}
            style={styles.headerAction}
            testID="add-contact-btn"
          >
            <Ionicons name="person-add-outline" size={22} color={Colors.white} />
          </TouchableOpacity>
        }
      />

      <View style={styles.searchWrap}>
        <Feather name="search" size={18} color={Colors.textMuted} />
        <TextInput
          placeholder="Search people by name or email"
          placeholderTextColor={Colors.textMuted}
          value={search}
          onChangeText={setSearch}
          style={styles.searchInput}
          autoCapitalize="none"
          testID="contacts-search"
        />
      </View>

      <FlatList
        data={search.trim().length >= 2 ? results : list}
        keyExtractor={(item: any, index: number) => item.userId || item._id || String(index)}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <>
            {pendingList.length > 0 && search.trim().length < 2 && (
              <>
                <Text style={styles.sectionLabel}>PENDING REQUESTS</Text>
                {pendingList.map((pendingContact: any) => (
                  <View key={pendingContact._id} style={styles.row}>
                    <Avatar name={pendingContact.name} size={44} />
                    <View style={styles.rowMid}>
                      <Text style={styles.rowName}>{pendingContact.name || 'Smilers user'}</Text>
                      <Text style={styles.rowSub}>{pendingContact.email || pendingContact.phone || 'wants to connect'}</Text>
                    </View>
                    <TouchableOpacity
                      style={styles.rejectBtn}
                      onPress={() =>
                        rejectRequest({ contactId: pendingContact._id }).catch((errorValue: any) =>
                          Alert.alert('Failed', errorValue?.message)
                        )
                      }
                      testID={`reject-${pendingContact._id}`}
                    >
                      <Feather name="x" size={20} color={Colors.danger} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.acceptBtn}
                      onPress={() =>
                        acceptRequest({ contactId: pendingContact._id }).catch((errorValue: any) =>
                          Alert.alert('Failed', errorValue?.message)
                        )
                      }
                      testID={`accept-${pendingContact._id}`}
                    >
                      <Text style={styles.acceptText}>Accept</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </>
            )}

            {outgoingList.length > 0 && search.trim().length < 2 && (
              <>
                <Text style={styles.sectionLabel}>SENT REQUESTS</Text>
                {outgoingList.map((outgoingContact: any) => (
                  <View key={outgoingContact._id} style={styles.row}>
                    <Avatar name={outgoingContact.name} size={44} />
                    <View style={styles.rowMid}>
                      <Text style={styles.rowName}>{outgoingContact.name || 'Smilers user'}</Text>
                      <Text style={styles.rowSub}>Awaiting response</Text>
                    </View>
                    <TouchableOpacity
                      style={styles.cancelBtn}
                      onPress={() =>
                        cancelRequest({ contactId: outgoingContact._id }).catch((errorValue: any) =>
                          Alert.alert('Failed', errorValue?.message)
                        )
                      }
                      testID={`cancel-${outgoingContact._id}`}
                    >
                      <Text style={styles.cancelText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </>
            )}

            <Text style={styles.sectionLabel}>{search.trim().length >= 2 ? 'SEARCH RESULTS' : 'CONTACTS'}</Text>
          </>
        }
        renderItem={({ item }) => {
          const uid = item.userId || item._id;
          const isContact = contactIds.has(uid);
          const wasSent = outgoingIds.has(uid);
          const wasReceived = incomingIds.has(uid);

          return (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.7}
              onPress={() => openChat(uid)}
              testID={`contact-${uid}`}
            >
              <Avatar name={item.name} size={44} />
              <View style={styles.rowMid}>
                <Text style={styles.rowName}>{item.name || 'Smilers user'}</Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {item.email || item.about || 'Available'}
                </Text>
              </View>

              {search.trim().length >= 2 ? (
                wasSent ? (
                  <View style={styles.sentPill} testID={`sent-pill-${uid}`}>
                    <Feather name="clock" size={12} color={Colors.textSecondary} />
                    <Text style={styles.sentText}>Sent</Text>
                  </View>
                ) : wasReceived ? (
                  <View style={[styles.sentPill, styles.respondPill]} testID={`respond-pill-${uid}`}>
                    <Text style={[styles.sentText, styles.respondText]}>Respond</Text>
                  </View>
                ) : isContact ? (
                  <View style={[styles.sentPill, styles.contactPill]} testID={`contact-pill-${uid}`}>
                    <Feather name="check" size={12} color="#16a34a" />
                    <Text style={[styles.sentText, styles.contactText]}>Contact</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.addBtn}
                    onPress={() =>
                      sendRequest({ contactId: uid }).catch((errorValue: any) =>
                        Alert.alert('Failed', errorValue?.message)
                      )
                    }
                    testID={`add-${uid}`}
                  >
                    <Ionicons name="person-add-outline" size={18} color={Colors.primary} />
                  </TouchableOpacity>
                )
              ) : (
                <Ionicons name="chatbubble-ellipses-outline" size={22} color={Colors.primary} />
              )}
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          contacts !== undefined ? (
            <View style={styles.empty}>
              <Feather name="users" size={32} color={Colors.textMuted} />
              <Text style={styles.emptyText}>
                {search.trim().length >= 2
                  ? 'No users found'
                  : 'No contacts yet. Tap + at the top to add by phone, QR, or search.'}
              </Text>
            </View>
          ) : null
        }
      />

      <Modal visible={showAddSheet} transparent animationType="fade" onRequestClose={() => setShowAddSheet(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowAddSheet(false)}>
          <Pressable style={styles.sheet} onPress={() => {}} testID="add-contact-sheet">
            <View style={styles.grabber} />
            <Text style={styles.sheetTitle}>Add a contact</Text>
            <View style={styles.tileRow}>
              <Tile
                color="#3B82F6"
                icon="phone"
                lib="feather"
                label="By phone"
                onPress={() => {
                  setShowAddSheet(false);
                  setShowAddByPhone(true);
                }}
                testID="add-by-phone"
              />
              <Tile
                color="#10B981"
                icon="qr-code-scan"
                lib="mc"
                label="Scan QR"
                onPress={() => {
                  setShowAddSheet(false);
                  router.push('/contact-qr?mode=scan' as any);
                }}
                testID="add-scan-qr"
              />
              <Tile
                color="#F59E0B"
                icon="qrcode"
                lib="mc"
                label="My QR"
                onPress={() => {
                  setShowAddSheet(false);
                  router.push('/contact-qr?mode=show' as any);
                }}
                testID="add-show-qr"
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showAddByPhone} transparent animationType="slide" onRequestClose={() => setShowAddByPhone(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowAddByPhone(false)}>
          <Pressable style={styles.sheet} onPress={() => {}} testID="add-by-phone-sheet">
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <View style={styles.grabber} />
              <Text style={styles.sheetTitle}>Add by phone number</Text>
              <Text style={styles.sheetSub}>We'll send an invite if they're not on Smilers yet.</Text>
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
                style={[styles.primaryBtn, (!phoneInput.trim() || addingPhone) ? styles.primaryBtnDisabled : null]}
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
    <TouchableOpacity style={tileStyles.tile} onPress={onPress} testID={testID} activeOpacity={0.8}>
      <View style={[tileStyles.icon, { backgroundColor: color }]}>
        <Icon name={icon as any} size={26} color={Colors.white} />
      </View>
      <Text style={tileStyles.label}>{label}</Text>
    </TouchableOpacity>
  );
}

const tileStyles = StyleSheet.create({
  tile: { alignItems: 'center', gap: 8, flex: 1 },
  icon: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.medium },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  listContent: { paddingBottom: 100 },
  sectionLabel: {
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
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    backgroundColor: Colors.background,
    gap: 8,
  },
  rowMid: { flex: 1, marginLeft: Spacing.md },
  rowName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  headerAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  addBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  acceptBtn: { backgroundColor: Colors.primary, paddingHorizontal: 16, paddingVertical: 8, borderRadius: Radius.pill },
  acceptText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  rejectBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
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
  sentPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    backgroundColor: Colors.borderLight,
  },
  respondPill: { backgroundColor: Colors.primaryLight },
  contactPill: { backgroundColor: '#DCFCE7' },
  sentText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: FontWeight.semibold },
  respondText: { color: Colors.primary },
  contactText: { color: '#16a34a' },
  empty: { alignItems: 'center', paddingTop: Spacing.xxl, paddingHorizontal: Spacing.lg, gap: Spacing.md },
  emptyText: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
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
    marginBottom: Spacing.sm,
    textAlign: 'center',
  },
  sheetSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.md, textAlign: 'center' },
  tileRow: { flexDirection: 'row', justifyContent: 'space-around', gap: Spacing.base, marginTop: Spacing.md },
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
  primaryBtnText: { color: Colors.white, fontSize: FontSize.base, fontWeight: FontWeight.bold },
});