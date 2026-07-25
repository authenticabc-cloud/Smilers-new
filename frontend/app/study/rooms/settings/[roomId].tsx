/**
 * Room settings (admin) — rename, toggle AI access to room material,
 * regenerate the join code, manage members (promote/demote/remove) and
 * delete or leave the room. Owner-only actions are gated on `role`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Colors } from '../../../../src/theme';
import { useRoom } from '../../../../src/lib/study/useRooms';

function pick(o: any, ...keys: string[]) {
  for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
  return undefined;
}

export default function RoomSettings() {
  const insets = useSafeAreaInsets();
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const { room, loading, updateRoom, regenerateJoinCode, setMemberRole, removeMember, deleteRoom, leaveRoom } =
    useRoom(roomId || null);

  const role = pick(room, 'role', 'myRole') || 'member';
  const isOwner = role === 'owner';
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [aiCanRead, setAiCanRead] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);

  // FIX (#4b "can't type in Room name/Description / can't toggle AI"): `room`
  // is a LIVE Convex query whose reference changes on every reactive tick
  // (presence, member polling, etc.). The old effect re-seeded these local
  // fields on EVERY `room` change, so each keystroke / toggle was instantly
  // overwritten by the stored value — making the inputs feel frozen. Seed the
  // local state only ONCE per room (keyed on the room id) and never clobber
  // the user's in-progress edits afterwards.
  const seededForRoomRef = useRef<string | null>(null);
  useEffect(() => {
    if (!room) return;
    const rid = String(pick(room, '_id', 'id') || roomId || '');
    if (!rid || seededForRoomRef.current === rid) return;
    seededForRoomRef.current = rid;
    setName(pick(room, 'name') || '');
    setDescription(pick(room, 'description') || '');
    setAiCanRead(!!pick(room, 'aiCanReadRoomContent'));
  }, [room, roomId]);

  const members: any[] = useMemo(() => {
    const m = pick(room, 'members') || [];
    return Array.isArray(m) ? m : [];
  }, [room]);

  const saveMeta = useCallback(async () => {
    setSavingMeta(true);
    try {
      await updateRoom({ roomId, name: name.trim(), description: description.trim() || undefined });
      Alert.alert('Saved', 'Room details updated.');
    } catch (err: any) {
      Alert.alert('Could not save', err?.data?.message || err?.message || 'Please try again.');
    } finally {
      setSavingMeta(false);
    }
  }, [updateRoom, roomId, name, description]);

  const toggleAi = useCallback(
    async (val: boolean) => {
      setAiCanRead(val);
      try {
        await updateRoom({ roomId, aiCanReadRoomContent: val });
      } catch {
        setAiCanRead(!val); // revert on failure
        Alert.alert('Could not update', 'Please try again.');
      }
    },
    [updateRoom, roomId],
  );

  const regenerate = useCallback(() => {
    Alert.alert('Regenerate code?', 'The old code stops working immediately.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Regenerate',
        onPress: () => regenerateJoinCode({ roomId } as any).catch(() => Alert.alert('Could not regenerate')),
      },
    ]);
  }, [regenerateJoinCode, roomId]);

  const manageMember = useCallback(
    (m: any) => {
      const uid = pick(m, 'userId', '_id');
      const mrole = pick(m, 'role') || 'member';
      if (mrole === 'owner') return;
      const options: any[] = [];
      if (mrole === 'member') {
        options.push({ text: 'Make admin', onPress: () => setMemberRole({ roomId, userId: uid, role: 'admin' } as any).catch(() => {}) });
      } else if (mrole === 'admin' && isOwner) {
        options.push({ text: 'Remove admin', onPress: () => setMemberRole({ roomId, userId: uid, role: 'member' } as any).catch(() => {}) });
      }
      options.push({
        text: 'Remove from room',
        style: 'destructive',
        onPress: () => removeMember({ roomId, userId: uid } as any).catch(() => {}),
      });
      options.push({ text: 'Cancel', style: 'cancel' });
      Alert.alert(pick(m, 'name') || 'Member', undefined, options);
    },
    [roomId, setMemberRole, removeMember, isOwner],
  );

  const dangerAction = useCallback(() => {
    if (isOwner) {
      Alert.alert('Delete room?', 'This permanently deletes the room for everyone.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteRoom({ roomId } as any);
              router.replace('/study/rooms' as any);
            } catch {
              Alert.alert('Could not delete');
            }
          },
        },
      ]);
    } else {
      Alert.alert('Leave room?', 'You can rejoin later with the code.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            try {
              await leaveRoom({ roomId } as any);
              router.replace('/study/rooms' as any);
            } catch {
              Alert.alert('Could not leave');
            }
          },
        },
      ]);
    }
  }, [isOwner, deleteRoom, leaveRoom, roomId]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Feather name="arrow-left" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Room settings</Text>
        <View style={{ width: 24 }} />
      </View>

      {loading && !room ? (
        <View style={styles.center}><ActivityIndicator color={Colors.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}>
          <Text style={styles.sectionLabel}>DETAILS</Text>
          <TextInput style={styles.field} placeholder="Room name" placeholderTextColor={Colors.textMuted} value={name} onChangeText={setName} />
          <TextInput style={[styles.field, styles.fieldMulti]} placeholder="Description" placeholderTextColor={Colors.textMuted} value={description} onChangeText={setDescription} multiline />
          <TouchableOpacity style={[styles.saveBtn, savingMeta && styles.btnDisabled]} onPress={saveMeta} disabled={savingMeta}>
            {savingMeta ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save details</Text>}
          </TouchableOpacity>

          <Text style={styles.sectionLabel}>AI ACCESS</Text>
          <View style={styles.toggleCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleTitle}>Let Study AI use this room&apos;s shared material</Text>
              <Text style={styles.toggleSub}>Off by default. When on, group-quiz generation can build from the room&apos;s decks.</Text>
            </View>
            <Switch value={aiCanRead} onValueChange={toggleAi} trackColor={{ true: Colors.primary }} />
          </View>

          <Text style={styles.sectionLabel}>JOIN CODE</Text>
          <View style={styles.codeCard}>
            <Text style={styles.codeValue}>{String(pick(room, 'joinCode', 'code') || '——————')}</Text>
            <TouchableOpacity style={styles.regenBtn} onPress={regenerate}>
              <Feather name="refresh-cw" size={15} color={Colors.primaryDark} />
              <Text style={styles.regenText}>Regenerate</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.sectionLabel}>MEMBERS ({members.length})</Text>
          {members.map((m: any, i: number) => {
            const mrole = pick(m, 'role') || 'member';
            return (
              <TouchableOpacity
                key={pick(m, 'userId', '_id') || i}
                style={styles.memberRow}
                onPress={() => manageMember(m)}
                disabled={mrole === 'owner'}
              >
                <View style={styles.memberIcon}><Feather name="user" size={16} color={Colors.primary} /></View>
                <Text style={styles.memberName} numberOfLines={1}>{pick(m, 'name', 'displayName') || 'Member'}</Text>
                {mrole !== 'member' ? <Text style={styles.roleBadge}>{mrole}</Text> : null}
                {mrole !== 'owner' ? <Feather name="more-vertical" size={18} color={Colors.textMuted} /> : null}
              </TouchableOpacity>
            );
          })}

          <TouchableOpacity style={styles.dangerBtn} onPress={dangerAction}>
            <Feather name={isOwner ? 'trash-2' : 'log-out'} size={17} color={Colors.danger} />
            <Text style={styles.dangerText}>{isOwner ? 'Delete room' : 'Leave room'}</Text>
          </TouchableOpacity>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  headerTitle: { flex: 1, color: Colors.textPrimary, fontSize: 19, fontWeight: '800' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, gap: 10 },
  sectionLabel: { color: Colors.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, marginTop: 14, marginBottom: 2 },
  field: { backgroundColor: Colors.surface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: Colors.textPrimary, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border },
  fieldMulti: { minHeight: 60, textAlignVertical: 'top' },
  saveBtn: { alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 13, marginTop: 4 },
  saveText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  toggleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  toggleTitle: { color: Colors.textPrimary, fontSize: 14, fontWeight: '700' },
  toggleSub: { color: Colors.textSecondary, fontSize: 12, marginTop: 3, lineHeight: 17 },
  codeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surface,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  codeValue: { color: Colors.primaryDark, fontSize: 22, fontWeight: '900', letterSpacing: 4 },
  regenBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: Colors.primaryLight, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  regenText: { color: Colors.primaryDark, fontSize: 13, fontWeight: '700' },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  memberIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: Colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  memberName: { flex: 1, color: Colors.textPrimary, fontSize: 14, fontWeight: '600' },
  roleBadge: {
    color: Colors.primaryDark,
    fontSize: 11,
    fontWeight: '800',
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
    textTransform: 'capitalize',
  },
  dangerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 24,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.danger,
  },
  dangerText: { color: Colors.danger, fontSize: 15, fontWeight: '800' },
  btnDisabled: { opacity: 0.6 },
});
