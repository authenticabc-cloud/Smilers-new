/**
 * IncomingScreenShareModal — global overlay that auto-pops whenever a new
 * pending screen-share request arrives for the current user.
 *
 * Subscribes to `api.screenShare.listIncoming` via useSafeConvexQuery, so
 * the modal is silently dormant until the backend ships the endpoint
 * (returns empty array on missing function — no crash, no noise).
 *
 * The accept flow routes to /call/<shareId> in screen-only viewer mode;
 * decline simply calls the backend mutation and dismisses.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import { api } from '../convexApi';
import { useSafeConvexQuery } from '../hooks/useSafeConvexQuery';
import { useAuth } from '../providers/AuthProvider';
import { getDisplayInitials } from '../lib/displayName';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

interface IncomingRequest {
  shareId: string;
  senderName: string;
  senderAvatar?: string | null;
  includeAudio: boolean;
  requestedAt: number;
}

function normalizeRequest(record: any): IncomingRequest | null {
  if (!record) return null;
  const shareId = record.shareId || record._id || record.id;
  if (!shareId) return null;
  const sender = record.sender || record.from || record.requester || {};
  return {
    shareId: String(shareId),
    senderName:
      sender.displayName ||
      sender.name ||
      record.senderName ||
      'A Smilers user',
    senderAvatar:
      sender.avatarUrl || sender.avatar || sender.photoURL || null,
    includeAudio: !!(record.includeAudio ?? sender.includeAudio ?? false),
    requestedAt: Number(record.requestedAt || record._creationTime || Date.now()),
  };
}

export default function IncomingScreenShareModal() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const [dismissedShareIds, setDismissedShareIds] = useState<Set<string>>(new Set());
  const [busyShareId, setBusyShareId] = useState<string | null>(null);

  const { data: incomingRaw } = useSafeConvexQuery<any[]>(
    (api as any).screenShare?.listIncoming,
    {},
    [],
    isAuthenticated,
  );

  const acceptMutation = useMutation((api as any).screenShare?.accept);
  const declineMutation = useMutation((api as any).screenShare?.decline);

  const pending = useMemo<IncomingRequest[]>(() => {
    const list = Array.isArray(incomingRaw) ? incomingRaw : [];
    return list
      .map((r) => normalizeRequest(r))
      .filter((r): r is IncomingRequest => !!r && !dismissedShareIds.has(r.shareId));
  }, [incomingRaw, dismissedShareIds]);

  const current = pending[0] || null;

  // Reset dismissed set when the auth state changes — fresh sign-in should
  // see incoming requests even if the previous user dismissed them.
  useEffect(() => {
    setDismissedShareIds(new Set());
  }, [isAuthenticated]);

  const handleAccept = useCallback(async () => {
    if (!current) return;
    setBusyShareId(current.shareId);
    try {
      try {
        await (acceptMutation as any)({ shareId: current.shareId });
      } catch (errorValue: any) {
        const message = String(errorValue?.message || errorValue || '');
        // Missing backend — silently route into the viewer with what we have.
        if (
          !message.includes('CouldNotFindFunction') &&
          !message.toLowerCase().includes('not found')
        ) {
          Alert.alert('Could not accept', message.slice(0, 100));
          return;
        }
      }
      setDismissedShareIds((current_) => new Set([...current_, current.shareId]));
      router.push(
        `/call/${current.shareId}?type=screen&screenOnly=1&audio=${current.includeAudio ? 1 : 0}&role=receiver` as any,
      );
    } finally {
      setBusyShareId(null);
    }
  }, [current, acceptMutation, router]);

  const handleDecline = useCallback(async () => {
    if (!current) return;
    setBusyShareId(current.shareId);
    try {
      try {
        await (declineMutation as any)({ shareId: current.shareId });
      } catch {
        /* swallow — missing endpoint or transient failure */
      }
      setDismissedShareIds((current_) => new Set([...current_, current.shareId]));
    } finally {
      setBusyShareId(null);
    }
  }, [current, declineMutation]);

  if (!current) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={handleDecline}
      testID="incoming-screen-share-modal"
    >
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleDecline} />
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <MaterialCommunityIcons name="monitor-share" size={32} color={Colors.primary} />
          </View>
          <Text style={styles.heading}>Screen share request</Text>

          <View style={styles.senderRow}>
            <View style={styles.senderAvatar}>
              {current.senderAvatar ? (
                <Image
                  source={{ uri: current.senderAvatar }}
                  style={styles.senderAvatarImg}
                  resizeMode="cover"
                />
              ) : (
                <Text style={styles.senderAvatarText}>
                  {getDisplayInitials(current.senderName)}
                </Text>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.senderName} numberOfLines={1}>
                {current.senderName}
              </Text>
              <Text style={styles.senderSubtitle}>
                wants to share their screen with you
                {current.includeAudio ? ' and talk over it.' : '.'}
              </Text>
            </View>
          </View>

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.declineBtn]}
              onPress={handleDecline}
              disabled={!!busyShareId}
              activeOpacity={0.85}
              testID="incoming-screen-share-decline"
            >
              <Feather name="x" size={18} color={Colors.white} />
              <Text style={styles.declineText}>Decline</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.acceptBtn]}
              onPress={handleAccept}
              disabled={!!busyShareId}
              activeOpacity={0.85}
              testID="incoming-screen-share-accept"
            >
              {busyShareId === current.shareId ? (
                <ActivityIndicator color="#3D2A00" />
              ) : (
                <>
                  <Feather name="check" size={18} color="#3D2A00" />
                  <Text style={styles.acceptText}>Accept</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: Colors.background,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    alignItems: 'center',
    gap: 14,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heading: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  senderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    width: '100%',
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
  },
  senderAvatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  senderAvatarImg: { width: 50, height: 50, borderRadius: 25 },
  senderAvatarText: {
    fontSize: FontSize.lg,
    color: Colors.primary,
    fontWeight: FontWeight.bold,
  },
  senderName: {
    fontSize: FontSize.lg,
    color: Colors.textPrimary,
    fontWeight: FontWeight.bold,
  },
  senderSubtitle: {
    marginTop: 2,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 18,
  },

  actions: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
    marginTop: 6,
  },
  actionBtn: {
    flex: 1,
    minHeight: 50,
    borderRadius: Radius.md,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  declineBtn: { backgroundColor: '#DC2626' },
  declineText: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.base },
  acceptBtn: { backgroundColor: Colors.primary },
  acceptText: { color: '#3D2A00', fontWeight: FontWeight.bold, fontSize: FontSize.base },
});
