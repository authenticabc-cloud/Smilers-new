import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { api } from '../convexApi';
import { useReactiveSafeConvexQuery } from '../hooks/useReactiveSafeConvexQuery';
import { readStoredString, writeStoredString } from '../lib/settingsStorage';
import { loadJoinTracker, detectNewlyJoined } from '../lib/subGroupJoinTracker';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

const SUB_GROUPS_ENABLED = process.env.EXPO_PUBLIC_SUB_GROUPS_ENABLED !== 'false';
const COLLAPSE_KEY = 'smilers.subgroups.collapsed.v1';

let collapsedMapCache: Record<string, boolean> | null = null;
async function loadCollapsedMap(): Promise<Record<string, boolean>> {
  if (collapsedMapCache) return collapsedMapCache;
  try {
    const raw = await readStoredString(COLLAPSE_KEY);
    collapsedMapCache = raw ? JSON.parse(raw) : {};
  } catch {
    collapsedMapCache = {};
  }
  return collapsedMapCache!;
}
async function persistCollapsed(parentId: string, collapsed: boolean) {
  const map = await loadCollapsedMap();
  if (collapsed) map[parentId] = true;
  else delete map[parentId];
  collapsedMapCache = map;
  try {
    await writeStoredString(COLLAPSE_KEY, JSON.stringify(map));
  } catch {}
}

function subId(item: any): string | null {
  const v = item?._id || item?.id || item?.conversationId;
  return v ? String(v) : null;
}

/**
 * SubGroupList — renders the sub groups nested UNDER a mother-group row in the
 * Groups tab. Sub groups never appear as standalone rows; they only show here,
 * and only to users the backend allows to see them (active ones they belong to,
 * plus pending ones the caller created or can approve as a mother-group admin).
 *
 * Backend contract: subGroups.listForParent / approve / reject.
 * Each mother row owns its own live subscription (mounted only while on-screen).
 */
function SubGroupListInner({
  parentConversationId,
  enabled,
  getUnread,
  onOpen,
  onJoined,
}: {
  parentConversationId: string;
  enabled: boolean;
  getUnread: (item: any) => number;
  onOpen: (id: string) => void;
  onJoined?: (name: string) => void;
}) {
  const { data: subGroups } = useReactiveSafeConvexQuery<any[]>(
    (api as any).subGroups?.listForParent,
    parentConversationId ? { parentConversationId } : {},
    [],
    SUB_GROUPS_ENABLED && enabled && !!parentConversationId,
  );

  const approveM = useMutation((api as any).subGroups?.approve);
  const rejectM = useMutation((api as any).subGroups?.reject);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const collapseLoaded = useRef(false);

  useEffect(() => {
    let alive = true;
    void loadCollapsedMap().then((map) => {
      if (alive && !collapseLoaded.current) {
        collapseLoaded.current = true;
        setCollapsed(!!map[parentConversationId]);
      }
    });
    return () => {
      alive = false;
    };
  }, [parentConversationId]);

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      void persistCollapsed(parentConversationId, next);
      return next;
    });
  }, [parentConversationId]);

  const rows = useMemo(() => (Array.isArray(subGroups) ? subGroups.filter((s) => subId(s)) : []), [subGroups]);

  const collapsedUnread = useMemo(
    () => rows.reduce((sum, item) => (item?.subGroupStatus === 'pending' ? sum : sum + getUnread(item)), 0),
    [rows, getUnread],
  );
  const pendingCount = useMemo(() => rows.filter((r) => r?.subGroupStatus === 'pending').length, [rows]);

  // Detect a genuinely-new membership → "You joined X" toast (seeded silently
  // on first load so existing memberships don't fire).
  const [trackerReady, setTrackerReady] = useState(false);
  useEffect(() => {
    void loadJoinTracker().then(() => setTrackerReady(true));
  }, []);
  useEffect(() => {
    if (!trackerReady || !onJoined || !parentConversationId) return;
    const currentIds = rows
      .filter((r) => r?.subGroupStatus !== 'pending' && r?.isMember)
      .map((r) => subId(r))
      .filter(Boolean) as string[];
    const newly = detectNewlyJoined(parentConversationId, currentIds);
    newly.forEach((id) => {
      const item = rows.find((r) => subId(r) === id);
      onJoined(item?.name || 'sub group');
    });
  }, [rows, trackerReady, onJoined, parentConversationId]);

  const onApprove = useCallback(
    async (id: string) => {
      if (!approveM) return;
      setBusyId(id);
      try {
        await approveM({ subGroupId: id });
      } catch (e: any) {
        Alert.alert('Could not approve', e?.data?.message || e?.message || 'Only a mother-group admin can approve.');
      } finally {
        setBusyId(null);
      }
    },
    [approveM],
  );

  const onReject = useCallback(
    (id: string, name: string) => {
      if (!rejectM) return;
      Alert.alert('Reject sub group?', `"${name}" will be removed.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reject',
          style: 'destructive',
          onPress: async () => {
            setBusyId(id);
            try {
              await rejectM({ subGroupId: id });
            } catch (e: any) {
              Alert.alert('Could not reject', e?.data?.message || e?.message || 'Please try again.');
            } finally {
              setBusyId(null);
            }
          },
        },
      ]);
    },
    [rejectM],
  );

  if (rows.length === 0) return null;

  return (
    <View style={styles.wrap} testID={`sub-groups-${parentConversationId}`}>
      <TouchableOpacity
        style={styles.header}
        onPress={toggleCollapse}
        activeOpacity={0.7}
        testID={`sub-groups-toggle-${parentConversationId}`}
      >
        <Ionicons name={collapsed ? 'chevron-forward' : 'chevron-down'} size={16} color={Colors.textSecondary} />
        <Text style={styles.headerText}>
          {rows.length} sub group{rows.length === 1 ? '' : 's'}
        </Text>
        {collapsed && collapsedUnread > 0 ? (
          <View style={styles.headerBadge} testID={`sub-groups-collapsed-unread-${parentConversationId}`}>
            <Text style={styles.headerBadgeText}>{collapsedUnread > 99 ? '99+' : collapsedUnread}</Text>
          </View>
        ) : null}
        {collapsed && pendingCount > 0 ? (
          <View style={styles.headerPendingDot} testID={`sub-groups-collapsed-pending-${parentConversationId}`} />
        ) : null}
      </TouchableOpacity>

      {collapsed
        ? null
        : rows.map((item) => {
        const id = subId(item)!;
        const pending = item?.subGroupStatus === 'pending';
        const unread = pending ? 0 : getUnread(item);
        const memberCount = item?.memberCount || 0;
        const initial = (item?.name || 'S').charAt(0).toUpperCase();
        const busy = busyId === id;
        const appr = (item?.appearance || {}) as { emoji?: string; color?: string };

        if (pending) {
          return (
            <View key={id} style={[styles.row, styles.pendingRow]} testID={`sub-group-pending-${id}`}>
              <View style={styles.connector} />
              <View style={[styles.avatar, styles.pendingAvatar]}>
                <Ionicons name="hourglass-outline" size={14} color={Colors.white} />
              </View>
              <View style={styles.mid}>
                <Text style={styles.name} numberOfLines={1}>
                  {item?.name || 'Sub group'}
                </Text>
                <Text style={styles.pendingLabel} numberOfLines={1}>
                  Awaiting approval
                </Text>
              </View>
              {busy ? (
                <ActivityIndicator size="small" color={Colors.primary} />
              ) : (
                <View style={styles.pendingActions}>
                  <TouchableOpacity
                    onPress={() => onApprove(id)}
                    style={[styles.pendBtn, styles.approveBtn]}
                    testID={`sub-group-approve-${id}`}
                    hitSlop={8}
                  >
                    <Ionicons name="checkmark" size={16} color={Colors.white} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => onReject(id, item?.name || 'Sub group')}
                    style={[styles.pendBtn, styles.rejectBtn]}
                    testID={`sub-group-reject-${id}`}
                    hitSlop={8}
                  >
                    <Ionicons name="close" size={16} color={Colors.white} />
                  </TouchableOpacity>
                </View>
              )}
            </View>
          );
        }

        return (
          <TouchableOpacity
            key={id}
            style={styles.row}
            onPress={() => onOpen(id)}
            activeOpacity={0.7}
            testID={`sub-group-${id}`}
          >
            <View style={styles.connector} />
            <View style={[styles.avatar, appr.color ? { backgroundColor: appr.color } : null]}>
              {appr.emoji ? <Text style={styles.avatarEmoji}>{appr.emoji}</Text> : <Text style={styles.avatarText}>{initial}</Text>}
            </View>
            <View style={styles.mid}>
              <View style={styles.nameLine}>
                <Ionicons name="git-branch-outline" size={12} color={Colors.textSecondary} style={styles.branchIcon} />
                <Text style={[styles.name, unread > 0 && styles.nameUnread]} numberOfLines={1}>
                  {item?.name || 'Sub group'}
                </Text>
                <View style={styles.subTag}>
                  <Text style={styles.subTagText}>SUB</Text>
                </View>
              </View>
              <Text style={[styles.sub, unread > 0 && styles.subUnread]} numberOfLines={1}>
                {item?.lastMessageText ||
                  (memberCount > 0 ? `${memberCount} member${memberCount === 1 ? '' : 's'}` : 'Tap to open')}
              </Text>
            </View>
            {unread > 0 ? (
              <View style={styles.unreadBadge} testID={`sub-group-unread-${id}`}>
                <Text style={styles.unreadBadgeText}>{unread > 99 ? '99+' : unread}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export const SubGroupList = React.memo(SubGroupListInner);

const AV = 30;
const styles = StyleSheet.create({
  wrap: { paddingLeft: Spacing.xl, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingLeft: Spacing.sm,
    paddingRight: Spacing.lg,
  },
  headerText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: FontWeight.semibold },
  headerBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Colors.danger || '#E53935',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  headerBadgeText: { color: Colors.white, fontSize: 10, fontWeight: '700' },
  headerPendingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.primary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingRight: Spacing.lg,
    paddingLeft: Spacing.sm,
    gap: Spacing.sm,
  },
  pendingRow: { opacity: 0.95 },
  connector: {
    width: 2,
    height: AV,
    backgroundColor: Colors.border || '#E5E1D8',
    borderRadius: 1,
    marginRight: 2,
  },
  avatar: {
    width: AV,
    height: AV,
    borderRadius: AV / 2,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingAvatar: { backgroundColor: Colors.textSecondary },
  avatarText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  avatarEmoji: { fontSize: 16 },
  mid: { flex: 1, gap: 1 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  branchIcon: { marginTop: 1 },
  subTag: {
    backgroundColor: Colors.textSecondary,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  subTagText: { fontSize: 9, fontWeight: '800', color: Colors.white, letterSpacing: 0.5 },
  name: { fontSize: FontSize.base, fontWeight: FontWeight.medium, color: Colors.textPrimary, flexShrink: 1 },
  nameUnread: { fontWeight: FontWeight.bold },
  sub: { fontSize: FontSize.sm, color: Colors.textSecondary },
  subUnread: { color: Colors.textPrimary, fontWeight: FontWeight.medium },
  pendingLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontStyle: 'italic' },
  pendingActions: { flexDirection: 'row', gap: 6 },
  pendBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  approveBtn: { backgroundColor: Colors.success || '#2E7D32' },
  rejectBtn: { backgroundColor: Colors.danger || '#E53935' },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.danger || '#E53935',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadBadgeText: { color: Colors.white, fontSize: 11, fontWeight: '700' },
});
