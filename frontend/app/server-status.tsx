import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Header from '../src/components/Header';
import { Colors, FontSize, FontWeight, Spacing, Radius } from '../src/theme';

const BACKEND_URL = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');

interface Health {
  status: string;
  degraded: string[];
  integrations: Record<string, boolean>;
  rate_limit_store: string;
  version?: string;
  startedAt?: string;
  uptimeSeconds?: number;
}

const INTEGRATION_LABELS: Record<string, string> = {
  safe_browsing: 'Malicious-link detection',
  openai_transcription: 'Voice transcription',
  llm_translation: 'Auto-translation',
  twilio_video: 'Voice & video calls',
  push: 'Push notifications',
  mongo: 'Database',
};

function formatUptime(seconds?: number): string {
  if (!seconds || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function ServerStatusScreen() {
  const router = useRouter();
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const resp = await fetch(`${BACKEND_URL}/api/health`);
      if (!resp.ok) throw new Error(String(resp.status));
      const data = (await resp.json()) as Health;
      setHealth(data);
    } catch {
      setError(true);
      setHealth(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const isOk = health?.status === 'ok';

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="server-status-screen">
      <Header title="Server Status" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView
        contentContainerStyle={{ padding: Spacing.base, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={Colors.primary} />}
      >
        {loading && !health ? (
          <View style={styles.center} testID="server-status-loading">
            <ActivityIndicator size="large" color={Colors.primary} />
            <Text style={styles.muted}>Checking server…</Text>
          </View>
        ) : error ? (
          <View style={styles.center} testID="server-status-error">
            <Ionicons name="cloud-offline-outline" size={48} color={Colors.danger} />
            <Text style={styles.errorTitle}>Server unreachable</Text>
            <Text style={styles.muted}>Pull down to retry.</Text>
          </View>
        ) : health ? (
          <>
            <View
              style={[styles.statusCard, { backgroundColor: isOk ? '#DCFCE7' : '#FEE2E2' }]}
              testID="server-status-badge"
            >
              <Ionicons
                name={isOk ? 'checkmark-circle' : 'alert-circle'}
                size={28}
                color={isOk ? '#16A34A' : Colors.danger}
              />
              <View style={{ flex: 1 }}>
                <Text style={[styles.statusTitle, { color: isOk ? '#16A34A' : Colors.danger }]}>
                  {isOk ? 'All systems operational' : 'Degraded'}
                </Text>
                {!isOk && health.degraded?.length ? (
                  <Text style={styles.muted}>Issues: {health.degraded.join(', ')}</Text>
                ) : null}
              </View>
            </View>

            <View style={styles.metaCard}>
              <MetaRow label="Version" value={health.version || '—'} />
              <MetaRow label="Uptime" value={formatUptime(health.uptimeSeconds)} />
              <MetaRow
                label="Rate-limit store"
                value={health.rate_limit_store === 'redis' ? 'Redis (shared)' : 'In-memory'}
              />
            </View>

            <Text style={styles.sectionLabel}>INTEGRATIONS</Text>
            <View style={styles.metaCard}>
              {Object.entries(health.integrations || {}).map(([key, up], idx, arr) => (
                <View
                  key={key}
                  style={[styles.intRow, idx < arr.length - 1 ? styles.intDivider : null]}
                  testID={`server-status-int-${key}`}
                >
                  <Ionicons
                    name={up ? 'checkmark-circle' : 'close-circle'}
                    size={20}
                    color={up ? '#16A34A' : Colors.danger}
                  />
                  <Text style={styles.intLabel}>{INTEGRATION_LABELS[key] || key}</Text>
                  <Text style={[styles.intState, { color: up ? '#16A34A' : Colors.danger }]}>
                    {up ? 'Up' : 'Down'}
                  </Text>
                </View>
              ))}
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 80, gap: 12 },
  muted: { fontSize: FontSize.sm, color: Colors.textSecondary },
  errorTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.danger },
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.base,
    borderRadius: Radius.lg,
    marginBottom: Spacing.base,
  },
  statusTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  metaCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.base,
    marginBottom: Spacing.base,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(60, 40, 0, 0.08)',
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
  },
  metaLabel: { fontSize: FontSize.base, color: Colors.textSecondary },
  metaValue: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textMuted,
    letterSpacing: 0.6,
    marginBottom: 8,
    marginLeft: 4,
  },
  intRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: 14 },
  intDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(60, 40, 0, 0.08)' },
  intLabel: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  intState: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
});
