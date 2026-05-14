import React, { useMemo, useState } from 'react';
import {
  Alert,
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
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { useAuth } from '../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../src/theme';

function formatEur(value: number | undefined | null) {
  const amount = Number(value || 0);
  return `€${amount.toFixed(2)}`;
}

export default function WalletScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const [showAddMethod, setShowAddMethod] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [label, setLabel] = useState('');
  const [providerName, setProviderName] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [selectedMethodId, setSelectedMethodId] = useState('');
  const [savingMethod, setSavingMethod] = useState(false);
  const [requestingWithdrawal, setRequestingWithdrawal] = useState(false);

  const { data: earningsProfile } = useSafeConvexQuery<any | null>(api.earnings.getMyProfile, {}, null, isAuthenticated);
  const { data: methods, refetch: refetchMethods } = useSafeConvexQuery<any[]>(api.wallet.getMyWithdrawalMethods, {}, [], isAuthenticated);
  const { data: withdrawals, refetch: refetchWithdrawals } = useSafeConvexQuery<any[]>(api.wallet.getMyWithdrawals, {}, [], isAuthenticated);
  const addWithdrawalMethod = useMutation(api.wallet.addWithdrawalMethod);
  const removeWithdrawalMethod = useMutation(api.wallet.removeWithdrawalMethod);
  const setDefaultMethod = useMutation(api.wallet.setDefaultMethod);
  const requestWithdrawal = useMutation(api.wallet.requestWithdrawal);

  const level = earningsProfile?.level || 'A';
  const isGold = level === 'Gold';
  const availableMethods = Array.isArray(methods) ? methods : [];
  const recentWithdrawals = Array.isArray(withdrawals) ? withdrawals : [];
  const defaultMethod = useMemo(
    () => availableMethods.find((method: any) => method.isDefault) || availableMethods[0] || null,
    [availableMethods]
  );

  const onSaveMethod = async () => {
    if (!label.trim() || !accountName.trim() || !accountNumber.trim()) {
      Alert.alert('Missing details', 'Please fill in the label, account name, and account number.');
      return;
    }

    setSavingMethod(true);
    try {
      await addWithdrawalMethod({
        label: label.trim(),
        type: 'bank',
        providerName: providerName.trim() || undefined,
        accountName: accountName.trim(),
        accountNumber: accountNumber.trim(),
        isDefault: availableMethods.length === 0,
      } as any);
      setLabel('');
      setProviderName('');
      setAccountName('');
      setAccountNumber('');
      setShowAddMethod(false);
      await refetchMethods();
    } catch (errorValue: any) {
      Alert.alert('Could not add method', errorValue?.message || 'Unknown error');
    } finally {
      setSavingMethod(false);
    }
  };

  const onWithdraw = async () => {
    const amount = Number(withdrawAmount);
    const methodId = selectedMethodId || defaultMethod?._id;
    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert('Enter an amount', 'Please enter a valid withdrawal amount.');
      return;
    }
    if (!methodId) {
      Alert.alert('Choose a method', 'Add or select a withdrawal method first.');
      return;
    }

    setRequestingWithdrawal(true);
    try {
      await requestWithdrawal({ amount, methodId } as any);
      setWithdrawAmount('');
      setSelectedMethodId('');
      setShowWithdraw(false);
      await refetchWithdrawals();
    } catch (errorValue: any) {
      Alert.alert('Could not request withdrawal', errorValue?.message || 'Unknown error');
    } finally {
      setRequestingWithdrawal(false);
    }
  };

  const onSetDefaultMethod = async (methodId: string) => {
    try {
      await setDefaultMethod({ methodId } as any);
      await refetchMethods();
    } catch (errorValue: any) {
      Alert.alert('Could not update default method', errorValue?.message || 'Unknown error');
    }
  };

  const onRemoveMethod = async (methodId: string) => {
    try {
      await removeWithdrawalMethod({ methodId } as any);
      await refetchMethods();
    } catch (errorValue: any) {
      Alert.alert('Could not remove method', errorValue?.message || 'Unknown error');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="wallet-screen">
      <Header title="Gold Wallet" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.heroCard, isGold ? styles.heroCardGold : null]} testID="wallet-hero-card">
          <View style={styles.heroIconWrap}>
            <MaterialCommunityIcons name="wallet-outline" size={24} color={isGold ? '#92400e' : Colors.primary} />
          </View>
          <View style={styles.flexOne}>
            <Text style={styles.heroTitle}>{isGold ? 'Gold cashout enabled' : 'Wallet locked'}</Text>
            <Text style={styles.heroSub}>
              {isGold
                ? 'You can manage withdrawal methods and request payouts.'
                : `Reach Gold level to unlock withdrawals. Current level: ${level}.`}
            </Text>
          </View>
        </View>

        <View style={styles.quickRow}>
          <TouchableOpacity style={styles.quickAction} onPress={() => setShowAddMethod(true)} testID="wallet-add-method-button">
            <Feather name="plus-circle" size={18} color={Colors.primary} />
            <Text style={styles.quickActionText}>Add Method</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.quickAction, !isGold ? styles.quickActionDisabled : null]}
            onPress={() => isGold && setShowWithdraw(true)}
            disabled={!isGold}
            testID="wallet-request-withdrawal-button"
          >
            <Feather name="arrow-up-right" size={18} color={isGold ? Colors.primary : Colors.textMuted} />
            <Text style={[styles.quickActionText, !isGold ? styles.quickActionTextDisabled : null]}>Request Withdrawal</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionTitle}>Withdrawal Methods</Text>
        {availableMethods.length ? (
          availableMethods.map((method: any, index: number) => (
            <View style={styles.methodCard} key={method._id || `method-${index}`} testID={`wallet-method-${index}`}>
              <View style={styles.methodTop}>
                <View style={styles.flexOne}>
                  <Text style={styles.methodLabel}>{method.label || method.providerName || 'Withdrawal method'}</Text>
                  <Text style={styles.methodSub}>{method.accountName || 'Account holder'}</Text>
                  <Text style={styles.methodNumber}>{method.accountNumber || method.maskedAccountNumber || '••••'}</Text>
                </View>
                {method.isDefault ? <View style={styles.defaultChip}><Text style={styles.defaultChipText}>Default</Text></View> : null}
              </View>
              <View style={styles.methodActions}>
                {!method.isDefault ? (
                  <TouchableOpacity style={styles.methodBtn} onPress={() => onSetDefaultMethod(method._id)} testID={`wallet-set-default-${index}`}>
                    <Text style={styles.methodBtnText}>Set default</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={[styles.methodBtn, styles.methodBtnDanger]} onPress={() => onRemoveMethod(method._id)} testID={`wallet-remove-method-${index}`}>
                  <Text style={[styles.methodBtnText, styles.methodBtnDangerText]}>Remove</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))
        ) : (
          <View style={styles.emptyCard} testID="wallet-methods-empty">
            <Ionicons name="wallet-outline" size={30} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>No methods saved</Text>
            <Text style={styles.emptySub}>Add a withdrawal method to cash out when you reach Gold.</Text>
          </View>
        )}

        <Text style={styles.sectionTitle}>Recent Withdrawals</Text>
        {recentWithdrawals.length ? (
          recentWithdrawals.map((withdrawal: any, index: number) => (
            <View style={styles.withdrawalRow} key={withdrawal._id || `withdrawal-${index}`} testID={`wallet-withdrawal-${index}`}>
              <View style={styles.withdrawalIconWrap}>
                <Feather name="arrow-up-right" size={16} color={Colors.primary} />
              </View>
              <View style={styles.flexOne}>
                <Text style={styles.withdrawalTitle}>{formatEur(withdrawal.amount)}</Text>
                <Text style={styles.withdrawalSub}>
                  {withdrawal.status || 'Pending'}
                  {withdrawal.methodLabel ? ` · ${withdrawal.methodLabel}` : ''}
                </Text>
              </View>
              <Text style={styles.withdrawalDate}>
                {withdrawal._creationTime ? new Date(withdrawal._creationTime).toLocaleDateString() : '—'}
              </Text>
            </View>
          ))
        ) : (
          <View style={styles.emptyCard} testID="wallet-withdrawals-empty">
            <Feather name="inbox" size={30} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>No withdrawals yet</Text>
            <Text style={styles.emptySub}>Your cashout requests will appear here.</Text>
          </View>
        )}
      </ScrollView>

      <Modal visible={showAddMethod} transparent animationType="slide" onRequestClose={() => setShowAddMethod(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowAddMethod(false)}>
          <Pressable style={styles.sheet} onPress={() => {}} testID="wallet-add-method-sheet">
            <View style={styles.grabber} />
            <Text style={styles.sheetTitle}>Add withdrawal method</Text>
            <TextInput value={label} onChangeText={setLabel} placeholder="Label (e.g. Main bank)" placeholderTextColor={Colors.textMuted} style={styles.input} testID="wallet-method-label-input" />
            <TextInput value={providerName} onChangeText={setProviderName} placeholder="Bank or provider" placeholderTextColor={Colors.textMuted} style={styles.input} testID="wallet-method-provider-input" />
            <TextInput value={accountName} onChangeText={setAccountName} placeholder="Account holder name" placeholderTextColor={Colors.textMuted} style={styles.input} testID="wallet-method-account-name-input" />
            <TextInput value={accountNumber} onChangeText={setAccountNumber} placeholder="Account number / IBAN" placeholderTextColor={Colors.textMuted} style={styles.input} autoCapitalize="characters" testID="wallet-method-account-number-input" />
            <TouchableOpacity style={[styles.primaryBtn, savingMethod ? styles.disabledBtn : null]} onPress={onSaveMethod} disabled={savingMethod} testID="wallet-save-method-button">
              <Text style={styles.primaryBtnText}>{savingMethod ? 'Saving…' : 'Save Method'}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showWithdraw} transparent animationType="slide" onRequestClose={() => setShowWithdraw(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowWithdraw(false)}>
          <Pressable style={styles.sheet} onPress={() => {}} testID="wallet-withdraw-sheet">
            <View style={styles.grabber} />
            <Text style={styles.sheetTitle}>Request withdrawal</Text>
            <TextInput value={withdrawAmount} onChangeText={setWithdrawAmount} placeholder="Amount in EUR" placeholderTextColor={Colors.textMuted} style={styles.input} keyboardType="decimal-pad" testID="wallet-withdraw-amount-input" />
            <Text style={styles.sheetHint}>Withdrawal method</Text>
            {availableMethods.map((method: any, index: number) => {
              const active = (selectedMethodId || defaultMethod?._id) === method._id;
              return (
                <TouchableOpacity key={method._id || index} style={[styles.methodSelectRow, active ? styles.methodSelectRowActive : null]} onPress={() => setSelectedMethodId(method._id)} testID={`wallet-select-method-${index}`}>
                  <Text style={styles.methodSelectText}>{method.label || method.providerName || 'Method'}</Text>
                  {active ? <Feather name="check" size={16} color={Colors.primary} /> : null}
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity style={[styles.primaryBtn, requestingWithdrawal ? styles.disabledBtn : null]} onPress={onWithdraw} disabled={requestingWithdrawal} testID="wallet-submit-withdrawal-button">
              <Text style={styles.primaryBtnText}>{requestingWithdrawal ? 'Submitting…' : 'Submit Request'}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.base, paddingBottom: 40, gap: Spacing.base },
  heroCard: {
    flexDirection: 'row',
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    ...Shadow.sm,
  },
  heroCardGold: { backgroundColor: '#fef3c7', borderColor: '#fcd34d' },
  heroIconWrap: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  heroSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4, lineHeight: 20 },
  flexOne: { flex: 1 },
  quickRow: { flexDirection: 'row', gap: Spacing.sm },
  quickAction: {
    flex: 1,
    minHeight: 48,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  quickActionDisabled: { opacity: 0.55 },
  quickActionText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  quickActionTextDisabled: { color: Colors.textMuted },
  sectionTitle: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.primary, letterSpacing: 1, marginTop: Spacing.sm },
  methodCard: { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.base, borderWidth: 1, borderColor: Colors.borderLight, gap: Spacing.md },
  methodTop: { flexDirection: 'row', gap: Spacing.md },
  methodLabel: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  methodSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  methodNumber: { fontSize: FontSize.sm, color: Colors.textPrimary, marginTop: 4 },
  defaultChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.pill, backgroundColor: Colors.primaryLight, alignSelf: 'flex-start' },
  defaultChipText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.primary },
  methodActions: { flexDirection: 'row', gap: Spacing.sm },
  methodBtn: { minHeight: 44, paddingHorizontal: Spacing.base, borderRadius: Radius.pill, backgroundColor: Colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  methodBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.primary },
  methodBtnDanger: { backgroundColor: '#fee2e2' },
  methodBtnDangerText: { color: Colors.danger },
  withdrawalRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.base, borderWidth: 1, borderColor: Colors.borderLight },
  withdrawalIconWrap: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  withdrawalTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  withdrawalSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  withdrawalDate: { fontSize: FontSize.xs, color: Colors.textMuted },
  emptyCard: { alignItems: 'center', gap: 8, backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.xl, borderWidth: 1, borderColor: Colors.borderLight },
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: Colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: Spacing.base, paddingTop: Spacing.sm, paddingBottom: Spacing.xl, ...Shadow.lg },
  grabber: { width: 40, height: 4, backgroundColor: Colors.border, borderRadius: 2, alignSelf: 'center', marginVertical: Spacing.sm },
  sheetTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginBottom: Spacing.base },
  sheetHint: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary, marginBottom: 8, marginTop: 4 },
  input: { backgroundColor: Colors.background, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md, paddingVertical: 12, fontSize: FontSize.base, color: Colors.textPrimary, marginBottom: Spacing.sm },
  primaryBtn: { minHeight: 48, borderRadius: Radius.pill, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', marginTop: Spacing.sm },
  primaryBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.white },
  disabledBtn: { opacity: 0.6 },
  methodSelectRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md, marginBottom: Spacing.sm },
  methodSelectRowActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  methodSelectText: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.medium },
});