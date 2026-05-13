import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

export default function EmergencyScreen() {
  const router = useRouter();
  const { data: activeAlert, refetch: refetchActiveAlert } = useSafeConvexQuery<any | null>(
    api.emergencyAlerts.getActiveAlert,
    {},
    null
  );
  const { data: myAlerts, refetch: refetchMyAlerts } = useSafeConvexQuery<any[]>(
    api.emergencyAlerts.getMyAlerts,
    {},
    []
  );
  const { data: trustees } = useSafeConvexQuery<any[]>(api.trustees.getMyTrustees, {}, []);
  const { data: panicSettings } = useSafeConvexQuery<any | null>(api.panicMode.getSettings, {}, null);
  const triggerAlert = useMutation(api.emergencyAlerts.triggerAlert);
  const resolveAlert = useMutation(api.emergencyAlerts.resolveAlert);
  const [busy, setBusy] = useState(false);

  const onTriggerSOS = useCallback(async () => {
    Alert.alert('Trigger SOS?', 'Trustees will be notified immediately with your last known location.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'TRIGGER',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await triggerAlert({ source: 'manual', message: 'SOS triggered from mobile app' });
            await Promise.all([refetchActiveAlert(), refetchMyAlerts()]);
            Alert.alert('SOS sent', 'Your trustees have been notified.');
          } catch (errorValue: any) {
            Alert.alert('Failed to send SOS', errorValue?.message || 'Unknown error');
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }, [triggerAlert]);

  const onResolve = useCallback(async () => {
    if (!activeAlert?._id) return;
    setBusy(true);
    try {
      await resolveAlert({ alertId: activeAlert._id });
      await Promise.all([refetchActiveAlert(), refetchMyAlerts()]);
      Alert.alert("I'm safe", 'Your alert has been resolved.');
    } catch (errorValue: any) {
      Alert.alert('Failed', errorValue?.message || 'Unknown error');
    } finally {
      setBusy(false);
    }
  }, [activeAlert, resolveAlert]);

  const trusteeList = trustees || [];
  const alertList = myAlerts || [];

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="emergency-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="emergency-back-button">
          <Ionicons name="chevron-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} testID="emergency-header-title">
          Emergency
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.scrollContent} testID="emergency-scroll-view">
        {activeAlert ? (
          <View style={[styles.alertBanner, styles.alertBannerActive]} testID="emergency-active-alert-banner">
            <Ionicons name="alert-circle" size={28} color="#B91C1C" />
            <View style={styles.flexOne}>
              <Text style={styles.alertTitle} testID="emergency-active-alert-title">
                Active alert
              </Text>
              <Text style={styles.alertSub} testID="emergency-active-alert-subtitle">
                Trustees notified · stays active until resolved
              </Text>
            </View>
            <TouchableOpacity
              style={styles.safeBtn}
              onPress={onResolve}
              disabled={busy}
              testID="emergency-resolve-button"
            >
              <Text style={styles.safeBtnText}>I'm safe</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.sosWrap} testID="emergency-sos-section">
            <TouchableOpacity
              style={styles.sosCircle}
              onPress={onTriggerSOS}
              disabled={busy}
              activeOpacity={0.7}
              testID="emergency-sos-button"
            >
              {busy ? <ActivityIndicator color={Colors.white} size="large" /> : <Text style={styles.sosText}>SOS</Text>}
            </TouchableOpacity>
            <Text style={styles.sosHint} testID="emergency-sos-hint">
              Tap to alert your trustees
            </Text>
          </View>
        )}

        <View style={styles.section} testID="emergency-trustees-section">
          <Text style={styles.sectionTitle} testID="emergency-trustees-title">
            Trustees ({trusteeList.length || 0})
          </Text>
          {trusteeList.length > 0 ? (
            trusteeList.map((trustee: any, index: number) => (
              <View key={trustee._id} style={styles.row} testID={`emergency-trustee-row-${index}`}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{(trustee.name || 'T').charAt(0).toUpperCase()}</Text>
                </View>
                <View style={styles.flexOne}>
                  <Text style={styles.rowTitle} testID={`emergency-trustee-name-${index}`}>
                    {trustee.name || 'Trustee'}
                  </Text>
                  <Text style={styles.rowSub} testID={`emergency-trustee-contact-${index}`}>
                    {trustee.phone || trustee.email || '—'}
                  </Text>
                </View>
              </View>
            ))
          ) : (
            <Text style={styles.empty} testID="emergency-trustees-empty">
              No trustees yet. Add trusted contacts from the web app.
            </Text>
          )}
        </View>

        <View style={styles.section} testID="emergency-panic-section">
          <Text style={styles.sectionTitle} testID="emergency-panic-title">
            Panic Mode
          </Text>
          <View style={styles.row} testID="emergency-panic-row">
            <Ionicons name="pulse" size={22} color={Colors.primary} />
            <View style={styles.flexOne}>
              <Text style={styles.rowTitle} testID="emergency-panic-status">
                {panicSettings?.enabled ? 'Enabled' : 'Disabled'}
              </Text>
              <Text style={styles.rowSub} testID="emergency-panic-description">
                {panicSettings?.enabled
                  ? `Auto-trigger above ${panicSettings.heartRateThreshold || 120} bpm`
                  : 'Heart-rate triggered SOS'}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.section} testID="emergency-history-section">
          <Text style={styles.sectionTitle} testID="emergency-history-title">
            Recent alerts
          </Text>
          {alertList.length > 0 ? (
            alertList.slice(0, 5).map((alertItem: any, index: number) => (
              <View key={alertItem._id} style={styles.row} testID={`emergency-history-row-${index}`}>
                <Ionicons
                  name={alertItem.status === 'active' ? 'alert-circle' : 'checkmark-circle'}
                  size={22}
                  color={alertItem.status === 'active' ? '#B91C1C' : '#16a34a'}
                />
                <View style={styles.flexOne}>
                  <Text style={styles.rowTitle} testID={`emergency-history-type-${index}`}>
                    {alertItem.source === 'manual' ? 'Manual SOS' : 'Panic auto-trigger'}
                  </Text>
                  <Text style={styles.rowSub} testID={`emergency-history-date-${index}`}>
                    {new Date(alertItem._creationTime).toLocaleString()}
                  </Text>
                </View>
                <Text style={styles.statusTag} testID={`emergency-history-status-${index}`}>
                  {alertItem.status}
                </Text>
              </View>
            ))
          ) : (
            <Text style={styles.empty} testID="emergency-history-empty">
              No alerts yet.
            </Text>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#00000022',
  },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  headerSpacer: { width: 26 },
  scrollContent: { paddingBottom: 32 },
  sosWrap: { alignItems: 'center', paddingVertical: 48 },
  sosCircle: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: '#DC2626',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  sosText: { color: Colors.white, fontSize: 56, fontWeight: '800', letterSpacing: 4 },
  sosHint: { color: Colors.textSecondary, marginTop: Spacing.base, fontSize: FontSize.base },
  alertBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: Spacing.base,
    margin: Spacing.base,
    borderRadius: Radius.md,
  },
  alertBannerActive: { backgroundColor: '#FEE2E2' },
  alertTitle: { color: '#7F1D1D', fontWeight: FontWeight.bold, fontSize: FontSize.base },
  alertSub: { color: '#7F1D1D', fontSize: FontSize.sm, opacity: 0.8 },
  safeBtn: {
    backgroundColor: '#16a34a',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    minHeight: 44,
    justifyContent: 'center',
  },
  safeBtnText: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.sm },
  section: { paddingHorizontal: Spacing.base, marginTop: Spacing.lg },
  sectionTitle: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#00000011',
  },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: Colors.primary, fontWeight: FontWeight.bold },
  empty: { color: Colors.textMuted, fontSize: FontSize.sm, paddingVertical: 16, textAlign: 'center' },
  statusTag: { fontSize: 10, color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1 },
  flexOne: { flex: 1 },
});