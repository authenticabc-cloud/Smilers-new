import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { api } from '../../convexApi';
import { useSafeConvexQuery } from '../../hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight } from '../../theme';

/**
 * A single "group in common" candidate. Verifies whether `targetUserId` is a
 * member of this group via `getGroupMembers` (the only reliable source — the
 * conversation list doesn't always carry member IDs), reports the result up,
 * and renders the row only when the target is genuinely a member.
 */
export default function GroupInCommonRow({
  conv,
  targetUserIds,
  targetPhoneE164,
  onResolve,
}: {
  conv: any;
  targetUserIds: string[];
  targetPhoneE164?: string | null;
  onResolve: (convId: string, isMember: boolean) => void;
}) {
  const router = useRouter();
  const { data: members } = useSafeConvexQuery<any[]>(
    api.conversations.getGroupMembers,
    { conversationId: conv?._id },
    [],
    !!conv?._id,
  );
  const isMember = useMemo(() => {
    const idSet = new Set((targetUserIds || []).map((id) => String(id)));
    // Members from getGroupMembers come in several shapes across the backend:
    // flat ({ userId, _id, phone }) OR nested ({ user: { _id, userId, phone } }).
    // Collect EVERY id alias so we don't miss the account id (mirrors the
    // resolution used in app/group/[id].tsx which handles m.user._id too).
    const idsOf = (p: any): string[] =>
      [
        p?.userId,
        p?._id,
        p?.id,
        p?.accountId,
        p?.memberId,
        p?.user?._id,
        p?.user?.userId,
        p?.user?.id,
      ]
        .filter(Boolean)
        .map((v) => String(v));
    const phonesOf = (p: any): any[] => [
      p?.phoneE164,
      p?.phone,
      p?.user?.phoneE164,
      p?.user?.phone,
    ];
    // Last-9-digits key handles country-code variance (e.g. Ghana +233).
    const digitsKey = (v: any) => {
      const d = String(v || '').replace(/\D/g, '');
      return d.length >= 9 ? d.slice(-9) : '';
    };
    const targetDigits = digitsKey(targetPhoneE164);
    const matches = (m: any) => {
      if (idsOf(m).some((cid) => idSet.has(cid))) return true;
      if (!targetDigits) return false;
      return phonesOf(m).some((ph) => digitsKey(ph) === targetDigits);
    };

    if (Array.isArray(members) && members.length > 0) {
      return members.some((m: any) => matches(m));
    }
    // Fallback to any member ids embedded on the conversation object itself.
    const ids = [
      ...(Array.isArray(conv?.participantIds) ? conv.participantIds : []),
      ...(Array.isArray(conv?.memberIds) ? conv.memberIds : []),
      ...(Array.isArray(conv?.participants) ? conv.participants.flatMap(idsOf) : []),
      ...(Array.isArray(conv?.members) ? conv.members.flatMap(idsOf) : []),
    ]
      .filter(Boolean)
      .map(String);
    return ids.some((id) => idSet.has(id));
  }, [members, conv, targetUserIds, targetPhoneE164]);

  useEffect(() => {
    onResolve(String(conv?._id), isMember);
  }, [isMember, conv?._id, onResolve]);

  if (!isMember) return null;
  return (
    <TouchableOpacity
      style={styles.groupRow}
      activeOpacity={0.85}
      onPress={() => router.push(`/group/${conv._id}` as any)}
      testID={`user-profile-group-${conv._id}`}
    >
      <View style={styles.groupAvatar}>
        {conv?.avatar || conv?.avatarUrl ? (
          <Image
            source={{ uri: conv.avatar || conv.avatarUrl }}
            style={styles.groupAvatarImg}
            resizeMode="cover"
          />
        ) : (
          <Ionicons name="people" size={18} color={Colors.primary} />
        )}
      </View>
      <Text style={styles.groupName} numberOfLines={1}>
        {conv?.name || 'Group'}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  groupRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  groupAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  groupAvatarImg: { width: 46, height: 46, borderRadius: 23 },
  groupName: {
    flex: 1,
    fontSize: FontSize.lg,
    color: Colors.textPrimary,
    fontWeight: FontWeight.semibold,
  },
});
