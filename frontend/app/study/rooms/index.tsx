/**
 * Study Rooms — list my rooms, create a new one, or join by 6-char code.
 * Standalone (not tied to group chat). Join uses previewRoomByCode before
 * joinRoom so the user confirms which room they're entering.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Colors } from '../../../src/theme';
import { useMyRooms } from '../../../src/lib/study/useRooms';

function pick(o: any, ...keys: string[]) {
  for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
  return undefined;
}

export default function StudyRooms() {
  const insets = useSafeAreaInsets();
  const { rooms, loading, createRoom, joinRoom, previewRoomByCode } = useMyRooms();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Feather name="arrow-left" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Study Rooms</Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => setCreateOpen(true)}>
          <Feather name="plus-circle" size={18} color="#fff" />
          <Text style={styles.actionText}>Create room</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actionBtn, styles.actionBtnAlt]} onPress={() => setJoinOpen(true)}>
          <Feather name="log-in" size={18} color={Colors.primaryDark} />
          <Text style={[styles.actionText, styles.actionTextAlt]}>Join with code</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {loading && rooms.length === 0 ? (
          <ActivityIndicator color={Colors.primary} style={{ marginTop: 40 }} />
        ) : rooms.length === 0 ? (
          <View style={styles.empty}>
            <Feather name="users" size={30} color={Colors.textMuted} />
            <Text style={styles.emptyText}>
              No study rooms yet. Create one and share the code, or join a friend&apos;s room.
            </Text>
          </View>
        ) : (
          rooms.map((r: any) => {
            const role = pick(r, 'role', 'myRole');
            const activeToday =
              pick(r, 'membersStudiedToday', 'activeTodayCount', 'activeToday', 'studiedTodayCount');
            return (
              <TouchableOpacity
                key={String(r._id)}
                style={styles.roomRow}
                onPress={() => router.push({ pathname: '/study/rooms/[roomId]', params: { roomId: String(r._id) } } as any)}
                activeOpacity={0.7}
              >
                <View style={styles.roomIcon}>
                  <Feather name="users" size={20} color={Colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.roomName} numberOfLines={1}>{pick(r, 'name') || 'Study room'}</Text>
                  <Text style={styles.roomSub} numberOfLines={1}>
                    {`${pick(r, 'memberCount', 'membersCount') ?? (r.members?.length ?? 0)} members`}
                    {role && role !== 'member' ? ` · ${role}` : ''}
                  </Text>
                  {typeof activeToday === 'number' && activeToday > 0 ? (
                    <View style={styles.activityPill}>
                      <View style={styles.activityDot} />
                      <Text style={styles.activityText}>
                        {`${activeToday} ${activeToday === 1 ? 'member' : 'members'} studied today`}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Feather name="chevron-right" size={20} color={Colors.textMuted} />
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      <CreateRoomSheet visible={createOpen} onClose={() => setCreateOpen(false)} createRoom={createRoom} />
      <JoinRoomSheet
        visible={joinOpen}
        onClose={() => setJoinOpen(false)}
        joinRoom={joinRoom}
        previewRoomByCode={previewRoomByCode}
      />
    </View>
  );
}

function CreateRoomSheet({
  visible,
  onClose,
  createRoom,
}: {
  visible: boolean;
  onClose: () => void;
  createRoom: (a: any) => Promise<any>;
}) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (!name.trim()) {
      Alert.alert('Name your room', 'Give your study room a name.');
      return;
    }
    setBusy(true);
    try {
      const res: any = await createRoom({ name: name.trim(), description: description.trim() || undefined });
      onClose();
      setName('');
      setDescription('');
      const id = res?.roomId || res?._id;
      if (id) router.push({ pathname: '/study/rooms/[roomId]', params: { roomId: String(id) } } as any);
    } catch (err: any) {
      Alert.alert('Could not create room', err?.data?.message || err?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [name, description, createRoom, onClose]);

  return (
    <SheetShell visible={visible} onClose={busy ? () => {} : onClose} insets={insets} title="Create a study room">
      <TextInput
        style={styles.field}
        placeholder="Room name (e.g. Year 11 Biology)"
        placeholderTextColor={Colors.textMuted}
        value={name}
        onChangeText={setName}
      />
      <TextInput
        style={[styles.field, styles.fieldMulti]}
        placeholder="Description (optional)"
        placeholderTextColor={Colors.textMuted}
        value={description}
        onChangeText={setDescription}
        multiline
      />
      <TouchableOpacity style={[styles.primaryBtn, busy && styles.btnDisabled]} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Create</Text>}
      </TouchableOpacity>
    </SheetShell>
  );
}

function JoinRoomSheet({
  visible,
  onClose,
  joinRoom,
  previewRoomByCode,
}: {
  visible: boolean;
  onClose: () => void;
  joinRoom: (a: any) => Promise<any>;
  previewRoomByCode: (a: any) => Promise<any>;
}) {
  const insets = useSafeAreaInsets();
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

  const doPreview = useCallback(async () => {
    if (normalized.length < 6) {
      Alert.alert('Enter a 6-character code');
      return;
    }
    setBusy(true);
    try {
      const res: any = await previewRoomByCode({ code: normalized });
      if (!res) {
        Alert.alert('Room not found', 'Check the code and try again.');
        setPreview(null);
      } else {
        setPreview(res);
      }
    } catch (err: any) {
      Alert.alert('Could not find room', err?.data?.message || err?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [normalized, previewRoomByCode]);

  const doJoin = useCallback(async () => {
    setBusy(true);
    try {
      const res: any = await joinRoom({ code: normalized });
      onClose();
      setCode('');
      setPreview(null);
      const id = res?.roomId || res?._id;
      if (id) router.push({ pathname: '/study/rooms/[roomId]', params: { roomId: String(id) } } as any);
    } catch (err: any) {
      Alert.alert('Could not join', err?.data?.message || err?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [normalized, joinRoom, onClose]);

  return (
    <SheetShell visible={visible} onClose={busy ? () => {} : onClose} insets={insets} title="Join a study room">
      <TextInput
        style={[styles.field, styles.codeField]}
        placeholder="ABC123"
        placeholderTextColor={Colors.textMuted}
        value={normalized}
        onChangeText={(t) => {
          setCode(t);
          setPreview(null);
        }}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={6}
      />
      {preview ? (
        <View style={styles.previewCard}>
          <Feather name="users" size={18} color={Colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.roomName}>{pick(preview, 'name') || 'Study room'}</Text>
            <Text style={styles.roomSub}>{`${pick(preview, 'memberCount', 'membersCount') ?? 0} members`}</Text>
          </View>
        </View>
      ) : null}
      <TouchableOpacity
        style={[styles.primaryBtn, busy && styles.btnDisabled]}
        onPress={preview ? doJoin : doPreview}
        disabled={busy}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryBtnText}>{preview ? 'Join room' : 'Find room'}</Text>
        )}
      </TouchableOpacity>
    </SheetShell>
  );
}

function SheetShell({
  visible,
  onClose,
  insets,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  insets: { bottom: number };
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetWrap}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>{title}</Text>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  headerTitle: { flex: 1, color: Colors.textPrimary, fontSize: 20, fontWeight: '800' },
  actionRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, marginBottom: 8 },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 13,
  },
  actionBtnAlt: { backgroundColor: Colors.primaryLight },
  actionText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  actionTextAlt: { color: Colors.primaryDark },
  content: { padding: 16, gap: 10, paddingBottom: 40 },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 56, paddingHorizontal: 24 },
  emptyText: { color: Colors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  roomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  roomIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roomName: { color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
  roomSub: { color: Colors.textSecondary, fontSize: 12, marginTop: 2 },
  activityPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginTop: 6,
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  activityDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.success },
  activityText: { color: '#15803D', fontSize: 11, fontWeight: '700' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 12,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    marginBottom: 6,
  },
  sheetTitle: { color: Colors.textPrimary, fontSize: 17, fontWeight: '800' },
  field: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: Colors.textPrimary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  fieldMulti: { minHeight: 70, textAlignVertical: 'top' },
  codeField: {
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 6,
    textAlign: 'center',
  },
  previewCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 15,
    marginTop: 4,
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  btnDisabled: { opacity: 0.6 },
});
