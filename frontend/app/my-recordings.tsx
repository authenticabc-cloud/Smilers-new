/**
 * My Recordings — iter-205
 *
 * Lists every call recording owned by the current viewer, backed by the
 * canonical Convex query `api.callRecording.listMyRecordings` (the same
 * query the chat screen already subscribes to for its "Recorded" badge
 * → playback lookup).
 *
 * Each row launches the existing `RecordingPlaybackModal` for in-place
 * playback so we don't ship a second player UI.
 */
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import Header from '../src/components/Header';
import { RecordingPlaybackModal } from '../src/components/chat/RecordingPlayback';
import { Colors, FontSize, FontWeight, Spacing } from '../src/theme';

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function formatDateLabel(value: any): string {
  if (!value) return '';
  let ms: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = value;
  } else {
    ms = Date.parse(String(value));
  }
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export default function MyRecordingsScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const data = useQuery(
    (api as any).callRecording.listMyRecordings,
    isAuthenticated ? {} : 'skip'
  ) as any[] | undefined;

  const [active, setActive] = useState<null | {
    url: string;
    durationSeconds: number;
    callType: string;
    outcome: string;
  }>(null);

  const rows = useMemo(() => {
    if (!Array.isArray(data)) return [];
    // Newest first.
    return [...data].sort((a: any, b: any) => {
      const ta = Date.parse(String(a?.startedAt || a?._creationTime || 0)) || 0;
      const tb = Date.parse(String(b?.startedAt || b?._creationTime || 0)) || 0;
      return tb - ta;
    });
  }, [data]);

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="my-recordings-screen">
      <Header
        title="My Recordings"
        showBack
        onBack={() => router.back()}
        variant="dark"
        titleIcon={<MaterialCommunityIcons name="folder-music-outline" size={20} color={Colors.white} />}
      />
      {data === undefined ? (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.empty}>
          <MaterialCommunityIcons name="microphone-off" size={48} color={Colors.textSecondary} />
          <Text style={styles.emptyTitle}>No recordings yet</Text>
          <Text style={styles.emptySubtitle}>
            Calls you choose to record will appear here. Open Call Recording settings to set your policy.
          </Text>
          <TouchableOpacity
            onPress={() => router.replace('/call-recording' as any)}
            style={styles.emptyBtn}
            testID="my-recordings-open-settings"
          >
            <Text style={styles.emptyBtnText}>Open Call Recording</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r: any) => String(r._id || r.callId)}
          contentContainerStyle={{ paddingVertical: 8 }}
          renderItem={({ item }) => {
            const isVideo = item?.callType === 'video';
            const title =
              item?.peerName ||
              item?.otherName ||
              item?.contactName ||
              item?.title ||
              (isVideo ? 'Video call' : 'Voice call');
            const subtitle = [
              formatDateLabel(item?.startedAt || item?._creationTime),
              formatDuration(item?.durationSeconds),
            ]
              .filter(Boolean)
              .join('  \u00B7  ');
            const playable = !!item?.url;
            return (
              <TouchableOpacity
                activeOpacity={0.7}
                disabled={!playable}
                onPress={() => {
                  if (!playable) return;
                  setActive({
                    url: String(item.url),
                    durationSeconds: Number(item.durationSeconds || 0),
                    callType: item.callType || 'voice',
                    outcome: item.outcome || 'completed',
                  });
                }}
                style={styles.row}
                testID={`my-recording-row-${item._id || item.callId}`}
              >
                <View style={styles.iconWrap}>
                  <MaterialCommunityIcons
                    name={isVideo ? 'video-outline' : 'phone-outline'}
                    size={20}
                    color={Colors.primary}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
                  {subtitle ? (
                    <Text style={styles.rowSubtitle} numberOfLines={1}>{subtitle}</Text>
                  ) : null}
                </View>
                <MaterialCommunityIcons
                  name={playable ? 'play-circle' : 'progress-clock'}
                  size={28}
                  color={playable ? Colors.primary : Colors.textSecondary}
                />
              </TouchableOpacity>
            );
          }}
        />
      )}
      {active ? (
        <RecordingPlaybackModal
          recording={{
            url: active.url,
            durationSeconds: active.durationSeconds,
            callType: active.callType,
            outcome: active.outcome,
          }}
          onClose={() => setActive(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginTop: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  emptyBtn: {
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 999,
    backgroundColor: Colors.primary,
  },
  emptyBtnText: {
    color: Colors.headerBg,
    fontWeight: FontWeight.bold,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    minHeight: 64,
    backgroundColor: Colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontSize: 15, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSubtitle: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
});
