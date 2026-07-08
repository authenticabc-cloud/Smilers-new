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
import Constants from 'expo-constants';
import { useQuery } from 'convex/react';
import { api } from '../src/convexApi';
import { sentry } from '../src/lib/sentry';
import Header from '../src/components/Header';
import { Colors, FontSize, FontWeight, Spacing } from '../src/theme';
import {
  flushDiagnostics,
  sendDiagnosticHeartbeat,
  recordDiagnostic,
  probeBackendHealth,
} from '../src/lib/diagnostics';
import { readStoredJson } from '../src/lib/settingsStorage';
import {
  useDeviceContactIndex,
  lookupDeviceContactName,
} from '../src/lib/deviceContactIndex';
import { getResolvedDisplayName, getSavedContactRecord } from '../src/lib/displayName';
import { triggerEmergentSelfTestPush } from '../src/push/useEmergentPush';
import { useAuth } from '../src/providers/AuthProvider';
import { forceConvexReconnect } from '../src/providers/useConvexAutoReconnect';

const STORAGE_KEY = 'smilers:diagnostic_events:v1';
const SESSION_KEY = 'smilers:diagnostic_session:v1';
const VOICE_TASKS_STORAGE_KEY = 'smilers_voice_task_contacts_v1';

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
  if (tag === 'HEALTH') return '#4dd0e1';
  if (tag === 'CONSOLE') return '#bdbdbd';
  return '#90a4ae';
}

export default function DiagnosticLogsScreen() {
  const router = useRouter();
  const { userInfo } = useAuth();
  const [events, setEvents] = useState<Event[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningPushTest, setRunningPushTest] = useState(false);

  // iter-312: on-device "state snapshot" so a tester can copy the exact
  // contacts-index / voice-task / keyboard-env state and paste it back —
  // turning multi-hour native-build round-trips into seconds. Read-only.
  const deviceIndex = useDeviceContactIndex();
  const contacts = useQuery(api.contacts.getContacts, {}) as any[] | undefined;
  const voiceTasksConvex = useQuery(
    (api as any).voiceTaskContacts?.getMyVoiceTaskContacts,
    {},
  ) as any[] | undefined;
  const conversationsList = useQuery(api.conversations.listConversations, {}) as any[] | undefined;
  const listGroupsData = useQuery((api as any).conversations.listGroups, {}) as any[] | undefined;
  const [localVoiceTasks, setLocalVoiceTasks] = useState<Record<string, any> | null>(null);
  useEffect(() => {
    (async () => {
      const local = await readStoredJson(VOICE_TASKS_STORAGE_KEY, null);
      setLocalVoiceTasks(local as Record<string, any> | null);
    })();
  }, []);

  const buildSnapshot = useCallback((): string => {
    const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL || '(missing)';
    const edgeToEdge = (Constants?.expoConfig?.android as any)?.edgeToEdgeEnabled;
    const lines: string[] = [];
    lines.push('===== SMILERS STATE SNAPSHOT =====');
    lines.push(`Time: ${new Date().toISOString()}`);
    lines.push(`Platform: ${Platform.OS} ${String(Platform.Version)}`);
    lines.push(`App: ${Constants?.expoConfig?.version || '?'}`);
    lines.push(`Backend: ${backendUrl.replace(/^https?:\/\//, '')}`);
    lines.push('');
    lines.push('--- Keyboard / env ---');
    lines.push(`edgeToEdgeEnabled: ${edgeToEdge}`);
    lines.push(
      `KAV behavior: ${Platform.OS === 'ios' ? 'padding (iOS)' : 'height (Android)'}`,
    );
    lines.push('');
    lines.push('--- Device Contact Index ---');
    lines.push(`isReady: ${deviceIndex?.isReady}`);
    lines.push(`entries (byE164): ${deviceIndex?.byE164?.size ?? 0}`);
    lines.push(`entries (byDigits): ${deviceIndex?.byDigits?.size ?? 0}`);
    lines.push(`defaultCountry: ${deviceIndex?.defaultCountry || '(none)'}`);
    lines.push(
      `lastRefreshedAt: ${
        deviceIndex?.lastRefreshedAt
          ? new Date(deviceIndex.lastRefreshedAt).toISOString()
          : 'never'
      }`,
    );
    lines.push(`Smilers contacts (getContacts): ${Array.isArray(contacts) ? contacts.length : '(loading)'}`);
    lines.push('');
    lines.push('--- Voice Tasks (name resolution) ---');
    lines.push(`Convex rows: ${Array.isArray(voiceTasksConvex) ? voiceTasksConvex.length : '(loading)'}`);
    lines.push(`Local rows: ${localVoiceTasks ? Object.keys(localVoiceTasks).length : 0}`);
    const rows = Array.isArray(voiceTasksConvex) ? voiceTasksConvex : [];
    for (const r of rows) {
      const contactId = String(r?.contactId || r?.userId || '');
      const stored = String(r?.name || '');
      const full = getSavedContactRecord(contacts, { userId: contactId }) || {
        userId: contactId,
        name: stored,
      };
      const resolved = getResolvedDisplayName(
        full,
        deviceIndex,
        lookupDeviceContactName,
        stored || 'Contact',
      );
      const phone = (full as any)?.phoneE164 || (full as any)?.phone || '(none)';
      const changed = resolved !== stored ? ' [OVERRIDDEN✓]' : '';
      lines.push(
        `  #${r?.position}: stored="${stored}" phone=${phone} → resolved="${resolved}"${changed}`,
      );
    }
    lines.push('');
    lines.push('--- Contact phone-match (device index) ---');
    const cs = Array.isArray(contacts) ? contacts : [];
    lines.push(`total contacts: ${cs.length}`);
    let matched = 0;
    const shown = cs.slice(0, 40);
    for (const c of shown) {
      const phone = c?.phoneE164 || c?.phone || '';
      const smil = c?.name || c?.displayName || '';
      const nm = getResolvedDisplayName(c, deviceIndex, lookupDeviceContactName, smil || 'Contact');
      const isDev = !!phone && nm !== smil && nm !== 'Contact';
      if (isDev) matched++;
      lines.push(`  ${phone || '(no phone)'} → "${nm}"${isDev ? ' [device✓]' : ''}`);
    }
    lines.push(`device-matched: ${matched}/${shown.length} shown`);
    lines.push('');
    lines.push('--- Group detection ---');
    const convs = Array.isArray(conversationsList) ? conversationsList : [];
    const groups = convs.filter((c: any) => c && (c.isGroup === true || c.type === 'group' || (Array.isArray(c.participants) && c.participants.length > 2)));
    const lg = Array.isArray(listGroupsData) ? listGroupsData : [];
    lines.push(`listConversations: ${convs.length} · shape-detected groups: ${groups.length}`);
    lines.push(`listGroups (authoritative): ${lg.length}`);
    for (const g of lg.slice(0, 20)) {
      lines.push(`  "${g?.name || '(no name)'}" id=${String(g?._id || '').slice(-6)}`);
    }
    lines.push('==================================');
    return lines.join('\n');
  }, [contacts, conversationsList, deviceIndex, localVoiceTasks, voiceTasksConvex]);

  const handleCopySnapshot = useCallback(async () => {
    try {
      const text = buildSnapshot();
      await Clipboard.setStringAsync(text);
      Alert.alert('Snapshot copied', 'State snapshot copied to clipboard — paste it back here.');
    } catch (errorValue: any) {
      Alert.alert('Copy failed', errorValue?.message || 'Could not copy snapshot.');
    }
  }, [buildSnapshot]);

  const handleShareSnapshot = useCallback(async () => {
    try {
      await Share.share({ message: buildSnapshot(), title: 'Smilers State Snapshot' });
    } catch {}
  }, [buildSnapshot]);

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
      const backendUrl = (process.env.EXPO_PUBLIC_BACKEND_URL || '(missing)');
      const webAppUrl = (process.env.EXPO_PUBLIC_WEB_APP_URL || '(missing)');
      const header = `Smilers Diagnostic Log\nSession: ${sessionId || '-'}\nPlatform: ${Platform.OS} ${Platform.Version}\nBackend URL: ${backendUrl}\nWeb app URL: ${webAppUrl}\nTotal events: ${events.length}\n----------------------------------------\n`;
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
      const backendUrl = (process.env.EXPO_PUBLIC_BACKEND_URL || '(missing)');
      const webAppUrl = (process.env.EXPO_PUBLIC_WEB_APP_URL || '(missing)');
      const header = `Smilers Diagnostic Log\nSession: ${sessionId || '-'}\nPlatform: ${Platform.OS} ${Platform.Version}\nBackend URL: ${backendUrl}\nWeb app URL: ${webAppUrl}\nTotal events: ${events.length}\n----------------------------------------\n`;
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

  /**
   * iter-212: Run an END-TO-END push-pipeline self-test.
   *
   * 1. Calls POST /api/self-test-push with the current OIDC sub.
   * 2. Backend resolves the device token(s) we registered earlier via
   *    `useEmergentPush`, sends a real FCM v1 message AND tries the
   *    Emergent relay as a backup.
   * 3. We record the response (token count, success count, errors) as
   *    a diagnostic event so the result is visible in the log even if
   *    the actual notification is suppressed by the OS / channel
   *    settings.
   * 4. If FCM reports success, the user should see the heads-up banner
   *    arrive within a few seconds.
   *
   * This is the single most valuable verifier we ship: it isolates
   * registration / delivery / display problems from each other.
   */
  const handlePushTest = useCallback(async () => {
    const targetUserId = userInfo?.sub;
    if (!targetUserId) {
      Alert.alert(
        'Sign in required',
        'You need to be signed in to run a push self-test (we use your OIDC subject to look up the registered device token).',
      );
      return;
    }
    if (runningPushTest) return;
    setRunningPushTest(true);
    recordDiagnostic({
      tag: 'PUSH-TEST',
      source: 'diagnostic-logs',
      message: `start: requesting self-test push for user ${targetUserId.slice(0, 10)}…`,
    });
    void refresh();
    try {
      const result = await triggerEmergentSelfTestPush(targetUserId);
      const fcm = result?.fcm;
      const emergent = (result as any)?.emergent;
      const lines: string[] = [];
      if (fcm && fcm.attempted) {
        lines.push(
          `FCM v1: delivered=${fcm.success_count}/${fcm.token_count}`,
        );
        if (fcm.errors && fcm.errors.length > 0) {
          lines.push(`errors=${fcm.errors.slice(0, 2).join(' | ')}`);
        }
      } else {
        lines.push('FCM v1: NOT attempted (no device tokens registered)');
      }
      if (emergent) {
        lines.push(
          `Emergent relay: status=${emergent.status || '?'}${
            emergent.body ? ` body=${String(emergent.body).slice(0, 80)}` : ''
          }`,
        );
      }
      const summary = lines.join(' · ') || JSON.stringify(result).slice(0, 200);
      recordDiagnostic({
        tag: 'PUSH-TEST',
        source: 'diagnostic-logs',
        message: `result: ${summary}`,
      });
      Alert.alert(
        'Self-test push sent',
        `${summary}\n\nIf FCM reports >0 delivered, you should see a banner in ~3s. If you don't, the notification channel may be silenced — check Android Settings → Apps → Smilers → Notifications.`,
      );
    } catch (errorValue: any) {
      const msg = errorValue?.message || String(errorValue);
      recordDiagnostic({
        tag: 'PUSH-TEST',
        source: 'diagnostic-logs',
        message: `fail: ${msg}`,
      });
      Alert.alert(
        'Self-test push failed',
        `${msg}\n\nIf HTTP 401/403 → EMERGENT_PUSH_KEY not set in deployment.\nIf HTTP 404 → backend not reachable (check EXPO_PUBLIC_BACKEND_URL).`,
      );
    } finally {
      setRunningPushTest(false);
      void refresh();
    }
  }, [refresh, runningPushTest, userInfo?.sub]);

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
        {/* iter-222: surface baked-in backend URL so a wrong-URL APK is
            obvious at a glance — no more guessing why register-push 404s. */}
        <Text style={[styles.subtitle, { fontSize: 10, marginTop: 2 }]} numberOfLines={1} testID="diag-backend-url">
          API: {(process.env.EXPO_PUBLIC_BACKEND_URL || '(missing)').replace(/^https?:\/\//, '')}
        </Text>
        {/* iter-D1: surface the latest HEALTH probe result so you can
            instantly tell whether THIS device can reach OUR backend
            and whether critical routes exist right now. */}
        {(() => {
          const latestBoot = [...events].reverse().find(
            (ev) => ev.tag === 'BOOT' && ev.source === 'api',
          );
          const latestHealth = [...events].reverse().find(
            (ev) => ev.tag === 'HEALTH',
          );
          if (!latestBoot && !latestHealth) return null;
          return (
            <View style={{ marginTop: 6, gap: 2 }}>
              {latestBoot ? (
                <Text style={[styles.subtitle, { fontSize: 10, color: '#9c88ff' }]} numberOfLines={2}>
                  BOOT @ {fmtTs(latestBoot.ts)} → {latestBoot.message}
                </Text>
              ) : null}
              {latestHealth ? (
                <Text style={[styles.subtitle, { fontSize: 10, color: '#4dd0e1' }]} numberOfLines={2}>
                  HEALTH @ {fmtTs(latestHealth.ts)} → {latestHealth.message}
                </Text>
              ) : null}
            </View>
          );
        })()}
      </View>

      <View style={styles.snapshotCard}>
        <View style={styles.snapshotHeaderRow}>
          <Feather name="clipboard" size={14} color="#4dd0e1" />
          <Text style={styles.snapshotTitle}>State Snapshot</Text>
        </View>
        <Text style={styles.snapshotLine}>
          Contacts index: {deviceIndex?.isReady ? `ready · ${deviceIndex.byE164?.size ?? 0} names` : 'not ready'}
          {deviceIndex?.defaultCountry ? ` · ${deviceIndex.defaultCountry}` : ''}
        </Text>
        <Text style={styles.snapshotLine}>
          Smilers contacts: {Array.isArray(contacts) ? contacts.length : '…'} · Voice tasks: {Array.isArray(voiceTasksConvex) ? voiceTasksConvex.length : '…'}
        </Text>
        <Text style={styles.snapshotLine}>
          Groups detected: {Array.isArray(conversationsList) ? conversationsList.filter((c: any) => c && (c.isGroup === true || c.type === 'group' || (Array.isArray(c.participants) && c.participants.length > 2))).length : '…'} / {Array.isArray(conversationsList) ? conversationsList.length : '…'} convos
        </Text>
        <Text style={styles.snapshotLine}>
          Keyboard KAV: {Platform.OS === 'ios' ? 'padding' : 'height'} · edge-to-edge: {String((Constants?.expoConfig?.android as any)?.edgeToEdgeEnabled)}
        </Text>
        <View style={styles.snapshotBtnRow}>
          <TouchableOpacity style={styles.snapshotBtn} onPress={handleCopySnapshot} testID="diag-copy-snapshot">
            <Feather name="copy" size={14} color="#4dd0e1" />
            <Text style={styles.snapshotBtnText}>Copy snapshot</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.snapshotBtn} onPress={handleShareSnapshot} testID="diag-share-snapshot">
            <Feather name="share-2" size={14} color="#4dd0e1" />
            <Text style={styles.snapshotBtnText}>Share</Text>
          </TouchableOpacity>
        </View>
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
        <TouchableOpacity
          style={styles.toolBtn}
          onPress={async () => {
            await probeBackendHealth();
            await refresh();
            Alert.alert(
              'Backend probe',
              'Re-checked /api/__health. See the HEALTH line at the top — it shows whether this device reached our backend and which routes were present.',
            );
          }}
        >
          <Feather name="activity" size={16} color="#4dd0e1" />
          <Text style={[styles.toolText, { color: '#4dd0e1' }]}>Re-probe</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.toolBtn}
          onPress={async () => {
            // Phase A.3 — manual Twilio Video call test launcher.
            // Creates a real Twilio room via the backend, then routes
            // to the new /twilio-call screen with caller params.
            try {
              const meId = `tester_${Date.now().toString(36)}`;
              const { initiateTwilioCall } = await import('../src/lib/twilio/twilioApi');
              const res = await initiateTwilioCall({
                callerIdentity: meId,
                calleeIdentities: [`peer_${meId}`],
                isVideo: true,
                conversationId: null,
                roomName: null,
              });
              router.push({
                pathname: '/twilio-call',
                params: {
                  room: res.roomName,
                  identity: meId,
                  isVideo: '1',
                  isCaller: '1',
                  token: res.token,
                  title: 'Twilio Test Call',
                },
              });
            } catch (err: any) {
              Alert.alert('Twilio test failed', err?.message || String(err));
            }
          }}
        >
          <Feather name="video" size={16} color="#ffb74d" />
          <Text style={[styles.toolText, { color: '#ffb74d' }]}>Twilio Test</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.toolBtn}
          onPress={handlePushTest}
          disabled={runningPushTest}
        >
          <Feather
            name="send"
            size={16}
            color={runningPushTest ? '#888' : '#4caf50'}
          />
          <Text
            style={[
              styles.toolText,
              { color: runningPushTest ? '#888' : '#4caf50' },
            ]}
          >
            {runningPushTest ? 'Sending…' : 'Test Push'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.toolBtn}
          onPress={async () => {
            recordDiagnostic({
              tag: 'CONVEX-RECONNECT',
              source: 'diagnostic-logs',
              message: 'manual force reconnect requested',
            });
            const ok = await forceConvexReconnect('diagnostic-logs-button');
            recordDiagnostic({
              tag: 'CONVEX-RECONNECT',
              source: 'diagnostic-logs',
              message: `result: ${ok ? 'reconnect attempted' : 'no active client'}`,
            });
            void refresh();
            Alert.alert(
              'Convex socket reconnect',
              ok
                ? 'Socket restart triggered. Stuck chats / messages should resolve in ~3-5s.'
                : 'No active Convex client found. Try signing in first.',
            );
          }}
        >
          <Feather name="refresh-cw" size={16} color="#ff9800" />
          <Text style={[styles.toolText, { color: '#ff9800' }]}>Reconnect</Text>
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
  snapshotCard: {
    marginHorizontal: Spacing.md,
    marginTop: Spacing.xs,
    marginBottom: Spacing.xs,
    padding: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(77,208,225,0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(77,208,225,0.3)',
  },
  snapshotHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  snapshotTitle: {
    color: '#4dd0e1',
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  snapshotLine: {
    color: Colors.white,
    fontSize: 12,
    lineHeight: 18,
  },
  snapshotBtnRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  snapshotBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(77,208,225,0.14)',
  },
  snapshotBtnText: {
    color: '#4dd0e1',
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
  },
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
