import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import GroupSwipeRow from '../../src/components/GroupSwipeRow';
import DraggableFlatList, { ScaleDecorator, type RenderItemParams } from 'react-native-draggable-flatlist';
import UndoSnackbar from '../../src/components/UndoSnackbar';
import * as Haptics from 'expo-haptics';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { useReactiveSafeConvexQuery } from '../../src/hooks/useReactiveSafeConvexQuery';
import { readStoredString, writeStoredString } from '../../src/lib/settingsStorage';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../src/theme';

const MAX_PINNED_GROUPS = 20;
const PIN_TIP_KEY = 'smilers_pin_tip_dismissed';
const GROUP_FILTER_KEY = 'groups_filter_v1';
const GROUP_WHATS_NEW_KEY = 'whatsnew_group_swipe_read_v1';
const MARK_UNREAD_ENABLED = process.env.EXPO_PUBLIC_MARK_UNREAD_ENABLED === 'true';

type Tab = 'groups' | 'conferences';

function formatRelativeDays(ts?: number): string {
  if (!ts) return '—';
  const diffMs = Date.now() - ts;
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 1) {
    const hours = Math.floor(diffMs / 3_600_000);
    if (hours < 1) return 'now';
    return `${hours}h`;
  }
  if (days === 1) return '1 day';
  return `${days} days`;
}

function formatConferenceDate(ts?: number): string {
  if (!ts) return 'Today';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ts));
  } catch {
    return 'Today';
  }
}

function getListItemId(item: any): string | null {
  const value = item?._id || item?.id || item?.conversationId || item?.conferenceId;
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

// Only genuine groups (ones the user actually created/joined) belong in the
// Groups tab. When a 1:1 call has participants ADDED to it, the backend turns
// it into a multi-party "conference" conversation — those are calls, not
// groups, and must NOT show up here. We defensively drop anything flagged as a
// conference / ad-hoc call conversation, across the field names the backend
// might use, while keeping every real group.
export default function GroupsScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('groups');
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState<'all' | 'unread'>('all');
  const [inviteCode, setInviteCode] = useState('');
  const [undoReadId, setUndoReadId] = useState<string | null>(null);

  // Reactive so pin / unpin / reorder re-sorts the list live. The backend
  // returns groups already sorted (pinned first in pinOrder, then unpinned by
  // latest message), each carrying `isPinned` and `pinOrder`.
  const { data: groups, loading: groupsLoading } = useReactiveSafeConvexQuery<any[]>(
    api.conversations.listGroups,
    {},
    [],
    true,
  );

  // Conferences come from a dedicated backend list — NOT from filtering the
  // groups list (which only ever contains groups). The deployed spec
  // exposes `conferences.listMyConferences` (mine, sorted by scheduledAt) and
  // `conferences.listAll` (mine + ended, excludes adjourned). We prefer
  // `listMyConferences`. The `useSafeConvexQuery` hook falls back to [] if
  // the function isn't found, but the previous code was calling a non-
  // existent `listConferences` path so this list was always empty on native.
  const { data: conferences, loading: conferencesLoading } = useSafeConvexQuery<any[]>(
    (api as any).conferences.listMyConferences ?? (api as any).conferences.listAll,
    {},
    [],
    tab === 'conferences',
  );

  const activeLoading = tab === 'conferences' ? conferencesLoading : groupsLoading;

  // Per-conversation unread counts { convId: count } → per-group row badges.
  const { data: unreadCounts } = useReactiveSafeConvexQuery<Record<string, number>>(
    (api as any).messages.getUnreadCounts,
    {},
    {},
    tab === 'groups',
  );

  const list = useMemo(() => {
    const isGroups = tab === 'groups';
    let raw: any[] = isGroups
      ? (Array.isArray(groups) ? groups : [])
      : (Array.isArray(conferences) ? conferences : []);
    const q = search.trim().toLowerCase();
    if (q) {
      raw = raw.filter((g: any) =>
        `${g.name || ''} ${g.description || ''} ${g.lastMessageText || ''}`.toLowerCase().includes(q),
      );
    }
    if (!isGroups) return raw;
    // Stable re-sort for the Groups tab: pinned groups stay on top (in the
    // backend's pin order), then UNREAD groups float above read ones, while
    // otherwise preserving the backend's latest-message order.
    const decorated = raw.map((g: any, i: number) => ({ g, i }));
    decorated.sort((a, b) => {
      const ap = a.g?.isPinned ? 1 : 0;
      const bp = b.g?.isPinned ? 1 : 0;
      if (ap !== bp) return bp - ap; // pinned first
      if (ap === 1) return a.i - b.i; // both pinned → keep pin order
      const aId = getListItemId(a.g);
      const bId = getListItemId(b.g);
      const aUnread = aId && Number(unreadCounts?.[aId]) > 0 ? 1 : 0;
      const bUnread = bId && Number(unreadCounts?.[bId]) > 0 ? 1 : 0;
      if (aUnread !== bUnread) return bUnread - aUnread; // unread first
      return a.i - b.i; // otherwise keep latest-message order
    });
    return decorated.map((x) => x.g);
  }, [conferences, groups, search, tab, unreadCounts]);

  // "Unread" filter chip (Groups tab only).
  const displayGroups = useMemo(() => {
    if (tab !== 'groups' || groupFilter !== 'unread') return list;
    return list.filter((g: any) => {
      const id = getListItemId(g);
      return id && Number(unreadCounts?.[id]) > 0;
    });
  }, [list, tab, groupFilter, unreadCounts]);
  const unreadGroupCount = useMemo(
    () =>
      (Array.isArray(groups) ? groups : []).filter((g: any) => {
        const id = getListItemId(g);
        return id && Number(unreadCounts?.[id]) > 0;
      }).length,
    [groups, unreadCounts],
  );

  const onAdd = () => {
    if (tab === 'groups') {
      router.push('/groups-create' as any);
      return;
    }
    router.push('/conference-create' as any);
  };

  const openItem = (item: any) => {
    const itemId = getListItemId(item);
    if (!itemId) {
      return;
    }
    if (tab === 'conferences') {
      router.push(`/conference/${itemId}` as any);
      return;
    }
    router.push(`/chat/${itemId}` as any);
  };

  // --- Join by invite code (api.conferences.joinByCode) ---
  const joinByCodeM = useMutation((api as any).conferences.joinByCode);
  const [joining, setJoining] = useState(false);

  const handleJoinByCode = useCallback(async () => {
    const code = inviteCode.trim().toUpperCase();
    if (!code) {
      Alert.alert('Enter a code', 'Please enter a conference invite code to join.');
      return;
    }
    if (joining) return;
    setJoining(true);
    try {
      const result: any = await joinByCodeM({ inviteCode: code });
      const conferenceId = String(result?._id || result?.id || result || '');
      if (!conferenceId) {
        Alert.alert('Could not join', 'The server did not return a conference reference. Please try again.');
        return;
      }
      setInviteCode('');
      router.push(`/conference/${conferenceId}` as any);
    } catch (e: any) {
      const message = String(e?.message || e || '');
      const lower = message.toLowerCase();
      if (lower.includes('not_found') || lower.includes('invalid') || lower.includes('no such')) {
        Alert.alert('Invalid code', 'That invite code didn\u2019t match any conference. Double-check and try again.');
      } else if (lower.includes('couldnotfindfunction') || lower.includes('no function')) {
        Alert.alert(
          'Join unavailable',
          'The join-by-code endpoint isn\u2019t available on this backend yet. Please try again after the latest backend update ships.',
        );
      } else if (lower.includes('ended') || lower.includes('adjourned')) {
        Alert.alert('Conference closed', 'This conference has already ended and cannot be joined.');
      } else {
        Alert.alert('Could not join', message || 'Something went wrong. Please try again.');
      }
    } finally {
      setJoining(false);
    }
  }, [inviteCode, joining, joinByCodeM, router]);

  // --- Pinned groups (api.pinnedGroups.*) ---
  const pinGroupM = useMutation((api as any).pinnedGroups?.pinGroup);
  const unpinGroupM = useMutation((api as any).pinnedGroups?.unpinGroup);
  const reorderPinnedM = useMutation((api as any).pinnedGroups?.reorderPinnedGroups);
  const markReadM = useMutation((api as any).messages.markRead);
  const markUnreadM = useMutation((api as any).messages.markUnread);
  const [reorderOpen, setReorderOpen] = useState(false);
  const [reorderList, setReorderList] = useState<any[]>([]);
  const [pinBusy, setPinBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;

  const showToast = useCallback(
    (msg: string) => {
      setToast(msg);
      toastOpacity.stopAnimation();
      Animated.sequence([
        Animated.timing(toastOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.delay(1600),
        Animated.timing(toastOpacity, { toValue: 0, duration: 250, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setToast(null);
      });
    },
    [toastOpacity],
  );

  const pinnedGroups = useMemo(
    () => (Array.isArray(groups) ? groups.filter((g: any) => g?.isPinned) : []),
    [groups],
  );

  // First-time discoverability tip: shown only until the user pins a group or
  // dismisses it.
  const [tipDismissed, setTipDismissed] = useState(true);
  useEffect(() => {
    readStoredString(PIN_TIP_KEY).then((v) => setTipDismissed(v === '1')).catch(() => {});
  }, []);
  const dismissTip = useCallback(() => {
    setTipDismissed(true);
    writeStoredString(PIN_TIP_KEY, '1').catch(() => {});
  }, []);

  // Persist the Groups "All/Unread" filter across restarts.
  const groupFilterLoaded = useRef(false);
  useEffect(() => {
    readStoredString(GROUP_FILTER_KEY)
      .then((v) => {
        if (v === 'unread') setGroupFilter('unread');
      })
      .catch(() => {})
      .finally(() => {
        groupFilterLoaded.current = true;
      });
  }, []);
  useEffect(() => {
    if (!groupFilterLoaded.current) return;
    writeStoredString(GROUP_FILTER_KEY, groupFilter).catch(() => {});
  }, [groupFilter]);

  // One-time "what's new" tip for group swipe-to-read + Unread filter.
  const [whatsNewVisible, setWhatsNewVisible] = useState(false);
  useEffect(() => {
    readStoredString(GROUP_WHATS_NEW_KEY)
      .then((v) => {
        if (v !== '1') setWhatsNewVisible(true);
      })
      .catch(() => {});
  }, []);
  const dismissWhatsNew = useCallback(() => {
    setWhatsNewVisible(false);
    writeStoredString(GROUP_WHATS_NEW_KEY, '1').catch(() => {});
  }, []);
  const showPinTip =
    tab === 'groups' && !tipDismissed && Array.isArray(groups) && groups.length > 0 && pinnedGroups.length === 0;

  const togglePin = useCallback(
    async (item: any) => {
      const id = getListItemId(item);
      if (!id) return;
      const isPinned = !!item.isPinned;
      if (!isPinned && pinnedGroups.length >= MAX_PINNED_GROUPS) {
        Alert.alert('Pin limit reached', `You can pin up to ${MAX_PINNED_GROUPS} groups. Unpin one first.`);
        return;
      }
      const fn = isPinned ? unpinGroupM : pinGroupM;
      if (typeof fn !== 'function') {
        Alert.alert('Unavailable', 'Pinning will be available after the next update.');
        return;
      }
      setPinBusy(true);
      try {
        await fn({ conversationId: id });
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        showToast(isPinned ? 'Unpinned' : 'Pinned to top');
      } catch (e: any) {
        Alert.alert(isPinned ? 'Unpin failed' : 'Pin failed', String(e?.message || e || 'Please try again.'));
      } finally {
        setPinBusy(false);
      }
    },
    [pinnedGroups.length, pinGroupM, unpinGroupM, showToast],
  );

  const onLongPressGroup = useCallback(
    (item: any) => {
      const id = getListItemId(item);
      if (!id) return;
      const isPinned = !!item.isPinned;
      const buttons: any[] = [
        { text: isPinned ? 'Unpin group' : 'Pin to top', onPress: () => togglePin(item) },
      ];
      if (pinnedGroups.length > 1) {
        buttons.push({
          text: 'Reorder pinned groups',
          onPress: () => {
            setReorderList(pinnedGroups);
            setReorderOpen(true);
          },
        });
      }
      buttons.push({ text: 'Cancel', style: 'cancel' });
      Alert.alert(item.name || 'Group', isPinned ? 'Pinned to the top of your groups.' : undefined, buttons);
    },
    [pinnedGroups, togglePin],
  );

  const moveReorderItem = useCallback((index: number, dir: -1 | 1) => {
    setReorderList((prev) => {
      const next = [...prev];
      const j = index + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  }, []);

  const saveReorder = useCallback(async () => {
    const orderedGroupIds = reorderList.map((g) => getListItemId(g)).filter(Boolean);
    if (typeof reorderPinnedM !== 'function') {
      Alert.alert('Unavailable', 'Reordering will be available after the next update.');
      return;
    }
    setPinBusy(true);
    try {
      await reorderPinnedM({ orderedGroupIds });
      setReorderOpen(false);
      showToast('Pin order saved');
    } catch (e: any) {
      Alert.alert('Reorder failed', String(e?.message || e || 'Please try again.'));
    } finally {
      setPinBusy(false);
    }
  }, [reorderList, reorderPinnedM, showToast]);

  if (tab === 'conferences') {
    return (
      <SafeAreaView style={styles.conferenceScreen} edges={['top']} testID="conference-screen">
        <View style={styles.conferenceHeader} testID="conference-header">
          <TouchableOpacity
            onPress={() => setTab('groups')}
            style={styles.conferenceHeaderButton}
            testID="conference-back-button"
          >
            <Ionicons name="arrow-back" size={28} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.conferenceHeaderTitle} testID="conference-header-title">Conferences</Text>
          <TouchableOpacity onPress={onAdd} style={styles.conferenceHeaderButton} testID="conference-add-button">
            <Ionicons name="add" size={30} color={Colors.textPrimary} />
          </TouchableOpacity>
        </View>

        <View style={styles.conferenceSearchOuter} testID="conference-search-outer">
          <View style={styles.conferenceSearchPill}>
            <Feather name="search" size={18} color={Colors.textMuted} />
            <TextInput
              placeholder="Search conferences..."
              placeholderTextColor="#A29A8E"
              value={search}
              onChangeText={setSearch}
              style={styles.conferenceSearchInput}
              autoCapitalize="none"
              autoCorrect={false}
              testID="conference-search-input"
            />
          </View>
        </View>

        <View style={styles.inviteRow} testID="conference-invite-row">
          <TextInput
            value={inviteCode}
            onChangeText={setInviteCode}
            placeholder="ENTER INVITE CODE..."
            placeholderTextColor="#9C9487"
            style={styles.inviteInput}
            autoCapitalize="characters"
            autoCorrect={false}
            testID="conference-invite-input"
          />
          <TouchableOpacity
            style={[styles.joinButton, joining ? styles.joinButtonDisabled : null]}
            onPress={handleJoinByCode}
            disabled={joining}
            testID="conference-join-button"
          >
            {joining ? (
              <ActivityIndicator size="small" color={Colors.headerBg} />
            ) : (
              <Text style={styles.joinButtonText}>Join</Text>
            )}
          </TouchableOpacity>
        </View>

        <FlatList
          data={list}
          keyExtractor={(item: any, index) => getListItemId(item) || `conference-${index}`}
          contentContainerStyle={styles.conferenceListContent}
          renderItem={({ item }) => {
            const itemId = getListItemId(item);
            const memberCount = item?.memberCount || item?.members?.length || 0;
            const badgeText = item?.scheduleLabel || item?.frequency || 'weekly';
            return (
              <TouchableOpacity
                style={styles.conferenceRow}
                activeOpacity={0.82}
                onPress={() => openItem(item)}
                disabled={!itemId}
                testID={`conference-row-${itemId || 'unknown'}`}
              >
                <View style={styles.conferenceIconWrap}>
                  <Ionicons name="videocam" size={24} color={Colors.textPrimary} />
                </View>
                <View style={styles.conferenceInfoWrap}>
                  <Text style={styles.conferenceName} numberOfLines={1}>{(item?.name || 'Conference').toUpperCase()}</Text>
                  <View style={styles.conferenceMetaRow}>
                    <Text style={styles.conferenceMetaText}>{formatConferenceDate(item?.updatedAt || item?._creationTime)}</Text>
                    <View style={styles.conferenceMembersWrap}>
                      <Ionicons name="people-outline" size={14} color={Colors.textSecondary} />
                      <Text style={styles.conferenceMetaText}>{memberCount}</Text>
                    </View>
                  </View>
                </View>
                <View style={styles.conferenceBadge} testID={`conference-badge-${itemId || 'unknown'}`}>
                  <Text style={styles.conferenceBadgeText}>{badgeText}</Text>
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            activeLoading ? (
              <View style={styles.loadingState} testID="conference-loading-state">
                <ActivityIndicator size="small" color={Colors.primary} />
                <Text style={styles.loadingText}>Loading conferences…</Text>
              </View>
            ) : (
              <View style={styles.conferenceEmpty} testID="conference-empty-state">
                <Ionicons name="videocam-outline" size={40} color={Colors.textMuted} />
                <Text style={styles.emptyTitle}>No conferences yet</Text>
                <Text style={styles.emptySub}>Tap the + button above to create your first conference.</Text>
              </View>
            )
          }
        />

        <TouchableOpacity style={styles.sosButton} onPress={() => router.push('/emergency' as any)} testID="conference-sos-button">
          <Text style={styles.sosButtonText}>SOS</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="groups-screen">
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{tab === 'groups' ? 'Groups' : 'Conferences'}</Text>
        <TouchableOpacity hitSlop={10} onPress={onAdd} testID="groups-add-btn" style={styles.headerBtn}>
          <Feather name="plus" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
      </View>

      {/* Tabs */}
      <View style={styles.tabsRow}>
        <TouchableOpacity
          style={styles.tabBtn}
          onPress={() => setTab('groups')}
          activeOpacity={0.7}
          testID="groups-tab-groups"
        >
          <View style={styles.tabLabelRow}>
            <Ionicons
              name="people-outline"
              size={18}
              color={tab === 'groups' ? Colors.primary : Colors.textSecondary}
            />
            <Text style={[styles.tabText, tab === 'groups' ? styles.tabTextActive : null]}>Groups</Text>
          </View>
          {tab === 'groups' ? <View style={styles.tabIndicator} /> : null}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.tabBtn}
          onPress={() => setTab('conferences')}
          activeOpacity={0.7}
          testID="groups-tab-conferences"
        >
          <View style={styles.tabLabelRow}>
            <Ionicons
              name="videocam-outline"
              size={18}
              color={tab === 'conferences' ? Colors.primary : Colors.textSecondary}
            />
            <Text style={[styles.tabText, tab === 'conferences' ? styles.tabTextActive : null]}>Conferences</Text>
          </View>
          {tab === 'conferences' ? <View style={styles.tabIndicator} /> : null}
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={styles.searchOuter}>
        <View style={styles.searchPill}>
          <Feather name="search" size={18} color={Colors.textMuted} />
          <TextInput
            placeholder={tab === 'groups' ? 'Search groups...' : 'Search conferences...'}
            placeholderTextColor={Colors.textMuted}
            value={search}
            onChangeText={setSearch}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            testID="groups-search"
          />
        </View>
      </View>

      {tab === 'groups' ? (
        <View style={styles.filterChipsRow}>
          <TouchableOpacity
            style={[styles.filterChip, groupFilter === 'all' && styles.filterChipActive]}
            onPress={() => setGroupFilter('all')}
            activeOpacity={0.7}
            testID="group-filter-all"
          >
            <Text style={[styles.filterChipText, groupFilter === 'all' && styles.filterChipTextActive]}>All</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.filterChip, groupFilter === 'unread' && styles.filterChipActive]}
            onPress={() => setGroupFilter('unread')}
            activeOpacity={0.7}
            testID="group-filter-unread"
          >
            <Text style={[styles.filterChipText, groupFilter === 'unread' && styles.filterChipTextActive]}>
              {unreadGroupCount > 0 ? `Unread (${unreadGroupCount > 99 ? '99+' : unreadGroupCount})` : 'Unread'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {tab === 'groups' && whatsNewVisible ? (
        <View style={styles.whatsNewCard} testID="group-whats-new-tip">
          <Ionicons name="flash-outline" size={18} color={Colors.primary} />
          <View style={styles.whatsNewTextWrap}>
            <Text style={styles.whatsNewTitle}>New gestures</Text>
            <Text style={styles.whatsNewBody}>
              Swipe a group left to mark it read, and tap the Unread filter to focus on active groups.
            </Text>
          </View>
          <TouchableOpacity onPress={dismissWhatsNew} hitSlop={10} testID="group-whats-new-dismiss">
            <Ionicons name="close" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        </View>
      ) : null}

      <FlatList
        data={displayGroups}
        keyExtractor={(item: any, index) => getListItemId(item) || `${tab}-fallback-${index}`}
        contentContainerStyle={{ paddingBottom: 120 }}
        ListHeaderComponent={
          showPinTip ? (
            <View style={styles.pinTip} testID="pin-tip">
              <Ionicons name="pin" size={16} color={Colors.primary} style={{ transform: [{ rotate: '45deg' }] }} />
              <Text style={styles.pinTipText}>Tip: long-press any group to pin it to the top.</Text>
              <TouchableOpacity onPress={dismissTip} hitSlop={8} testID="pin-tip-dismiss">
                <Ionicons name="close" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const memberCount = item.memberCount || item.members?.length || 0;
          const sub =
            tab === 'conferences'
              ? memberCount > 0
                ? `${memberCount} member${memberCount === 1 ? '' : 's'} ready for conference`
                : 'Tap to start a conference'
              : item.lastMessageText ||
                item.description ||
                (memberCount > 0 ? `${memberCount} member${memberCount === 1 ? '' : 's'}` : 'Tap to open');
          const stamp = formatRelativeDays(item.lastMessageAt || item.updatedAt || item._creationTime);
          const initial = (item.name || 'G').charAt(0).toUpperCase();
          const itemId = getListItemId(item);
          const isGroupsTab = tab === 'groups';
          const pinned = isGroupsTab && !!item.isPinned;
          const rowUnread = isGroupsTab && itemId ? Number(unreadCounts?.[itemId]) || 0 : 0;
          const rowEl = (
            <TouchableOpacity
              style={styles.row}
              onPress={() => openItem(item)}
              onLongPress={isGroupsTab ? () => onLongPressGroup(item) : undefined}
              delayLongPress={300}
              activeOpacity={0.7}
              disabled={!itemId}
              testID={`group-${itemId || 'unknown'}`}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initial}</Text>
              </View>
              <View style={styles.rowMid}>
                <View style={styles.rowNameLine}>
                  {pinned ? (
                    <Ionicons
                      name="pin"
                      size={14}
                      color={Colors.primary}
                      style={styles.pinIcon}
                      testID={`group-pin-${itemId}`}
                    />
                  ) : null}
                  <Text style={[styles.rowName, rowUnread > 0 && styles.rowNameUnread]} numberOfLines={1}>
                    {item.name || 'Group'}
                  </Text>
                </View>
                <Text style={[styles.rowSub, rowUnread > 0 && styles.rowSubUnread]} numberOfLines={1}>
                  {sub}
                </Text>
              </View>
              <View style={styles.rowRight}>
                <Text style={styles.rowStamp}>{stamp}</Text>
                {rowUnread > 0 ? (
                  <View style={styles.unreadBadge} testID={`group-unread-${itemId}`}>
                    <Text style={styles.unreadBadgeText}>
                      {rowUnread > 99 ? '99+' : rowUnread}
                    </Text>
                  </View>
                ) : memberCount > 0 ? (
                  <View style={styles.memberCount}>
                    <Ionicons name="people-outline" size={14} color={Colors.textSecondary} />
                    <Text style={styles.memberCountText}>{memberCount}</Text>
                  </View>
                ) : null}
              </View>
            </TouchableOpacity>
          );
          if (isGroupsTab && rowUnread > 0 && itemId) {
            return (
              <GroupSwipeRow
                onMarkRead={async () => {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                  try {
                    await markReadM({ conversationId: itemId });
                  } catch {}
                  setUndoReadId(itemId);
                  try {
                    const { clearConversationNotifications } = require('../../src/push/notifeeMessageDisplay');
                    await clearConversationNotifications(itemId);
                  } catch {}
                }}
              >
                {rowEl}
              </GroupSwipeRow>
            );
          }
          return rowEl;
        }}
        ListEmptyComponent={
          activeLoading ? (
            <View style={styles.loadingState} testID="groups-loading-state">
              <ActivityIndicator size="small" color={Colors.primary} />
              <Text style={styles.loadingText}>Loading {tab === 'groups' ? 'groups' : 'conferences'}…</Text>
            </View>
          ) : tab === 'groups' && groupFilter === 'unread' ? (
            <View style={styles.empty} testID="groups-empty">
              <Ionicons name="checkmark-circle-outline" size={42} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No unread groups</Text>
              <Text style={styles.emptySub}>You&apos;re all caught up</Text>
              <TouchableOpacity
                style={styles.showAllBtn}
                onPress={() => setGroupFilter('all')}
                activeOpacity={0.7}
                testID="group-show-all"
              >
                <Text style={styles.showAllBtnText}>Show all groups</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.empty} testID="groups-empty">
              <Ionicons
                name={tab === 'groups' ? 'people-outline' : 'videocam-outline'}
                size={42}
                color={Colors.textMuted}
              />
              <Text style={styles.emptyTitle}>
                {tab === 'groups' ? 'No groups yet' : 'No conferences yet'}
              </Text>
              <Text style={styles.emptySub}>
                {tab === 'groups'
                  ? 'Tap + to start a new group conversation'
                  : 'Tap + to create your first conference'}
              </Text>
            </View>
          )
        }
      />

      {/* Reorder pinned groups modal */}
      <Modal
        visible={reorderOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setReorderOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <GestureHandlerRootView style={styles.modalCard} testID="reorder-pinned-modal">
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Reorder pinned groups</Text>
              <TouchableOpacity onPress={() => setReorderOpen(false)} testID="reorder-close">
                <Ionicons name="close" size={24} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalHint}>Drag the handle to reorder, or use the arrows.</Text>
            <DraggableFlatList
              data={reorderList}
              keyExtractor={(item: any, index) => getListItemId(item) || `reorder-${index}`}
              style={{ maxHeight: 380 }}
              onDragEnd={({ data }: { data: any[] }) => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                setReorderList(data);
              }}
              renderItem={({ item, drag, isActive, getIndex }: RenderItemParams<any>) => {
                const index = getIndex() ?? 0;
                return (
                  <ScaleDecorator>
                    <View
                      style={[styles.reorderRow, isActive && styles.reorderRowActive]}
                      testID={`reorder-row-${getListItemId(item)}`}
                    >
                      <Text style={styles.reorderIndex}>{index + 1}</Text>
                      <Text style={styles.reorderName} numberOfLines={1}>{item.name || 'Group'}</Text>
                      <TouchableOpacity
                        style={[styles.reorderBtn, index === 0 && styles.reorderBtnDisabled]}
                        disabled={index === 0}
                        onPress={() => moveReorderItem(index, -1)}
                        testID={`reorder-up-${getListItemId(item)}`}
                      >
                        <Feather name="arrow-up" size={18} color={index === 0 ? Colors.textMuted : Colors.primary} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.reorderBtn, index === reorderList.length - 1 && styles.reorderBtnDisabled]}
                        disabled={index === reorderList.length - 1}
                        onPress={() => moveReorderItem(index, 1)}
                        testID={`reorder-down-${getListItemId(item)}`}
                      >
                        <Feather name="arrow-down" size={18} color={index === reorderList.length - 1 ? Colors.textMuted : Colors.primary} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        onLongPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                          drag();
                        }}
                        delayLongPress={120}
                        style={styles.reorderHandle}
                        testID={`reorder-drag-${getListItemId(item)}`}
                      >
                        <Feather name="menu" size={22} color={Colors.textMuted} />
                      </TouchableOpacity>
                    </View>
                  </ScaleDecorator>
                );
              }}
            />
            <TouchableOpacity
              style={[styles.reorderSave, pinBusy && styles.reorderBtnDisabled]}
              onPress={saveReorder}
              disabled={pinBusy}
              testID="reorder-save"
            >
              {pinBusy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.reorderSaveText}>Save order</Text>
              )}
            </TouchableOpacity>
          </GestureHandlerRootView>
        </View>
      </Modal>

      {toast ? (
        <Animated.View pointerEvents="none" style={[styles.toast, { opacity: toastOpacity }]} testID="groups-toast">
          <Ionicons name="checkmark-circle" size={16} color="#fff" />
          <Text style={styles.toastText}>{toast}</Text>
        </Animated.View>
      ) : null}
      <UndoSnackbar
        visible={!!undoReadId && MARK_UNREAD_ENABLED}
        message="Marked as read"
        onUndo={async () => {
          if (!undoReadId) return;
          try {
            await markUnreadM({ conversationId: undoReadId });
          } catch {}
        }}
        onDismiss={() => setUndoReadId(null)}
      />
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  whatsNewCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    marginHorizontal: Spacing.base,
    marginBottom: Spacing.sm,
    padding: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  whatsNewTextWrap: { flex: 1 },
  whatsNewTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginBottom: 2 },
  whatsNewBody: { fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 17 },
  rowNameLine: { flexDirection: 'row', alignItems: 'center' },
  pinIcon: { marginRight: 5, transform: [{ rotate: '45deg' }] },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.base,
    paddingBottom: 32,
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modalTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  modalHint: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4, marginBottom: 12 },
  reorderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(60,40,0,0.08)',
  },
  reorderIndex: { width: 22, textAlign: 'center', fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textSecondary },
  reorderName: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  reorderBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryLight,
  },
  reorderBtnDisabled: { opacity: 0.5 },
  reorderRowActive: { backgroundColor: Colors.primaryLight, borderRadius: Radius.md },
  reorderHandle: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  toast: {
    position: 'absolute',
    bottom: 90,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(20,20,20,0.92)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: Radius.pill,
  },
  toastText: { color: '#fff', fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  pinTip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: Spacing.base,
    marginTop: 12,
    padding: 12,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryLight,
  },
  pinTipText: { flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary },
  reorderSave: {
    marginTop: 16,
    height: 50,
    borderRadius: Radius.lg,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reorderSaveText: { color: '#fff', fontSize: FontSize.base, fontWeight: FontWeight.bold },
  conferenceScreen: { flex: 1, backgroundColor: '#F7F3EC' },
  conferenceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F0C96C',
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 18,
  },
  conferenceHeaderButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  conferenceHeaderTitle: {
    fontSize: 24,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  conferenceSearchOuter: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  conferenceSearchPill: {
    minHeight: 48,
    borderRadius: 28,
    backgroundColor: '#EDE6DA',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
  },
  conferenceSearchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },
  inviteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 10,
  },
  inviteInput: {
    flex: 1,
    minHeight: 44,
    fontSize: FontSize.base,
    color: '#7E776C',
    letterSpacing: 0.8,
  },
  joinButton: {
    minWidth: 74,
    minHeight: 38,
    borderRadius: 20,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#A9D2F3',
  },
  joinButtonDisabled: {
    opacity: 0.55,
  },
  joinButtonText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  conferenceListContent: {
    paddingBottom: 120,
  },
  conferenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  conferenceIconWrap: {
    width: 50,
    height: 50,
    borderRadius: 14,
    backgroundColor: '#F4CD75',
    alignItems: 'center',
    justifyContent: 'center',
  },
  conferenceInfoWrap: {
    flex: 1,
  },
  conferenceName: {
    fontSize: 17,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  conferenceMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 5,
  },
  conferenceMetaText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  conferenceMembersWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  conferenceBadge: {
    minHeight: 30,
    paddingHorizontal: 12,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#B8D9F2',
  },
  conferenceBadgeText: {
    fontSize: FontSize.sm,
    color: '#41627C',
    fontWeight: FontWeight.medium,
  },
  conferenceEmpty: {
    alignItems: 'center',
    paddingTop: Spacing.xxl * 2,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.sm,
  },
  sosButton: {
    position: 'absolute',
    left: 16,
    bottom: 92,
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E53B30',
  },
  sosButtonText: {
    fontSize: 18,
    fontWeight: FontWeight.bold,
    color: Colors.white,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
    backgroundColor: Colors.background,
  },
  headerTitle: {
    fontSize: 32,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },

  tabsRow: {
    flexDirection: 'row',
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  tabLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tabText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
  },
  tabTextActive: { color: Colors.primary, fontWeight: FontWeight.bold },
  tabIndicator: {
    position: 'absolute',
    bottom: 0,
    height: 3,
    width: 80,
    borderRadius: 2,
    backgroundColor: Colors.primary,
  },

  searchOuter: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.background,
  },
  filterChipsRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.background,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  filterChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  filterChipText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
  },
  filterChipTextActive: {
    color: Colors.white,
  },
  searchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#EDE5D2',
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    borderRadius: Radius.pill,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    gap: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#00000012',
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: Colors.primary, fontWeight: FontWeight.bold, fontSize: FontSize.xl },
  rowMid: { flex: 1 },
  rowName: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  rowNameUnread: { color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  rowSubUnread: { color: Colors.textPrimary, fontWeight: FontWeight.medium },
  rowRight: { alignItems: 'flex-end', gap: 4 },
  rowStamp: { fontSize: FontSize.sm, color: Colors.textSecondary },
  memberCount: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  memberCountText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    backgroundColor: Colors.tickRed,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadBadgeText: { fontSize: 11, fontWeight: '700', color: Colors.white },

  empty: {
    alignItems: 'center',
    paddingTop: Spacing.xxl * 2,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.sm,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginTop: Spacing.sm },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  showAllBtn: {
    marginTop: Spacing.md,
    paddingHorizontal: 20,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
  },
  showAllBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.white },
  loadingState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: Spacing.xxl * 2,
    gap: Spacing.sm,
  },
  loadingText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
});
