import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { useAuth } from '../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../src/theme';

type MoneyTab = 'send' | 'requests' | 'history';

function formatEur(value: number | undefined | null) {
  return `€${Number(value || 0).toFixed(2)}`;
}

function getContactId(contact: any) {
  return String(contact?._id || contact?.userId || contact?.id || '');
}

export default function SendMoneyScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const [tab, setTab] = useState<MoneyTab>('send');
  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showPickerModal, setShowPickerModal] = useState(false);
  const [transferMode, setTransferMode] = useState<'send' | 'request'>('send');

  const { data: contacts } = useSafeConvexQuery<any[]>(api.contacts.getContacts, {}, [], isAuthenticated);
  const { data: transferHistory, refetch: refetchHistory } = useSafeConvexQuery<any[]>(api.transfers.getTransferHistory, {}, [], isAuthenticated);
  const { data: pendingRequests, refetch: refetchPending } = useSafeConvexQuery<any[]>(api.transfers.getPendingRequests, {}, [], isAuthenticated);
  const sendMoney = useMutation(api.transfers.sendMoney);
  const requestMoney = useMutation(api.transfers.requestMoney);
  const respondToRequest = useMutation(api.transfers.respondToRequest);

  const contactList = useMemo(() => {
    const list = Array.isArray(contacts) ? contacts : [];
    const term = search.trim().toLowerCase();
    if (!term) return list;
    return list.filter((item: any) => `${item?.name || ''} ${item?.phone || ''} ${item?.email || ''}`.toLowerCase().includes(term));
  }, [contacts, search]);

  const quickContacts = useMemo(() => contactList.slice(0, 12), [contactList]);
  const selectedContact = useMemo(
    () => contactList.find((item: any) => getContactId(item) === selectedUserId) || null,
    [contactList, selectedUserId]
  );

  const openTransfer = (mode: 'send' | 'request', contactId?: string) => {
    setTransferMode(mode);
    if (contactId) setSelectedUserId(contactId);
    setShowTransferModal(true);
  };

  const closeTransfer = () => {
    if (busy) return;
    setShowTransferModal(false);
    setAmount('');
    setNote('');
  };

  const runTransferAction = async () => {
    const numericAmount = Number(amount);
    if (!selectedUserId) {
      Alert.alert('Choose a contact', 'Select who you want to pay or request money from.');
      return;
    }
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      Alert.alert('Enter an amount', 'Please enter a valid amount.');
      return;
    }

    setBusy(true);
    try {
      if (transferMode === 'send') {
        let sent = false;
        for (const args of [{ toUserId: selectedUserId, amount: numericAmount, note }, { userId: selectedUserId, amount: numericAmount, note }, { recipientId: selectedUserId, amount: numericAmount, note }]) {
          try {
            await sendMoney(args as any);
            sent = true;
            break;
          } catch {}
        }
        if (!sent) throw new Error('Transfer endpoint rejected the request shape.');
      } else {
        let requested = false;
        for (const args of [{ fromUserId: selectedUserId, amount: numericAmount, note }, { userId: selectedUserId, amount: numericAmount, note }, { toUserId: selectedUserId, amount: numericAmount, note }]) {
          try {
            await requestMoney(args as any);
            requested = true;
            break;
          } catch {}
        }
        if (!requested) throw new Error('Request endpoint rejected the request shape.');
      }

      await refetchHistory();
      await refetchPending();
      closeTransfer();
      Alert.alert(transferMode === 'send' ? 'Money sent' : 'Request sent', transferMode === 'send' ? 'Your transfer has been submitted.' : 'Your request has been submitted.');
    } catch (errorValue: any) {
      Alert.alert('Transfer failed', errorValue?.message || 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const respond = async (requestId: string, action: 'accept' | 'decline') => {
    try {
      let done = false;
      for (const args of [{ requestId, action }, { transferId: requestId, action }, { requestId, accept: action === 'accept' }]) {
        try {
          await respondToRequest(args as any);
          done = true;
          break;
        } catch {}
      }
      if (!done) throw new Error('Response endpoint rejected the request shape.');
      await refetchPending();
      await refetchHistory();
    } catch (errorValue: any) {
      Alert.alert('Could not update request', errorValue?.message || 'Unknown error');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="send-money-screen">
      <View style={styles.header} testID="send-money-header">
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton} testID="send-money-back-button">
          <Ionicons name="arrow-back" size={28} color={Colors.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} testID="send-money-header-title">Send Money</Text>
      </View>

      <View style={styles.tabsRow} testID="send-money-tabs-row">
        <MoneyTabButton label="Send" active={tab === 'send'} onPress={() => setTab('send')} testID="send-money-tab-send" />
        <MoneyTabButton label="Requests" active={tab === 'requests'} onPress={() => setTab('requests')} testID="send-money-tab-requests" />
        <MoneyTabButton label="History" active={tab === 'history'} onPress={() => setTab('history')} testID="send-money-tab-history" />
      </View>

      {tab === 'send' ? (
        <ScrollView contentContainerStyle={styles.content} testID="send-money-send-scroll">
          <View style={styles.actionCardsRow} testID="send-money-action-cards">
            <TouchableOpacity style={[styles.actionCard, styles.actionCardPrimary]} onPress={() => openTransfer('send')} testID="send-money-open-send-card">
              <View style={styles.actionIconWrapPrimary}>
                <Feather name="send" size={24} color={Colors.primary} />
              </View>
              <Text style={styles.actionCardTitle}>Send</Text>
              <Text style={styles.actionCardSub}>Send money instantly</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionCard} onPress={() => openTransfer('request')} testID="send-money-open-request-card">
              <View style={styles.actionIconWrapSecondary}>
                <Feather name="download" size={24} color={Colors.primary} />
              </View>
              <Text style={styles.actionCardTitle}>Request</Text>
              <Text style={styles.actionCardSub}>Ask for a payment</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>QUICK SEND</Text>
            <Text style={styles.sectionCount}>{quickContacts.length} contacts</Text>
          </View>

          {quickContacts.map((contact: any, index: number) => {
            const contactId = getContactId(contact);
            return (
              <View style={styles.quickRow} key={contactId || `contact-${index}`} testID={`send-money-contact-row-${index}`}>
                <View style={styles.quickAvatarWrap}>
                  <Ionicons name="wallet-outline" size={22} color={Colors.primary} />
                </View>
                <View style={styles.flexOne}>
                  <Text style={styles.quickName}>{contact?.name || 'Smilers User'}</Text>
                  <Text style={styles.quickSub}>{contact?.phone || contact?.email || 'Available'}</Text>
                </View>
                <TouchableOpacity style={styles.quickSendButton} onPress={() => openTransfer('send', contactId)} testID={`send-money-quick-send-${index}`}>
                  <Feather name="send" size={18} color={Colors.primary} />
                </TouchableOpacity>
              </View>
            );
          })}
        </ScrollView>
      ) : tab === 'requests' ? (
        <FlatList
          data={Array.isArray(pendingRequests) ? pendingRequests : []}
          keyExtractor={(item: any, index: number) => item._id || `pending-${index}`}
          contentContainerStyle={styles.content}
          renderItem={({ item, index }) => (
            <View style={styles.pendingCard} testID={`pending-transfer-${index}`}>
              <View style={styles.pendingTop}>
                <View style={styles.quickAvatarWrap}>
                  <Feather name="download" size={22} color={Colors.primary} />
                </View>
                <View style={styles.flexOne}>
                  <Text style={styles.pendingTitle}>{item?.fromName || item?.toName || 'Money request'}</Text>
                  <Text style={styles.pendingSub}>{formatEur(item?.amount)} · {item?.note || 'Awaiting response'}</Text>
                </View>
              </View>
              <View style={styles.pendingActions}>
                <TouchableOpacity style={[styles.pendingBtn, styles.pendingBtnGhost]} onPress={() => respond(item._id, 'decline')} testID={`decline-transfer-${index}`}>
                  <Text style={[styles.pendingBtnText, styles.pendingBtnGhostText]}>Decline</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.pendingBtn} onPress={() => respond(item._id, 'accept')} testID={`accept-transfer-${index}`}>
                  <Text style={styles.pendingBtnText}>Accept</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.empty} testID="pending-transfers-empty">
              <Feather name="clock" size={32} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No pending requests</Text>
              <Text style={styles.emptySub}>Money requests waiting for your response will appear here.</Text>
            </View>
          }
        />
      ) : (
        <FlatList
          data={Array.isArray(transferHistory) ? transferHistory : []}
          keyExtractor={(item: any, index: number) => item._id || `history-${index}`}
          contentContainerStyle={styles.content}
          renderItem={({ item, index }) => (
            <View style={styles.historyRow} testID={`transfer-history-${index}`}>
              <View style={styles.historyIconWrap}>
                <Feather name={(item.amount || 0) >= 0 ? 'arrow-down-left' : 'arrow-up-right'} size={16} color={(item.amount || 0) >= 0 ? '#16a34a' : Colors.primary} />
              </View>
              <View style={styles.flexOne}>
                <Text style={styles.historyRowTitle}>{item.title || item.type || 'Transfer'}</Text>
                <Text style={styles.historyRowSub}>{item.status || 'Processed'}{item.note ? ` · ${item.note}` : ''}</Text>
              </View>
              <Text style={[styles.historyAmount, { color: (item.amount || 0) >= 0 ? '#16a34a' : Colors.textPrimary }]}>
                {(item.amount || 0) >= 0 ? '+' : ''}{formatEur(item.amount)}
              </Text>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.empty} testID="transfer-history-empty">
              <Ionicons name="swap-horizontal" size={32} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No transfers yet</Text>
              <Text style={styles.emptySub}>Your sent and requested money history will appear here.</Text>
            </View>
          }
        />
      )}

      <Modal visible={showTransferModal} transparent animationType="slide" onRequestClose={closeTransfer}>
        <Pressable style={styles.modalBackdrop} onPress={closeTransfer}>
          <Pressable style={styles.modalSheet} onPress={() => {}} testID="send-money-transfer-modal">
            <Text style={styles.modalTitle}>{transferMode === 'send' ? 'Send Money' : 'Request Money'}</Text>

            <View style={styles.selectedContactCard} testID="send-money-selected-contact-card">
              <View style={styles.quickAvatarWrap}>
                <Ionicons name="wallet-outline" size={22} color={Colors.primary} />
              </View>
              <View style={styles.flexOne}>
                <Text style={styles.quickName}>{selectedContact?.name || 'Choose contact'}</Text>
                <Text style={styles.quickSub}>{selectedContact?.phone || selectedContact?.email || 'Select a Smilers contact'}</Text>
              </View>
              <TouchableOpacity onPress={() => setShowPickerModal(true)} testID="send-money-change-contact-button">
                <Text style={styles.changeButtonText}>Change</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>Amount</Text>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              placeholder="0.00"
              placeholderTextColor="#9D9385"
              keyboardType="decimal-pad"
              style={styles.amountInput}
              testID="send-money-amount-input"
            />

            <Text style={styles.inputLabel}>Note</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="What is it for?"
              placeholderTextColor="#9D9385"
              style={styles.noteInput}
              testID="send-money-note-input"
            />

            <TouchableOpacity style={[styles.primaryButton, busy ? styles.primaryButtonDisabled : null]} onPress={runTransferAction} disabled={busy} testID="send-money-submit-button">
              <Text style={styles.primaryButtonText}>{busy ? 'Processing…' : transferMode === 'send' ? 'Send Money' : 'Request Money'}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showPickerModal} transparent animationType="slide" onRequestClose={() => setShowPickerModal(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowPickerModal(false)}>
          <Pressable style={[styles.modalSheet, styles.pickerSheet]} onPress={() => {}} testID="send-money-picker-modal">
            <Text style={styles.modalTitle}>Select Contact</Text>
            <View style={styles.searchWrap}>
              <Feather name="search" size={18} color={Colors.textMuted} />
              <TextInput value={search} onChangeText={setSearch} placeholder="Search contacts" placeholderTextColor={Colors.textMuted} style={styles.searchInput} testID="send-money-contact-search" />
            </View>
            <ScrollView contentContainerStyle={styles.pickerContent}>
              {contactList.map((contact: any, index: number) => {
                const contactId = getContactId(contact);
                return (
                  <TouchableOpacity
                    key={contactId || `picker-${index}`}
                    style={styles.contactPickerRow}
                    onPress={() => {
                      setSelectedUserId(contactId);
                      setShowPickerModal(false);
                    }}
                    testID={`send-money-picker-contact-${index}`}
                  >
                    <View style={styles.quickAvatarWrap}>
                      <Ionicons name="wallet-outline" size={22} color={Colors.primary} />
                    </View>
                    <View style={styles.flexOne}>
                      <Text style={styles.quickName}>{contact?.name || 'Smilers User'}</Text>
                      <Text style={styles.quickSub}>{contact?.phone || contact?.email || 'Available'}</Text>
                    </View>
                    {selectedUserId === contactId ? <Feather name="check-circle" size={20} color={Colors.primary} /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function MoneyTabButton({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID: string }) {
  return (
    <TouchableOpacity style={styles.tabButton} onPress={onPress} activeOpacity={0.85} testID={testID}>
      <Text style={[styles.tabText, active ? styles.tabTextActive : null]}>{label}</Text>
      <View style={[styles.tabUnderline, active ? styles.tabUnderlineActive : null]} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F2E8' },
  header: {
    minHeight: 96,
    backgroundColor: Colors.headerBg,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 18,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 28, fontWeight: FontWeight.bold, color: Colors.white, marginLeft: 12 },
  tabsRow: { flexDirection: 'row', backgroundColor: '#F8F2E8', borderBottomWidth: 1, borderBottomColor: '#E6D9C2' },
  tabButton: { flex: 1, alignItems: 'center' },
  tabText: { fontSize: 16, color: '#7A7266', fontWeight: FontWeight.medium, paddingVertical: 16 },
  tabTextActive: { color: Colors.primaryDark, fontWeight: FontWeight.bold },
  tabUnderline: { width: '100%', height: 3, backgroundColor: 'transparent' },
  tabUnderlineActive: { backgroundColor: Colors.primary },
  content: { padding: 16, paddingBottom: 40 },
  actionCardsRow: { flexDirection: 'row', gap: 12, marginBottom: 24 },
  actionCard: {
    flex: 1,
    borderRadius: 22,
    padding: 18,
    backgroundColor: '#FFF8ED',
    borderWidth: 1,
    borderColor: '#E8DCC2',
    ...Shadow.sm,
  },
  actionCardPrimary: { backgroundColor: '#FFF2CC' },
  actionIconWrapPrimary: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#FFF8E1', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  actionIconWrapSecondary: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#EAF3FF', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  actionCardTitle: { fontSize: 20, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  actionCardSub: { marginTop: 4, fontSize: 14, color: Colors.textSecondary },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitle: { fontSize: 18, color: '#7D7569', letterSpacing: 1.4 },
  sectionCount: { fontSize: 13, color: Colors.textMuted },
  quickRow: {
    minHeight: 78,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#EEE2D0',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  quickAvatarWrap: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#FFF2CC', alignItems: 'center', justifyContent: 'center' },
  quickName: { fontSize: 17, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  quickSub: { marginTop: 2, fontSize: 13, color: Colors.textSecondary },
  quickSendButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#F4EBDB', alignItems: 'center', justifyContent: 'center' },
  flexOne: { flex: 1 },
  pendingCard: { backgroundColor: '#FFFFFF', borderRadius: 22, borderWidth: 1, borderColor: '#E8DCC2', padding: 16, gap: 14, marginBottom: 12 },
  pendingTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pendingTitle: { fontSize: 16, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  pendingSub: { fontSize: 14, color: Colors.textSecondary, marginTop: 2 },
  pendingActions: { flexDirection: 'row', gap: 10 },
  pendingBtn: { flex: 1, minHeight: 46, borderRadius: Radius.pill, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  pendingBtnGhost: { backgroundColor: '#FDE2E2' },
  pendingBtnText: { fontSize: 14, fontWeight: FontWeight.bold, color: Colors.white },
  pendingBtnGhostText: { color: Colors.danger },
  historyRow: { minHeight: 74, borderRadius: 20, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E8DCC2', paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  historyIconWrap: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#FFF2CC', alignItems: 'center', justifyContent: 'center' },
  historyRowTitle: { fontSize: 16, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  historyRowSub: { marginTop: 2, fontSize: 13, color: Colors.textSecondary },
  historyAmount: { fontSize: 15, fontWeight: FontWeight.bold },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 40, paddingHorizontal: 22 },
  emptyTitle: { fontSize: 16, fontWeight: FontWeight.semibold, color: Colors.textPrimary, textAlign: 'center' },
  emptySub: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.42)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#F8F2E8', borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 18, paddingBottom: 24 },
  pickerSheet: { maxHeight: '72%' },
  modalTitle: { fontSize: 24, fontWeight: FontWeight.bold, color: Colors.textPrimary, textAlign: 'center', marginBottom: 18 },
  selectedContactCard: { minHeight: 80, borderRadius: 20, backgroundColor: '#FFF8ED', borderWidth: 1, borderColor: '#E8DCC2', paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 18 },
  changeButtonText: { fontSize: 15, color: Colors.primary, fontWeight: FontWeight.semibold },
  inputLabel: { fontSize: 14, color: '#81796C', marginBottom: 8 },
  amountInput: { minHeight: 60, borderRadius: 18, backgroundColor: '#FFFDF8', borderWidth: 1, borderColor: '#E8DCC2', paddingHorizontal: 16, fontSize: 28, color: Colors.textPrimary, marginBottom: 14 },
  noteInput: { minHeight: 56, borderRadius: 18, backgroundColor: '#FFFDF8', borderWidth: 1, borderColor: '#E8DCC2', paddingHorizontal: 16, fontSize: 16, color: Colors.textPrimary, marginBottom: 18 },
  primaryButton: { minHeight: 50, borderRadius: Radius.pill, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  primaryButtonDisabled: { opacity: 0.7 },
  primaryButtonText: { fontSize: 16, fontWeight: FontWeight.bold, color: Colors.white },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FFFDF8', borderRadius: Radius.pill, borderWidth: 1, borderColor: '#E8DCC2', paddingHorizontal: 16, minHeight: 48, marginBottom: 12 },
  searchInput: { flex: 1, fontSize: 16, color: Colors.textPrimary },
  pickerContent: { paddingBottom: 12 },
  contactPickerRow: { minHeight: 72, borderRadius: 18, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E8DCC2', paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
});