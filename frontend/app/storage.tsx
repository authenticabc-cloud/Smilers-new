/**
 * Storage — shows how much space the decrypted-media cache is using on this
 * device and lets the user clear it in one tap. The cache holds decrypted
 * copies of E2EE photos/videos/documents (so re-opening is instant) plus any
 * in-flight encrypted downloads. Clearing is safe: media re-downloads and
 * re-decrypts on next open. Nothing here touches the server or the originals.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Header from '../src/components/Header';
import { Colors } from '../src/theme';
import {
  clearDecryptedCache,
  getDecryptedCacheSize,
} from '../src/hooks/useDecryptedMediaUrl';

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return '< 0.1 MB';
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export default function StorageScreen() {
  const router = useRouter();
  const [size, setSize] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    try {
      const bytes = await getDecryptedCacheSize();
      setSize(bytes);
    } catch {
      setSize(0);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const doClear = useCallback(async () => {
    setClearing(true);
    try {
      const freed = await clearDecryptedCache();
      setSize(0);
      Alert.alert(
        'Cache cleared',
        freed > 0
          ? `Freed ${formatBytes(freed)}. Media will re-download when you open it again.`
          : 'The cache was already empty.'
      );
    } catch {
      Alert.alert('Could not clear cache', 'Please try again.');
    } finally {
      setClearing(false);
    }
  }, []);

  const confirmClear = useCallback(() => {
    if (clearing) return;
    Alert.alert(
      'Clear cached media?',
      'This removes downloaded photos, videos and documents from this device. They stay safe on the server and re-download when you open them. Your chats and messages are not affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear cache', style: 'destructive', onPress: () => void doClear() },
      ]
    );
  }, [clearing, doClear]);

  const isEmpty = (size ?? 0) <= 0;

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="storage-screen">
      <Header title="Storage" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />
        }
      >
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons name="cloud-outline" size={26} color={Colors.primary} />
          </View>
          <Text style={styles.cardLabel}>Cached media</Text>
          {size === null ? (
            <ActivityIndicator color={Colors.primary} style={{ marginTop: 8 }} testID="storage-loading" />
          ) : (
            <Text style={styles.cardValue} testID="storage-size">
              {formatBytes(size)}
            </Text>
          )}
          <Text style={styles.cardHint}>
            Decrypted photos, videos and documents are kept here so re-opening
            them is instant. Cleared automatically once it passes 200 MB.
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.clearBtn, (isEmpty || clearing) && styles.clearBtnDisabled]}
          activeOpacity={0.85}
          onPress={confirmClear}
          disabled={isEmpty || clearing}
          testID="storage-clear-btn"
        >
          {clearing ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="trash-outline" size={19} color="#fff" />
              <Text style={styles.clearBtnText}>Clear cache</Text>
            </>
          )}
        </TouchableOpacity>

        <Text style={styles.footNote}>
          Clearing the cache never deletes your messages or any media from the
          server — it only frees space on this device.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 16, paddingBottom: 40 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 18,
    padding: 22,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  cardLabel: { color: Colors.textSecondary, fontSize: 14, fontWeight: '600' },
  cardValue: { color: Colors.textPrimary, fontSize: 40, fontWeight: '900', marginTop: 4 },
  cardHint: {
    color: Colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 12,
  },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.danger,
    borderRadius: 14,
    paddingVertical: 15,
    marginTop: 20,
  },
  clearBtnDisabled: { opacity: 0.45 },
  clearBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  footNote: {
    color: Colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 16,
  },
});
