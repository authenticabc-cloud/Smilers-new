/**
 * PhoneViewRequestBanner — owner-side "view my phone number" approval flow.
 *
 * When a group member who does NOT have your number saved on their device taps
 * the eye button on your masked number, this surfaces a banner on YOUR device
 * with Approve / Decline. Approving lets that member view + copy your number;
 * declining keeps it masked (they may retry).
 *
 * Backend (web-canonical Convex — see native-phone-view-request-contract.json):
 *   - query    api.phoneViewRequests.getIncoming  → pending requests for me
 *   - mutation api.phoneViewRequests.respond({ requestId, accept })
 *
 * Mirrors PhotoSaveRequestBanner exactly. Degrades gracefully (renders nothing)
 * until the backend deploys those functions. Mounted globally in the Chats tab.
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

export function PhoneViewRequestBanner() {
  const { isAuthenticated } = useAuth();
  const respond = useMutation((api as any).phoneViewRequests?.respond);
  const { data } = useSafeConvexQuery<any[]>(
    (api as any).phoneViewRequests?.getIncoming,
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
    <View style={styles.banner} testID="phone-view-request-banner">
      <View style={styles.iconWrap}>
        <Feather name="phone" size={18} color={Colors.primary} />
      </View>
      <View style={styles.mid}>
        <Text style={styles.title} numberOfLines={2}>
          {requesterName(first)} wants to view your phone number
        </Text>
        <Text style={styles.sub}>Approve to let them see and copy it.</Text>
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.btn, styles.decline]}
          onPress={() => handle(false)}
          disabled={busy}
          testID="phone-view-decline"
        >
          <Feather name="x" size={18} color={Colors.danger} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.approve]}
          onPress={() => handle(true)}
          disabled={busy}
          testID="phone-view-approve"
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
