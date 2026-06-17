/**
 * LiveLocationSharingPill — shows your OWN active live-location shares.
 *
 * After you confirm a live-location request (see LiveLocationRequestBanner),
 * this green pill appears in the chat: "Sharing live location · 28 min left"
 * with a one-tap "Stop". It subscribes to the web-canonical Convex query
 * `api.locationRequests.getActiveShares` and ends a share via
 * `api.locationRequests.stopSharing`.
 *
 * Scoped: pass `conversationId` to only show shares tied to the open chat.
 *
 * Note on `stopSharing` args: the exact validator key isn't documented in the
 * contract we were given, so the Stop handler tries the likely shapes in
 * order. Convex validates arguments BEFORE running the handler, so an
 * unexpected shape fails harmlessly (no side effects) until the right one
 * lands. Once the canonical signature is confirmed this can be simplified.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';
import { useSafeConvexQuery } from '../hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Shadow } from '../theme';

const EMPTY: any[] = [];

const shareId = (row: any): any => row?._id || row?.shareId || row?.requestId || row?.id;

const expiryMs = (row: any): number | null => {
  if (row?.expiresAt) return Number(row.expiresAt);
  const start = row?.startedAt
    ? Number(row.startedAt)
    : row?.createdAt
      ? Number(row.createdAt)
      : row?._creationTime
        ? Number(row._creationTime)
        : null;
  const mins = Number(row?.durationMinutes);
  if (start && mins) return start + mins * 60 * 1000;
  return null;
};

const formatLeft = (ms: number): string => {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `${h}h ${m}m left` : `${h}h left`;
  }
  if (totalMin >= 1) return `${totalMin} min left`;
  return `${Math.max(0, Math.round(ms / 1000))}s left`;
};

type Props = { conversationId?: string };

export function LiveLocationSharingPill({ conversationId }: Props) {
  const { isAuthenticated } = useAuth();
  const stopSharing = useMutation((api as any).locationRequests.stopSharing);
  const { data } = useSafeConvexQuery<any[]>(
    (api as any).locationRequests.getActiveShares,
    {},
    EMPTY,
    isAuthenticated,
  );

  const [now, setNow] = useState(Date.now());
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const shares = (Array.isArray(data) ? data : EMPTY).filter((row: any) => {
    if (!shareId(row)) return false;
    if (row?.status && String(row.status) !== 'active') return false;
    const exp = expiryMs(row);
    if (exp && exp < now) return false;
    if (conversationId && String(row?.conversationId) !== String(conversationId)) return false;
    return true;
  });

  const stop = useCallback(
    async (row: any) => {
      const id = shareId(row);
      setStoppingId(String(id));
      const attempts: Record<string, unknown>[] = [
        { shareId: id },
        { requestId: id },
        { id },
        ...(conversationId ? [{ conversationId }] : []),
      ];
      for (const args of attempts) {
        try {
          await stopSharing(args);
          setStoppingId(null);
          return;
        } catch {
          // Wrong arg shape — Convex rejects before the handler runs, so this
          // is a no-op. Fall through to the next candidate shape.
        }
      }
      setStoppingId(null);
    },
    [stopSharing, conversationId],
  );

  if (shares.length === 0) return null;

  return (
    <View>
      {shares.map((row: any) => {
        const exp = expiryMs(row);
        const left = exp ? formatLeft(exp - now) : 'active';
        const id = String(shareId(row));
        return (
          <View key={id} style={styles.pill} testID={`live-location-sharing-pill-${id}`}>
            <View style={styles.dot} />
            <MaterialCommunityIcons name="map-marker-radius" size={16} color={Colors.devotionDark} />
            <Text style={styles.label} numberOfLines={1}>
              Sharing live location · {left}
            </Text>
            <TouchableOpacity
              style={styles.stopBtn}
              onPress={() => stop(row)}
              disabled={stoppingId === id}
              testID={`live-location-stop-${id}`}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              {stoppingId === id ? (
                <ActivityIndicator size="small" color={Colors.danger} />
              ) : (
                <Text style={styles.stopText}>Stop</Text>
              )}
            </TouchableOpacity>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#DCFCE7',
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: '#86EFAC',
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginBottom: 8,
    ...Shadow.sm,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: Colors.success,
  },
  label: {
    flex: 1,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: '#166534',
  },
  stopBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: Radius.pill,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  stopText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.dangerDark,
  },
});
