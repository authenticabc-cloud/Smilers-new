import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation, useConvex } from 'convex/react';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import {
  APP_LOCK_PIN_KEY,
  readStoredJson,
  readStoredString,
  writeStoredJson,
} from '../src/lib/settingsStorage';
import {
  buildChatBackupPayload,
  chatBackupToReadableText,
  decryptChatBackup,
  getLatestChatBackupUri,
  stampAutoBackupNow,
  writeEncryptedChatBackup,
} from '../src/lib/backup/chatBackup';
import { safeMutation } from '../src/lib/safeMutation';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

const BACKUP_SETTINGS_KEY = 'smilers_backup_settings';

type Frequency = 'off' | 'daily' | 'weekly' | 'monthly';
type Network = 'wifi' | 'any';

interface BackupSettings {
  autoBackup: boolean;
  frequency: Frequency;
  includeMedia: boolean;
  includeVoice: boolean;
  includeDocs: boolean;
  network: Network;
  lastBackupAt?: number;
}

const DEFAULT_SETTINGS: BackupSettings = {
  autoBackup: true,
  frequency: 'weekly',
  includeMedia: true,
  includeVoice: true,
  includeDocs: false,
  network: 'wifi',
};

const FREQUENCY_LABEL: Record<Frequency, string> = {
  off: 'Off',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

interface StorageInfo {
  loading: boolean;
  cacheBytes: number;
  documentBytes: number;
  freeDeviceBytes?: number;
  totalDeviceBytes?: number;
  error?: string;
}

const INITIAL_STORAGE: StorageInfo = {
  loading: true,
  cacheBytes: 0,
  documentBytes: 0,
};

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null || isNaN(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function formatRelativeTime(ts?: number): string {
  if (!ts) return 'Never';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(ts).toLocaleDateString();
}

async function computeStorage(): Promise<Partial<StorageInfo>> {
  // expo-file-system legacy API works across iOS/Android. On web it fails
  // silently — we just show '—'.
  if (Platform.OS === 'web') {
    return { cacheBytes: 0, documentBytes: 0 };
  }
  try {
    const FS = await import('expo-file-system/legacy');
    const [cacheInfo, docInfo, freeBytes] = await Promise.all([
      FS.cacheDirectory ? FS.getInfoAsync(FS.cacheDirectory, { size: true }) : Promise.resolve(null),
      FS.documentDirectory ? FS.getInfoAsync(FS.documentDirectory, { size: true }) : Promise.resolve(null),
      typeof FS.getFreeDiskStorageAsync === 'function' ? FS.getFreeDiskStorageAsync() : Promise.resolve(undefined),
    ]);
    let totalBytes: number | undefined;
    try {
      if (typeof (FS as any).getTotalDiskCapacityAsync === 'function') {
        totalBytes = await (FS as any).getTotalDiskCapacityAsync();
      }
    } catch {}
    return {
      cacheBytes: (cacheInfo as any)?.size || 0,
      documentBytes: (docInfo as any)?.size || 0,
      freeDeviceBytes: freeBytes as number | undefined,
      totalDeviceBytes: totalBytes,
    };
  } catch (e: any) {
    return { cacheBytes: 0, documentBytes: 0, error: e?.message };
  }
}

async function clearCache(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const FS = await import('expo-file-system/legacy');
    const cacheDir = FS.cacheDirectory;
    if (!cacheDir) return false;
    const items = await FS.readDirectoryAsync(cacheDir);
    await Promise.all(
      items.map((name) =>
        FS.deleteAsync(`${cacheDir}${name}`, { idempotent: true }).catch(() => undefined),
      ),
    );
    return true;
  } catch (e) {
    console.warn('clearCache failed:', e);
    return false;
  }
}

export default function BackupScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const convex = useConvex();
  const { data: me, refetch } = useSafeConvexQuery<any | null>(
    api.users.getCurrentUser,
    {},
    null,
    isAuthenticated,
  );
  const updateProfile = useMutation(api.users.updateProfile);

  const [settings, setSettings] = useState<BackupSettings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupProgress, setBackupProgress] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [lastLocalTs, setLastLocalTs] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [storage, setStorage] = useState<StorageInfo>(INITIAL_STORAGE);

  // Hydrate settings: server-first, then local fallback.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let initial: BackupSettings | null = null;
      if (me?.backupSettings && typeof me.backupSettings === 'object') {
        initial = { ...DEFAULT_SETTINGS, ...me.backupSettings };
      } else {
        const local = (await readStoredJson(BACKUP_SETTINGS_KEY, null)) as BackupSettings | null;
        if (local && typeof local === 'object') {
          initial = { ...DEFAULT_SETTINGS, ...local };
        }
      }
      if (!cancelled) {
        setSettings(initial || DEFAULT_SETTINGS);
        setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me]);

  // Compute storage usage on mount.
  const reloadStorage = useCallback(async () => {
    setStorage((s) => ({ ...s, loading: true }));
    const result = await computeStorage();
    setStorage({ loading: false, cacheBytes: 0, documentBytes: 0, ...result });
  }, []);

  useEffect(() => {
    void reloadStorage();
  }, [reloadStorage]);

  const persist = useCallback(
    async (next: BackupSettings, silent = false) => {
      setSettings(next);
      if (!silent) setSaving(true);
      try {
        await writeStoredJson(BACKUP_SETTINGS_KEY, next);
      } catch {}
      try {
        const payload = { backupSettings: next };
        await safeMutation(
          'users.updateProfile(backupSettings)',
          () => updateProfile(payload),
          payload,
        );
        if (!silent) {
          try {
            await refetch();
          } catch {}
        }
      } catch (errorValue: any) {
        // Backend may not have backupSettings yet — fine, we kept it locally.
        console.warn('updateProfile(backupSettings) failed:', errorValue?.message);
      }
      if (!silent) setSaving(false);
    },
    [refetch, updateProfile],
  );

  const setAutoBackup = (v: boolean) => {
    const next = { ...settings, autoBackup: v };
    if (!v) next.frequency = 'off';
    else if (settings.frequency === 'off') next.frequency = 'weekly';
    void persist(next);
  };

  const setFrequency = (f: Frequency) => {
    void persist({ ...settings, frequency: f, autoBackup: f !== 'off' });
  };

  const setNetwork = (n: Network) => {
    void persist({ ...settings, network: n });
  };

  const toggleField = (key: 'includeMedia' | 'includeVoice' | 'includeDocs') => (v: boolean) => {
    void persist({ ...settings, [key]: v });
  };

  // Reflect the newest ACTUAL local backup file (auto-backups run outside this
  // screen and only stamp AsyncStorage), so "Last backup" is always truthful.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const uri = await getLatestChatBackupUri();
        if (cancelled || !uri) return;
        const m = uri.match(/(\d{10,})/);
        if (m) setLastLocalTs(Number(m[1]));
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onBackupNow = useCallback(() => {
    if (backingUp) return;
    Alert.alert(
      'Back up now?',
      'This creates an encrypted backup of ALL your chats and call logs on this device. It is locked with your App Lock PIN and never leaves the device unless you share it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Back up',
          onPress: async () => {
            const pin = (await readStoredString(APP_LOCK_PIN_KEY)) || '';
            if (!pin) {
              Alert.alert(
                'Set an App Lock PIN first',
                'Backups are encrypted with your App Lock PIN. Set one in Settings → App Lock, then back up.',
              );
              return;
            }
            setBackingUp(true);
            setBackupProgress('Starting…');
            try {
              const payload = await buildChatBackupPayload(
                convex,
                {
                  includeMedia: settings.includeMedia,
                  includeVoice: settings.includeVoice,
                  includeDocs: settings.includeDocs,
                },
                (p) => setBackupProgress(p.label || ''),
              );
              const uri = await writeEncryptedChatBackup(payload, pin, false, (p) =>
                setBackupProgress(p.label || ''),
              );
              const now = Date.now();
              await stampAutoBackupNow(me?._id);
              setLastLocalTs(now);
              await persist({ ...settings, lastBackupAt: now }, true);
              setBackupProgress('');
              try {
                const Sharing = await import('expo-sharing');
                if (await Sharing.isAvailableAsync()) {
                  Alert.alert(
                    'Backup complete',
                    `Backed up ${payload.messageCount} messages and ${payload.callLogCount} call logs across ${payload.conversationCount} chats. Save a copy off this device?`,
                    [
                      { text: 'Not now', style: 'cancel' },
                      {
                        text: 'Share backup',
                        onPress: () =>
                          void Sharing.shareAsync(uri, {
                            mimeType: 'application/json',
                            dialogTitle: 'Save Smilers backup',
                          }),
                      },
                    ],
                  );
                } else {
                  Alert.alert(
                    'Backup complete',
                    `Backed up ${payload.messageCount} messages across ${payload.conversationCount} chats.`,
                  );
                }
              } catch {
                Alert.alert('Backup complete', `Backed up ${payload.messageCount} messages.`);
              }
            } catch (errorValue: any) {
              setBackupProgress('');
              Alert.alert('Backup failed', String(errorValue?.message || errorValue));
            } finally {
              setBackingUp(false);
            }
          },
        },
      ],
    );
  }, [backingUp, persist, settings, convex, me?._id]);

  // Decrypt a backup and offer a readable archive. Note: chats live on the
  // external Convex backend and can't be re-injected there, so "restore"
  // recovers a portable READABLE copy of your history (openable on any device
  // with the same PIN) rather than re-populating the live chat threads.
  const onRestore = useCallback(async () => {
    if (restoring) return;
    const pin = (await readStoredString(APP_LOCK_PIN_KEY)) || '';
    if (!pin) {
      Alert.alert(
        'Set your App Lock PIN first',
        'Backups are locked with your App Lock PIN. Set the same PIN you used when backing up (Settings → App Lock), then restore.',
      );
      return;
    }
    const doRestore = async (uri: string) => {
      setRestoring(true);
      try {
        const payload = await decryptChatBackup(uri, pin);
        const text = chatBackupToReadableText(payload);
        const path = `${LegacyFileSystem.cacheDirectory}smilers-chat-archive-${Date.now()}.txt`;
        await LegacyFileSystem.writeAsStringAsync(path, text);
        const Sharing = await import('expo-sharing');
        Alert.alert(
          'Backup opened',
          `This backup has ${payload.messageCount} messages and ${payload.callLogCount} call logs across ${payload.conversationCount} chats. Save a readable copy?`,
          [
            { text: 'Done', style: 'cancel' },
            {
              text: 'Save readable copy',
              onPress: async () => {
                try {
                  if (await Sharing.isAvailableAsync()) {
                    await Sharing.shareAsync(path, {
                      mimeType: 'text/plain',
                      dialogTitle: 'Smilers chat archive',
                    });
                  }
                } catch {}
              },
            },
          ],
        );
      } catch (errorValue: any) {
        Alert.alert('Restore failed', String(errorValue?.message || errorValue));
      } finally {
        setRestoring(false);
      }
    };
    const pickFile = async () => {
      try {
        const DocumentPicker = await import('expo-document-picker');
        const picked = await DocumentPicker.getDocumentAsync({
          type: ['application/json', 'public.json', '*/*'],
          copyToCacheDirectory: true,
          multiple: false,
        });
        if (picked?.canceled) return;
        const uri = picked?.assets?.[0]?.uri || (picked as any)?.uri;
        if (uri) await doRestore(uri);
      } catch (errorValue: any) {
        Alert.alert('Could not open file picker', String(errorValue?.message || errorValue));
      }
    };
    const latest = await getLatestChatBackupUri();
    if (latest) {
      Alert.alert('Restore backup', 'Open your latest local backup, or choose a file?', [
        { text: 'Latest backup', onPress: () => void doRestore(latest) },
        { text: 'Choose a file…', onPress: () => void pickFile() },
        { text: 'Cancel', style: 'cancel' },
      ]);
    } else {
      await pickFile();
    }
  }, [restoring]);

  const onClearCache = useCallback(() => {
    if (clearing) return;
    Alert.alert(
      'Clear cache?',
      'Cached files (thumbnails, previews) will be removed. Your messages and saved media will not be affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            setClearing(true);
            const ok = await clearCache();
            await reloadStorage();
            setClearing(false);
            if (ok) {
              Alert.alert('Cache cleared', 'Cached files have been removed.');
            } else {
              Alert.alert('Could not clear cache', 'Try again later.');
            }
          },
        },
      ],
    );
  }, [clearing, reloadStorage]);

  const totalAppBytes = storage.cacheBytes + storage.documentBytes;
  const usedPct = useMemo(() => {
    if (!storage.totalDeviceBytes) return null;
    return Math.min(
      100,
      Math.max(
        0,
        Math.round(((storage.totalDeviceBytes - (storage.freeDeviceBytes || 0)) / storage.totalDeviceBytes) * 100),
      ),
    );
  }, [storage.freeDeviceBytes, storage.totalDeviceBytes]);

  const frequencies: Frequency[] = ['daily', 'weekly', 'monthly'];

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="backup-screen">
      <Header
        title="Backup & Storage"
        showBack
        onBack={() => router.back()}
        variant="dark"
        right={saving ? <ActivityIndicator size="small" color={Colors.white} /> : null}
      />

      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        {/* ── BACKUP STATUS CARD ───────────────────────── */}
        <View style={styles.statusCard}>
          <View style={styles.statusIconWrap}>
            <Ionicons name="cloud-upload-outline" size={28} color={Colors.primary} />
          </View>
          <Text style={styles.statusTitle}>
            {settings.autoBackup && settings.frequency !== 'off'
              ? `Auto backup · ${FREQUENCY_LABEL[settings.frequency]}`
              : 'Auto backup is off'}
          </Text>
          <Text style={styles.statusSub}>
            Last backup: {formatRelativeTime(Math.max(settings.lastBackupAt || 0, lastLocalTs) || undefined)}
          </Text>
          <TouchableOpacity
            style={[styles.backupNowBtn, backingUp ? { opacity: 0.7 } : null]}
            onPress={onBackupNow}
            disabled={backingUp || !hydrated}
            testID="backup-now"
          >
            {backingUp ? (
              <ActivityIndicator size="small" color={Colors.headerBg} />
            ) : (
              <>
                <Ionicons name="cloud-upload" size={18} color={Colors.headerBg} />
                <Text style={styles.backupNowText}>Back up now</Text>
              </>
            )}
          </TouchableOpacity>
          {backingUp && backupProgress ? (
            <Text style={styles.progressText} testID="backup-progress">
              {backupProgress}
            </Text>
          ) : null}
          <TouchableOpacity
            style={styles.restoreBtn}
            onPress={onRestore}
            disabled={restoring || backingUp}
            testID="backup-restore"
          >
            {restoring ? (
              <ActivityIndicator size="small" color={Colors.primary} />
            ) : (
              <>
                <Ionicons name="cloud-download-outline" size={18} color={Colors.primary} />
                <Text style={styles.restoreBtnText}>Restore from backup</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* ── AUTO BACKUP ──────────────────────────────── */}
        <Text style={styles.sectionLabel}>Auto backup</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Ionicons name="sync-outline" size={22} color={Colors.primary} />
            <View style={styles.rowMid}>
              <Text style={styles.rowTitle}>Auto backup</Text>
              <Text style={styles.rowSub}>Automatically back up on a schedule</Text>
            </View>
            <Switch
              value={settings.autoBackup}
              onValueChange={setAutoBackup}
              trackColor={{ true: Colors.primary, false: Colors.border }}
              thumbColor={Colors.white}
              testID="backup-auto-toggle"
            />
          </View>

          {settings.autoBackup ? (
            <>
              <View style={styles.divider} />
              <View style={styles.rowVertical}>
                <Text style={styles.rowTitle}>Frequency</Text>
                <View style={styles.segment}>
                  {frequencies.map((f) => (
                    <TouchableOpacity
                      key={f}
                      style={[styles.segmentBtn, settings.frequency === f ? styles.segmentBtnActive : null]}
                      onPress={() => setFrequency(f)}
                      testID={`backup-freq-${f}`}
                    >
                      <Text
                        style={[
                          styles.segmentText,
                          settings.frequency === f ? styles.segmentTextActive : null,
                        ]}
                      >
                        {FREQUENCY_LABEL[f]}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <View style={styles.divider} />
              <View style={styles.rowVertical}>
                <Text style={styles.rowTitle}>Network</Text>
                <View style={styles.segment}>
                  <TouchableOpacity
                    style={[styles.segmentBtn, settings.network === 'wifi' ? styles.segmentBtnActive : null]}
                    onPress={() => setNetwork('wifi')}
                    testID="backup-net-wifi"
                  >
                    <Text style={[styles.segmentText, settings.network === 'wifi' ? styles.segmentTextActive : null]}>
                      Wi-Fi only
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.segmentBtn, settings.network === 'any' ? styles.segmentBtnActive : null]}
                    onPress={() => setNetwork('any')}
                    testID="backup-net-any"
                  >
                    <Text style={[styles.segmentText, settings.network === 'any' ? styles.segmentTextActive : null]}>
                      Wi-Fi + Cellular
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </>
          ) : null}
        </View>

        {/* ── WHAT TO INCLUDE ──────────────────────────── */}
        <Text style={styles.sectionLabel}>What to include</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Ionicons name="image-outline" size={22} color={Colors.primary} />
            <View style={styles.rowMid}>
              <Text style={styles.rowTitle}>Photos & videos</Text>
              <Text style={styles.rowSub}>Include media shared in chats</Text>
            </View>
            <Switch
              value={settings.includeMedia}
              onValueChange={toggleField('includeMedia')}
              trackColor={{ true: Colors.primary, false: Colors.border }}
              thumbColor={Colors.white}
              testID="backup-include-media"
            />
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Ionicons name="mic-outline" size={22} color={Colors.primary} />
            <View style={styles.rowMid}>
              <Text style={styles.rowTitle}>Voice notes</Text>
              <Text style={styles.rowSub}>Include voice messages</Text>
            </View>
            <Switch
              value={settings.includeVoice}
              onValueChange={toggleField('includeVoice')}
              trackColor={{ true: Colors.primary, false: Colors.border }}
              thumbColor={Colors.white}
              testID="backup-include-voice"
            />
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Ionicons name="document-outline" size={22} color={Colors.primary} />
            <View style={styles.rowMid}>
              <Text style={styles.rowTitle}>Documents</Text>
              <Text style={styles.rowSub}>Include shared files</Text>
            </View>
            <Switch
              value={settings.includeDocs}
              onValueChange={toggleField('includeDocs')}
              trackColor={{ true: Colors.primary, false: Colors.border }}
              thumbColor={Colors.white}
              testID="backup-include-docs"
            />
          </View>
        </View>

        {/* ── STORAGE USAGE ────────────────────────────── */}
        <Text style={styles.sectionLabel}>Storage on this device</Text>
        <View style={styles.card}>
          {storage.loading ? (
            <View style={styles.storageLoading}>
              <ActivityIndicator size="small" color={Colors.primary} />
              <Text style={styles.rowSub}>Calculating storage…</Text>
            </View>
          ) : (
            <>
              <View style={styles.usageHeader}>
                <View>
                  <Text style={styles.usageBig}>{formatBytes(totalAppBytes)}</Text>
                  <Text style={styles.usageSmall}>used by Smilers on this device</Text>
                </View>
                <TouchableOpacity onPress={reloadStorage} hitSlop={10} testID="backup-refresh-storage">
                  <Ionicons name="refresh" size={20} color={Colors.textSecondary} />
                </TouchableOpacity>
              </View>

              {storage.totalDeviceBytes ? (
                <View style={styles.deviceBar}>
                  <View style={styles.deviceBarTrack}>
                    <View
                      style={[
                        styles.deviceBarFill,
                        { width: `${usedPct ?? 0}%` },
                      ]}
                    />
                  </View>
                  <View style={styles.deviceBarLabels}>
                    <Text style={styles.rowSub}>
                      {formatBytes(storage.freeDeviceBytes)} free of {formatBytes(storage.totalDeviceBytes)}
                    </Text>
                  </View>
                </View>
              ) : null}

              <View style={styles.divider} />

              <View style={styles.row}>
                <Ionicons name="folder-outline" size={22} color={Colors.primary} />
                <View style={styles.rowMid}>
                  <Text style={styles.rowTitle}>Saved data</Text>
                  <Text style={styles.rowSub}>Messages, contacts, settings</Text>
                </View>
                <Text style={styles.rowValue}>{formatBytes(storage.documentBytes)}</Text>
              </View>

              <View style={styles.divider} />

              <View style={styles.row}>
                <Ionicons name="time-outline" size={22} color={Colors.primary} />
                <View style={styles.rowMid}>
                  <Text style={styles.rowTitle}>Cache</Text>
                  <Text style={styles.rowSub}>Thumbnails and previews</Text>
                </View>
                <Text style={styles.rowValue}>{formatBytes(storage.cacheBytes)}</Text>
              </View>

              <TouchableOpacity
                style={[styles.clearBtn, (clearing || storage.cacheBytes === 0) ? { opacity: 0.55 } : null]}
                onPress={onClearCache}
                disabled={clearing || storage.cacheBytes === 0}
                testID="backup-clear-cache"
              >
                {clearing ? (
                  <ActivityIndicator size="small" color={Colors.danger} />
                ) : (
                  <>
                    <Ionicons name="trash-outline" size={18} color={Colors.danger} />
                    <Text style={styles.clearBtnText}>Clear cache</Text>
                  </>
                )}
              </TouchableOpacity>
            </>
          )}
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="lock-closed-outline" size={18} color={Colors.textSecondary} />
          <Text style={styles.tipText}>
            Backups are encrypted with your App Lock PIN (AES-GCM-256) and stored on this device. Share a backup file to keep an off-device copy — restore it on any device with the same PIN. Restore recovers a readable copy of your history.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  statusCard: {
    margin: Spacing.base,
    padding: Spacing.lg,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  statusIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  statusTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginBottom: 2,
  },
  statusSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
  },
  backupNowBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    borderRadius: Radius.pill,
    minHeight: 44,
  },
  backupNowText: {
    color: Colors.headerBg,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.base,
  },
  progressText: {
    marginTop: Spacing.sm,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: FontWeight.medium,
  },
  restoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.primary,
    minHeight: 44,
  },
  restoreBtnText: {
    color: Colors.primary,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.base,
  },

  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  card: {
    marginHorizontal: Spacing.base,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    overflow: 'hidden',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    gap: Spacing.md,
  },
  rowVertical: {
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    gap: 10,
  },
  rowMid: { flex: 1 },
  rowTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  rowSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  rowValue: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.borderLight,
    marginLeft: Spacing.base,
  },

  segment: {
    flexDirection: 'row',
    backgroundColor: Colors.background,
    borderRadius: Radius.md,
    padding: 4,
    gap: 4,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentBtnActive: {
    backgroundColor: Colors.primary,
  },
  segmentText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
  },
  segmentTextActive: {
    color: Colors.headerBg,
  },

  storageLoading: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.xl,
    gap: 8,
  },
  usageHeader: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  usageBig: {
    fontSize: FontSize.xxl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  usageSmall: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  deviceBar: {
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.md,
  },
  deviceBarTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.borderLight,
    overflow: 'hidden',
  },
  deviceBarFill: {
    height: '100%',
    backgroundColor: Colors.primary,
  },
  deviceBarLabels: {
    marginTop: 6,
  },

  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginHorizontal: Spacing.base,
    marginVertical: Spacing.md,
    paddingVertical: 12,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#FECACA',
    backgroundColor: '#FEF2F2',
  },
  clearBtnText: {
    color: Colors.danger,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.base,
  },

  tipCard: {
    flexDirection: 'row',
    gap: Spacing.sm,
    margin: Spacing.base,
    padding: Spacing.md,
    backgroundColor: '#FFFBEB',
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  tipText: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
});
