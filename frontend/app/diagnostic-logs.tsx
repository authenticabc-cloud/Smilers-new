/**
 * Diagnostic Logs viewer.
 *
 * On-device read-only view of every event captured by the global error
 * handler + `callDebug.push` + `recordDiagnostic`. The contents come
 * from AsyncStorage so they survive an app crash and remain available
 * after relaunch.
 *
 * Use case: when the published APK can't reach the diagnostic-logs
 * backend endpoint (because the preview FastAPI server isn't accessible
 * from a physical device, per Emergent's deployment architecture), the
 * user can still open this screen and screenshot it to share the crash
 * trail with the main agent.
 *
 * Routes:
 *   /diagnostic-logs (this screen) — pushed from Settings.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Platform,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather, Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { sentry } from '../src/lib/sentry';
import Header from '../src/components/Header';
import { Colors, FontSize, FontWeight, Spacing } from '../src/theme';
import {
  flushDiagnostics,
  sendDiagnosticHeartbeat,
} from '../src/lib/diagnostics';

const STORAGE_KEY = 'smilers:diagnostic_events:v1';
const SESSION_KEY = 'smilers:diagnostic_session:v1';

interface Event {
  ts: number;
  tag: string;
  message: string;
  stack?: string | null;
  source?: string | null;
}

function readStored(): Promise<Event[]> {
  return AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })
    .catch(() => [] as Event[]);
}

function fmtTs(ts: number): string {
  try {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d
      .getMinutes()
      .toString()
      .padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${(d.getMilliseconds() % 1000)
      .toString()
      .padStart(3, '0')}`;
  } catch {
    return String(ts);
  }
}

function colorForTag(tag: string): string {
  if (tag === 'ERR' || tag === 'FATAL') return '#ff5252';
  if (tag === 'PROMISE') return '#ff9800';
  if (tag === 'PC') return '#00bcd4';
  if (tag === 'SIG') return '#ffeb3b';
  if (tag === 'SCRN') return '#4caf50';
  if (tag === 'CALL') return '#ff9800';
  if (tag === 'HB' || tag === 'BOOT') return '#9c88ff';
  if (tag === 'CONSOLE') return '#bdbdbd';
  return '#90a4ae';
}

export default function DiagnosticLogsScreen() {
  const router = useRouter();
  const [events, setEvents] = useState<Event[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [items, sid] = await Promise.all([
        readStored(),
        AsyncStorage.getItem(SESSION_KEY),
      ]);
      setEvents(items);
      setSessionId(sid);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCopy = useCallback(async () => {
    try {
      const lines = events
        .map((ev) =>
          `[${fmtTs(ev.ts)}] [${ev.tag}] ${ev.source ? `(${ev.source}) ` : ''}${ev.message}${
            ev.stack ? `\n${ev.stack}` : ''
          }`,
        )
        .join('\n');
      const header = `Smilers Diagnostic Log\nSession: ${sessionId || '-'}\nPlatform: ${Platform.OS} ${Platform.Version}\nTotal events: ${events.length}\n----------------------------------------\n`;
      const full = header + lines;
      await Clipboard.setStringAsync(full);
      Alert.alert('Copied', 'Diagnostic log copied to clipboard.');
    } catch (errorValue: any) {
      Alert.alert('Copy failed', errorValue?.message || 'Could not copy log.');
    }
  }, [events, sessionId]);

  const handleShare = useCallback(async () => {
    try {
      const lines = events
        .map((ev) =>
          `[${fmtTs(ev.ts)}] [${ev.tag}] ${ev.source ? `(${ev.source}) ` : ''}${ev.message}${
            ev.stack ? `\n${ev.stack}` : ''
          }`,
        )
        .join('\n');
      const header = `Smilers Diagnostic Log\nSession: ${sessionId || '-'}\nPlatform: ${Platform.OS} ${Platform.Version}\nTotal events: ${events.length}\n----------------------------------------\n`;
      await Share.share({
        message: header + lines,
        title: 'Smilers Diagnostic Log',
      });
    } catch {}
  }, [events, sessionId]);

  const handleRetryUpload = useCallback(async () => {
    try {
      const hb = await sendDiagnosticHeartbeat();
      const flushed = await flushDiagnostics();
      Alert.alert(
        'Upload attempt',
        `Heartbeat ${hb ? 'sent ✓' : 'failed ✗'}\nStored events flushed: ${flushed}`,
      );
      void refresh();
    } catch (errorValue: any) {
      Alert.alert('Upload failed', errorValue?.message || 'Network error.');
    }
  }, [refresh]);

  const handleClear = useCallback(() => {
    Alert.alert(
      'Clear diagnostic log?',
      'This will delete all locally stored crash events. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            try {
              await AsyncStorage.removeItem(STORAGE_KEY);
              await refresh();
            } catch {}
          },
        },
      ],
    );
  }, [refresh]);

  const handleSentryTest = useCallback(() => {
    Alert.alert(
      'Sentry verification',
      'Pick a test crash type:',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'JS Error',
          onPress: () => {
            try {
              sentry.captureMessage('Diagnostic Logs: manual JS test event', 'info');
              sentry.captureException(
                new Error('Manual test exception from Diagnostic Logs screen'),
              );
              Alert.alert(
                'Sent',
                'Sentry event sent. Check the Sentry dashboard in 1-2 minutes.',
              );
            } catch (errorValue: any) {
              Alert.alert('Failed', errorValue?.message || 'Could not send.');
            }
          },
        },
        {
          text: 'NATIVE Crash',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'About to crash',
              'This will deliberately crash the app at the native level to verify Sentry captures NDK crashes. Reopen the app afterward to confirm. Proceed?',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Crash now',
                  style: 'destructive',
                  onPress: () => {
                    try {
                      sentry.nativeCrash();
                    } catch {}
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Header
        title="Diagnostic Logs"
        showBack
        onBack={() => router.back()}
        variant="dark"
      />

      <View style={styles.summary}>
        <Text style={styles.summaryText}>
          {loading ? 'Loading…' : `${events.length} event${events.length === 1 ? '' : 's'} captured`}
        </Text>
        <Text style={styles.summarySub}>
          Session: {sessionId ? sessionId.slice(0, 8) + '…' : '—'} · {Platform.OS} {String(Platform.Version)}
        </Text>
      </View>

      <View style={styles.toolbar}>
        <TouchableOpacity style={styles.toolBtn} onPress={handleCopy}>
          <Feather name="copy" size={16} color={Colors.white} />
          <Text style={styles.toolText}>Copy</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.toolBtn} onPress={handleShare}>
          <Feather name="share-2" size={16} color={Colors.white} />
          <Text style={styles.toolText}>Share</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.toolBtn} onPress={handleRetryUpload}>
          <Feather name="upload-cloud" size={16} color={Colors.white} />
          <Text style={styles.toolText}>Upload</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.toolBtn} onPress={handleSentryTest}>
          <Feather name="alert-triangle" size={16} color="#ffb300" />
          <Text style={[styles.toolText, { color: '#ffb300' }]}>Test Sentry</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolBtn, styles.toolBtnDanger]}
          onPress={handleClear}
        >
          <Ionicons name="trash-outline" size={16} color="#ff5252" />
          <Text style={[styles.toolText, { color: '#ff5252' }]}>Clear</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: 60 }}
      >
        {events.length === 0 && !loading ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              No diagnostic events captured yet.
            </Text>
            <Text style={styles.emptyHint}>
              Events will appear here automatically when the app encounters
              JS errors, unhandled promise rejections, or WebRTC call
              lifecycle steps. Try opening a call screen to generate sample
              events.
            </Text>
          </View>
        ) : (
          events
            .slice()
            .reverse()
            .map((ev, idx) => (
              <View key={`${ev.ts}-${idx}`} style={styles.row}>
                <View style={styles.rowHeader}>
                  <View
                    style={[
                      styles.tagPill,
                      { backgroundColor: colorForTag(ev.tag) + '22' },
                    ]}
                  >
                    <Text
                      style={[
                        styles.tagText,
                        { color: colorForTag(ev.tag) },
                      ]}
                    >
                      {ev.tag}
                    </Text>
                  </View>
                  <Text style={styles.tsText}>{fmtTs(ev.ts)}</Text>
                  {ev.source ? (
                    <Text style={styles.sourceText}>· {ev.source}</Text>
                  ) : null}
                </View>
                <Text style={styles.messageText}>{ev.message}</Text>
                {ev.stack ? (
                  <Text style={styles.stackText}>{ev.stack}</Text>
                ) : null}
              </View>
            ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  summary: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xs,
  },
  summaryText: {
    color: Colors.white,
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
  },
  summarySub: {
    color: Colors.muted,
    fontSize: FontSize.sm,
    marginTop: 2,
  },
  toolbar: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.1)',
    gap: 8,
  },
  toolBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
    gap: 6,
  },
  toolBtnDanger: { backgroundColor: 'rgba(255,82,82,0.12)' },
  toolText: {
    color: Colors.white,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
  },
  empty: {
    paddingTop: 60,
    alignItems: 'center',
  },
  emptyText: {
    color: Colors.white,
    fontSize: FontSize.md,
    fontWeight: FontWeight.medium,
    marginBottom: 8,
  },
  emptyHint: {
    color: Colors.muted,
    fontSize: FontSize.sm,
    textAlign: 'center',
    paddingHorizontal: 32,
    lineHeight: 18,
  },
  row: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    gap: 6,
  },
  tagPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  tagText: {
    fontSize: 10,
    fontWeight: FontWeight.semibold,
    letterSpacing: 0.5,
  },
  tsText: {
    color: Colors.muted,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  sourceText: {
    color: Colors.muted,
    fontSize: 11,
  },
  messageText: {
    color: Colors.white,
    fontSize: 13,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    lineHeight: 18,
  },
  stackText: {
    color: '#ff8a80',
    fontSize: 11,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    marginTop: 6,
    lineHeight: 16,
  },
});
