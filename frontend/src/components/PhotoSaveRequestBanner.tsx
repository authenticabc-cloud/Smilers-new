/**
 * PhotoSaveRequestBanner — owner-side profile-photo save approval flow.
 *
 * When another (non-trustee) user taps "Request to save" on your enlarged
 * profile photo, this surfaces a banner on the owner's device with
 * Approve / Decline. Trustees of the owner can save directly (no request),
 * so they never appear here.
 *
 * Backend (web-canonical, synced with the web app — see
 * /app/PHOTO_SAVE_REQUEST_BACKEND_SPEC.md):
 *   - query  api.photoSaveRequests.getIncoming  → pending requests for me
 *   - mutation api.photoSaveRequests.respond({ requestId, accept })
 *
 * Degrades gracefully (renders nothing) until the backend deploys those
 * functions. Mounted globally in the Chats tab.
 */
import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';
import { useSafeConvexQuery } from '../hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Shadow } from '../theme';

const EMPTY: any[] = [];

const requesterName = (row: any): string =>
  row?.requesterName ||
  row?.fromName ||
  row?.viewerName ||
  row?.requesterDisplayName ||
  'Someone';

const rowId = (row: any): any => row?._id || row?.requestId || row?.id;

export function PhotoSaveRequestBanner() {
  const { isAuthenticated } = useAuth();
  const respond = useMutation((api as any).photoSaveRequests?.respond);
  const { data } = useSafeConvexQuery<any[]>(
    (api as any).photoSaveRequests?.getIncoming,
    {},
    EMPTY,
    isAuthenticated,
  );

  const [busyId, setBusyId] = useState<string | null>(null);

  const list = (Array.isArray(data) ? data : EMPTY).filter((row: any) => {
    if (!rowId(row)) return false;
    if (row?.status && String(row.status) !== 'pending') return false;
    return true;
  });

  if (list.length === 0) return null;
  const first = list[0];
  const id = String(rowId(first));
  const busy = busyId === id;

  const handle = async (accept: boolean) => {
    if (busy) return;
    setBusyId(id);
    try {
      await respond?.({ requestId: rowId(first), accept } as any);
    } catch {
      // Best-effort; a stale/expired request resolving server-side is harmless.
    } finally {
      setBusyId(null);
    }
  };

  return (
    <View style={styles.banner} testID="photo-save-request-banner">
      <View style={styles.iconWrap}>
        <Feather name="image" size={18} color={Colors.primary} />
      </View>
      <View style={styles.mid}>
        <Text style={styles.title} numberOfLines={2}>
          {requesterName(first)} wants to save your profile photo
        </Text>
        <Text style={styles.sub}>Approve to let them download it once.</Text>
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.btn, styles.decline]}
          onPress={() => handle(false)}
          disabled={busy}
          testID="photo-save-decline"
        >
          <Feather name="x" size={18} color={Colors.danger} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.approve]}
          onPress={() => handle(true)}
          disabled={busy}
          testID="photo-save-approve"
        >
          {busy ? (
            <ActivityIndicator size="small" color={Colors.white} />
          ) : (
            <Feather name="check" size={18} color={Colors.white} />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: Radius.lg,
    backgroundColor: '#FFFDF5',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#EAD68C',
    gap: 10,
    ...Shadow.sm,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mid: { flex: 1 },
  title: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  sub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  actions: { flexDirection: 'row', gap: 8 },
  btn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  decline: { backgroundColor: '#FDECEC', borderWidth: StyleSheet.hairlineWidth, borderColor: '#F3C2C2' },
  approve: { backgroundColor: Colors.primary },
});
