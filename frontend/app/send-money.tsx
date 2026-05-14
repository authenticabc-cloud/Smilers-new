import React, { useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
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
import Avatar from '../src/components/Avatar';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { useAuth } from '../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

type TransferTab = 'send' | 'request' | 'pending';

function formatEur(value: number | undefined | null) {
  return `€${Number(value || 0).toFixed(2)}`;
}

export default function SendMoneyScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const [tab, setTab] = useState<TransferTab>('send');
  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: contacts } = useSafeConvexQuery<any[]>(api.contacts.getContacts, {}, [], isAuthenticated);
  const { data: transferHistory, refetch: refetchHistory } = useSafeConvexQuery<any[]>(api.transfers.getTransferHistory, {}, [], isAuthenticated);
  const { data: pendingRequests, refetch: refetchPending } = useSafeConvexQuery<any[]>(api.transfers.getPendingRequests, {}, [], isAuthenticated);
  const sendMoney = useMutation(api.transfers.sendMoney);
  const requestMoney = useMutation(api.transfers.requestMoney);
  const respondToRequest = useMutation(api.transfers.respondToRequest);

  const contactList = useMemo(() => {
    const list = Array.isArray(contacts) ? contacts : [];
    if (!search.trim()) return list;
    const normalized = search.trim().toLowerCase();
    return list.filter((item: any) => {
      const name = String(item?.name || '').toLowerCase();
      const email = String(item?.email || '').toLowerCase();
      return name.includes(normalized) || email.includes(normalized);
    });
  }, [contacts, search]);

  const selectedContact = contactList.find((item: any) => item._id === selectedUserId || item.userId === selectedUserId) || null;

  const runTransferAction = async () => {
    const numericAmount = Number(amount);
    if (!selectedUserId) {
      Alert.alert('Choose a contact', 'Select who you want to send or request money from.');
      return;
    }
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      Alert.alert('Enter an amount', 'Please enter a valid amount.');
      return;
    }

    setBusy(true);
    try {
      if (tab === 'send') {
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

      setAmount('');
      setNote('');
      setSelectedUserId('');
      await refetchHistory();
      await refetchPending();
      Alert.alert(tab === 'send' ? 'Money sent' : 'Request sent', tab === 'send' ? 'Your transfer has been submitted.' : 'Your money request has been submitted.');
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
      <Header title="Send Money" showBack onBack={() => router.back()} variant="dark" />

      <View style={styles.segmentWrap} testID="send-money-segments">
        <SegmentButton label="Send" active={tab === 'send'} onPress={() => setTab('send')} testID="send-money-tab-send" />
        <SegmentButton label="Request" active={tab === 'request'} onPress={() => setTab('request')} testID="send-money-tab-request" />
        <SegmentButton label="Pending" active={tab === 'pending'} onPress={() => setTab('pending')} testID="send-money-tab-pending" />
      </View>

      {tab === 'pending' ? (
        <FlatList
          data={Array.isArray(pendingRequests) ? pendingRequests : []}
          keyExtractor={(item: any, index: number) => item._id || `pending-${index}`}
          contentContainerStyle={styles.listContent}
          renderItem={({ item, index }) => (
            <View style={styles.pendingCard} testID={`pending-transfer-${index}`}>
              <View style={styles.pendingTop}>
                <Avatar name={item?.fromName || item?.toName || 'Smilers User'} size={44} />
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
          data={contactList}
          keyExtractor={(item: any, index: number) => item._id || item.userId || `contact-${index}`}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View style={styles.formCard} testID="transfer-form-card">
              <Text style={styles.formTitle}>{tab === 'send' ? 'Send money to a contact' : 'Request money from a contact'}</Text>
              <Text style={styles.formSub}>
                {selectedContact ? `Selected: ${selectedContact.name || 'Smilers User'}` : 'Choose a contact below, then enter an amount.'}
              </Text>
              <View style={styles.searchWrap}>
                <Feather name="search" size={18} color={Colors.textMuted} />
                <TextInput value={search} onChangeText={setSearch} placeholder="Search contacts" placeholderTextColor={Colors.textMuted} style={styles.searchInput} testID="transfer-contact-search" />
              </View>
              <TextInput value={amount} onChangeText={setAmount} placeholder="Amount in EUR" placeholderTextColor={Colors.textMuted} keyboardType="decimal-pad" style={styles.input} testID="transfer-amount-input" />
              <TextInput value={note} onChangeText={setNote} placeholder="Optional note" placeholderTextColor={Colors.textMuted} style={styles.input} testID="transfer-note-input" />
              <TouchableOpacity style={[styles.primaryBtn, (!selectedUserId || !amount || busy) && styles.disabledBtn]} onPress={runTransferAction} disabled={!selectedUserId || !amount || busy} testID="transfer-submit-button">
                <Text style={styles.primaryBtnText}>{busy ? (tab === 'send' ? 'Sending…' : 'Requesting…') : tab === 'send' ? 'Send Money' : 'Request Money'}</Text>
              </TouchableOpacity>
            </View>
          }
          renderItem={({ item, index }) => {
            const uid = item._id || item.userId;
            const selected = uid === selectedUserId;
            return (
              <TouchableOpacity style={[styles.contactRow, selected ? styles.contactRowActive : null]} onPress={() => setSelectedUserId(uid)} testID={`transfer-contact-${index}`}>
                <Avatar name={item?.name || 'Smilers User'} size={46} />
                <View style={styles.flexOne}>
                  <Text style={styles.contactName}>{item?.name || 'Smilers User'}</Text>
                  <Text style={styles.contactSub} numberOfLines={1}>{item?.email || item?.phone || 'Available'}</Text>
                </View>
                {selected ? <Feather name="check-circle" size={20} color={Colors.primary} /> : null}
              </TouchableOpacity>
            );
          }}
          ListFooterComponent={
            <View style={styles.historyWrap} testID="transfer-history-section">
              <Text style={styles.historyTitle}>Recent Activity</Text>
              {(Array.isArray(transferHistory) ? transferHistory : []).length ? (
                (transferHistory as any[]).slice(0, 12).map((entry: any, index: number) => (
                  <View style={styles.historyRow} key={entry._id || `history-${index}`} testID={`transfer-history-${index}`}>
                    <View style={styles.historyIconWrap}>
                      <Feather name={(entry.amount || 0) >= 0 ? 'arrow-down-left' : 'arrow-up-right'} size={16} color={(entry.amount || 0) >= 0 ? '#16a34a' : Colors.primary} />
                    </View>
                    <View style={styles.flexOne}>
                      <Text style={styles.historyRowTitle}>{entry.title || entry.type || 'Transfer'}</Text>
                      <Text style={styles.historyRowSub}>{entry.status || 'Processed'}{entry.note ? ` · ${entry.note}` : ''}</Text>
                    </View>
                    <Text style={[styles.historyAmount, { color: (entry.amount || 0) >= 0 ? '#16a34a' : Colors.textPrimary }]}>
                      {(entry.amount || 0) >= 0 ? '+' : ''}{formatEur(entry.amount)}
                    </Text>
                  </View>
                ))
              ) : (
                <View style={styles.empty} testID="transfer-history-empty">
                  <Ionicons name="swap-horizontal" size={32} color={Colors.textMuted} />
                  <Text style={styles.emptyTitle}>No transfers yet</Text>
                  <Text style={styles.emptySub}>Your sent and requested money history will appear here.</Text>
                </View>
              )}
            </View>
          }
          ListEmptyComponent={
            <View style={styles.empty} testID="transfer-contacts-empty">
              <Feather name="users" size={32} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No contacts found</Text>
              <Text style={styles.emptySub}>Add contacts first before sending or requesting money.</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

function SegmentButton({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID: string }) {
  return (
    <TouchableOpacity style={[styles.segmentButton, active ? styles.segmentButtonActive : null]} onPress={onPress} activeOpacity={0.85} testID={testID}>
      <Text style={[styles.segmentText, active ? styles.segmentTextActive : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  segmentWrap: { flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.base, paddingTop: Spacing.base },
  segmentButton: { flex: 1, minHeight: 44, borderRadius: Radius.pill, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  segmentButtonActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  segmentText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: Colors.textPrimary },
  segmentTextActive: { color: Colors.white, fontWeight: FontWeight.bold },
  listContent: { padding: Spacing.base, paddingBottom: 40, gap: Spacing.base },
  formCard: { backgroundColor: Colors.surface, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.borderLight, padding: Spacing.base, gap: Spacing.sm },
  formTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  formSub: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.background, borderRadius: Radius.pill, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md, minHeight: 46 },
  searchInput: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  input: { backgroundColor: Colors.background, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md, paddingVertical: 12, fontSize: FontSize.base, color: Colors.textPrimary },
  primaryBtn: { minHeight: 48, borderRadius: Radius.pill, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  primaryBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.white },
  disabledBtn: { opacity: 0.6 },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, backgroundColor: Colors.surface, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.borderLight, padding: Spacing.base },
  contactRowActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  flexOne: { flex: 1 },
  contactName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  contactSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  historyWrap: { marginTop: Spacing.base, gap: Spacing.sm },
  historyTitle: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.primary, letterSpacing: 1 },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, backgroundColor: Colors.surface, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.borderLight, padding: Spacing.base },
  historyIconWrap: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  historyRowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  historyRowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  historyAmount: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  pendingCard: { backgroundColor: Colors.surface, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.borderLight, padding: Spacing.base, gap: Spacing.md },
  pendingTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  pendingTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  pendingSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  pendingActions: { flexDirection: 'row', gap: Spacing.sm },
  pendingBtn: { flex: 1, minHeight: 44, borderRadius: Radius.pill, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  pendingBtnGhost: { backgroundColor: '#fee2e2' },
  pendingBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.white },
  pendingBtnGhostText: { color: Colors.danger },
  empty: { alignItems: 'center', gap: 8, paddingVertical: Spacing.xl, paddingHorizontal: Spacing.lg },
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary, textAlign: 'center' },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
});