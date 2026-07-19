/**
 * InAppMessageBanner
 *
 * A heads-up banner that slides down from the top when a NEW message arrives
 * while the app is in the FOREGROUND. Since message pushes are now sent
 * data-only (so the OS never auto-displays its own banner and we avoid the
 * duplicate/wrong-name notification), the app itself surfaces the in-app
 * heads-up while you're using it.
 *
 * - Driven purely by the Convex realtime `listConversations` subscription
 *   (Convex de-dupes this identical query with the one the sound hook uses).
 * - Skips: web, backgrounded app, the first snapshot, your own messages, and
 *   the conversation you're currently viewing.
 * - Tap → opens the chat. Swipe up or tap × → dismiss. Auto-dismisses after 4s.
 * - Shows the same DEVICE-CONTACT name the chats list shows.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Image,
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useQuery } from 'convex/react';
import { usePathname, useRouter } from 'expo-router';

import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';
import { getResolvedConversationDisplayName, getConversationDisplayName, getDisplayInitials, normalizeDisplayText } from '../lib/displayName';
import { useDeviceContactIndex, lookupDeviceContactName } from '../lib/deviceContactIndex';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../theme';

const AUTO_DISMISS_MS = 4000;
const HIDDEN_Y = -220;

interface BannerData {
  conversationId: string;
  title: string;
  body: string;
  avatar?: string;
}

export default function InAppMessageBanner() {
  const { isAuthenticated } = useAuth();
  const me = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : ('skip' as any));
  const conversations = useQuery(
    api.conversations.listConversations,
    isAuthenticated ? {} : ('skip' as any),
  );
  const unreadCounts = useQuery(
    (api as any).messages.getUnreadCounts,
    isAuthenticated ? {} : ('skip' as any),
  ) as Record<string, number> | undefined;
  const deviceIndex = useDeviceContactIndex();
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [banner, setBanner] = useState<BannerData | null>(null);
  const translateY = useRef(new Animated.Value(HIDDEN_Y)).current;
  const lastSeenRef = useRef<Map<string, number>>(new Map());
  const initializedRef = useRef(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentUserId = me?._id;

  const clearTimer = () => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
  };

  const dismiss = () => {
    clearTimer();
    Animated.timing(translateY, {
      toValue: HIDDEN_Y,
      duration: 220,
      useNativeDriver: true,
    }).start(() => setBanner(null));
  };

  const open = () => {
    const id = banner?.conversationId;
    dismiss();
    if (id) router.push(`/chat/${id}` as any);
  };

  // Swipe-up to dismiss.
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => g.dy < -6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_e, g) => {
          if (g.dy < 0) translateY.setValue(g.dy);
        },
        onPanResponderRelease: (_e, g) => {
          if (g.dy < -40) {
            dismiss();
          } else {
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
          }
        },
      }),
    // translateY is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [banner],
  );

  // Detect new foreground messages.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!Array.isArray(conversations)) return;
    const map = lastSeenRef.current;

    if (!initializedRef.current) {
      for (const c of conversations as any[]) {
        map.set(c._id, c.lastMessageTime ? new Date(c.lastMessageTime).getTime() : 0);
      }
      initializedRef.current = true;
      return;
    }

    if (AppState.currentState !== 'active') {
      for (const c of conversations as any[]) {
        map.set(c._id, c.lastMessageTime ? new Date(c.lastMessageTime).getTime() : 0);
      }
      return;
    }

    let newest: any = null;
    let newestT = 0;
    for (const c of conversations as any[]) {
      const t = c.lastMessageTime ? new Date(c.lastMessageTime).getTime() : 0;
      const prev = map.get(c._id) ?? 0;
      if (t > prev) {
        const inThisChat = !!pathname && pathname.includes(`/chat/${c._id}`);
        const lastFromMe = c.lastMessageFromMe === true;
        if (!inThisChat && !lastFromMe && t > newestT) {
          newest = c;
          newestT = t;
        }
        map.set(c._id, t);
      }
    }

    if (newest) {
      const isGroup =
        newest?.isGroup === true ||
        newest?.type === 'group' ||
        (Array.isArray(newest?.participants) && newest.participants.length > 2);

      let title: string;
      if (isGroup) {
        const groupName = getConversationDisplayName(newest, currentUserId, 'Group');
        // Sender name isn't guaranteed on the conversation row — read it
        // defensively from any of the fields the backend may expose. When
        // present we show "Sender in Group"; otherwise just the group name.
        const sender = normalizeDisplayText(
          newest?.lastMessageSenderName ??
            newest?.lastSenderName ??
            newest?.lastMessageSender?.name ??
            newest?.lastMessageAuthorName ??
            newest?.lastMessageSenderDisplayName,
        );
        title = sender ? `${sender} in ${groupName}` : groupName;
      } else {
        title = getResolvedConversationDisplayName(
          newest,
          currentUserId,
          deviceIndex,
          lookupDeviceContactName,
          'New message',
        );
      }

      const avatar =
        newest?.avatar ||
        newest?.avatarUrl ||
        newest?.photo ||
        newest?.otherUser?.profilePicture ||
        newest?.otherUser?.avatar ||
        newest?.otherParticipant?.avatar;
      setBanner({
        conversationId: String(newest._id),
        title,
        body: newest.lastMessageText || 'New message',
        avatar: avatar || undefined,
      });
    }
  }, [conversations, pathname, currentUserId, deviceIndex]);

  // Animate in + schedule auto-dismiss whenever a new banner appears.
  useEffect(() => {
    if (!banner) return;
    translateY.setValue(HIDDEN_Y);
    Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 6 }).start();
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    clearTimer();
    dismissTimer.current = setTimeout(dismiss, AUTO_DISMISS_MS);
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [banner]);

  if (!banner) return null;

  const unread = Number(unreadCounts?.[banner.conversationId]) || 0;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.wrap, { paddingTop: insets.top + 6, transform: [{ translateY }] }]}
      {...pan.panHandlers}
    >
      <TouchableOpacity
        activeOpacity={0.92}
        onPress={open}
        style={styles.card}
        testID="in-app-message-banner"
      >
        <View>
          {banner.avatar ? (
            <Image source={{ uri: banner.avatar }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Text style={styles.avatarInitial}>{getDisplayInitials(banner.title, 1)}</Text>
            </View>
          )}
          {unread > 0 ? (
            <View style={styles.badge} testID="in-app-message-banner-badge">
              <Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.textCol}>
          <Text style={styles.title} numberOfLines={1}>
            {banner.title}
          </Text>
          <Text style={styles.body} numberOfLines={2}>
            {banner.body}
          </Text>
        </View>
        <TouchableOpacity onPress={dismiss} hitSlop={10} style={styles.close}>
          <Feather name="x" size={18} color={Colors.textMuted} />
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    elevation: 24,
    paddingHorizontal: Spacing.sm,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    ...Shadow.md,
  },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.borderLight },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
  },
  avatarInitial: { color: Colors.white, fontSize: FontSize.base, fontWeight: FontWeight.bold },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.surface,
  },
  badgeText: { color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold },
  textCol: { flex: 1 },
  title: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  body: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 1 },
  close: { padding: 4 },
});
