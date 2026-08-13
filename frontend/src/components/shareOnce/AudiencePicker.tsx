/**
 * AudiencePicker — choose who can view a Share Once post.
 * Modes: all / trustees / voiceTask / allExcept / specific, plus optional groups.
 * Returns the exact shape api.shareOnce.createPost / repostToShareOnce expect.
 */
import React, { useMemo, useState } from 'react';
import { FlatList, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from 'convex/react';
import { api } from '../../convexApi';
import { Colors } from '../../theme';

export type AudienceSelection = {
  audienceMode: 'all' | 'trustees' | 'voiceTask' | 'allExcept' | 'specific';
  audienceUserIds?: string[];
  audienceExceptIds?: string[];
  audienceGroupIds?: string[];
};

const MODES: { key: AudienceSelection['audienceMode']; label: string; hint: string }[] = [
  { key: 'all', label: 'Everyone', hint: 'All my connections' },
  { key: 'trustees', label: 'Only Trustees', hint: 'My trustees only' },
  { key: 'voiceTask', label: 'Only Voice-task users', hint: 'My voice-task users' },
  { key: 'specific', label: 'Only selected', hint: 'Tick who can view' },
  { key: 'allExcept', label: 'Everyone except', hint: 'Untick who cannot view' },
];

export default function AudiencePicker({
  visible,
  onClose,
  onConfirm,
  confirmLabel = 'Confirm',
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: (sel: AudienceSelection) => void;
  confirmLabel?: string;
}) {
  const opts = useQuery(api.shareOnce.getAudienceOptions, visible ? {} : 'skip') as
    | { connections: { userId: string; name: string; avatar?: string }[]; trusteeIds: string[]; voiceTaskIds: string[]; groups: { groupId: string; name: string; memberCount: number }[] }
    | undefined;

  const [mode, setMode] = useState<AudienceSelection['audienceMode']>('all');
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [groups, setGroups] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');

  const connections = opts?.connections || [];
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? connections.filter((c) => c.name.toLowerCase().includes(s)) : connections;
  }, [connections, q]);

  const needsList = mode === 'specific' || mode === 'allExcept';

  const confirm = () => {
    const ids = Object.keys(ticked).filter((k) => ticked[k]);
    const groupIds = Object.keys(groups).filter((k) => groups[k]);
    const sel: AudienceSelection = { audienceMode: mode, audienceGroupIds: groupIds };
    if (mode === 'specific') sel.audienceUserIds = ids;
    if (mode === 'allExcept') sel.audienceExceptIds = ids;
    onConfirm(sel);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={8}>
            <Ionicons name="close" size={26} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>Who can view</Text>
          <TouchableOpacity onPress={confirm} testID="audience-confirm">
            <Text style={styles.confirm}>{confirmLabel}</Text>
          </TouchableOpacity>
        </View>

        <FlatList
          data={needsList ? filtered : []}
          keyExtractor={(i) => i.userId}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <View>
              {MODES.map((m) => (
                <TouchableOpacity key={m.key} style={styles.modeRow} onPress={() => setMode(m.key)} testID={`audience-mode-${m.key}`}>
                  <Ionicons
                    name={mode === m.key ? 'radio-button-on' : 'radio-button-off'}
                    size={22}
                    color={mode === m.key ? Colors.primary : Colors.textSecondary}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.modeLabel}>{m.label}</Text>
                    <Text style={styles.modeHint}>{m.hint}</Text>
                  </View>
                </TouchableOpacity>
              ))}

              {opts?.groups?.length ? (
                <>
                  <Text style={styles.sectionLbl}>GROUPS (added to any mode)</Text>
                  {(() => {
                    const allIds = opts.groups.map((g) => g.groupId);
                    const allSelected = allIds.every((id) => groups[id]);
                    return (
                      <TouchableOpacity
                        style={styles.row}
                        onPress={() =>
                          setGroups(() => {
                            if (allSelected) return {};
                            const next: Record<string, boolean> = {};
                            allIds.forEach((id) => {
                              next[id] = true;
                            });
                            return next;
                          })
                        }
                        testID="audience-select-all-groups"
                      >
                        <Ionicons name={allSelected ? 'checkbox' : 'square-outline'} size={22} color={allSelected ? Colors.primary : Colors.textSecondary} />
                        <Text style={[styles.name, { fontWeight: '700' }]} numberOfLines={1}>Select all groups</Text>
                      </TouchableOpacity>
                    );
                  })()}
                  {opts.groups.map((g) => (
                    <TouchableOpacity key={g.groupId} style={styles.row} onPress={() => setGroups((p) => ({ ...p, [g.groupId]: !p[g.groupId] }))}>
                      <Ionicons name={groups[g.groupId] ? 'checkbox' : 'square-outline'} size={22} color={groups[g.groupId] ? Colors.primary : Colors.textSecondary} />
                      <Text style={styles.name} numberOfLines={1}>{g.name} · {g.memberCount}</Text>
                    </TouchableOpacity>
                  ))}
                </>
              ) : null}

              {needsList ? (
                <>
                  <Text style={styles.sectionLbl}>{mode === 'specific' ? 'TICK WHO CAN VIEW' : 'UNTICK WHO CANNOT VIEW'}</Text>
                  <View style={styles.searchWrap}>
                    <Ionicons name="search" size={18} color={Colors.textSecondary} />
                    <TextInput style={styles.search} placeholder="Search contacts" placeholderTextColor={Colors.textMuted} value={q} onChangeText={setQ} />
                  </View>
                </>
              ) : null}
            </View>
          }
          renderItem={({ item }) => {
            const isTrustee = opts?.trusteeIds?.includes(item.userId);
            const isVoice = opts?.voiceTaskIds?.includes(item.userId);
            return (
              <TouchableOpacity style={styles.row} onPress={() => setTicked((p) => ({ ...p, [item.userId]: !p[item.userId] }))} testID={`audience-user-${item.userId}`}>
                <Ionicons name={ticked[item.userId] ? 'checkbox' : 'square-outline'} size={22} color={ticked[item.userId] ? Colors.primary : Colors.textSecondary} />
                <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                {isTrustee ? <Text style={styles.tag}>Trustee</Text> : null}
                {isVoice ? <Text style={styles.tag}>Voice</Text> : null}
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={needsList && !opts ? <Text style={styles.loading}>Loading…</Text> : null}
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border || '#e5e7eb' },
  title: { fontSize: 17, fontWeight: '800', color: Colors.textPrimary },
  confirm: { fontSize: 16, fontWeight: '800', color: Colors.primary },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  modeLabel: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  modeHint: { fontSize: 12, color: Colors.textSecondary },
  sectionLbl: { fontSize: 11, fontWeight: '800', color: Colors.textSecondary, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, height: 42, borderRadius: 10, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border || '#e5e7eb' },
  search: { flex: 1, fontSize: 15, color: Colors.textPrimary },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 11 },
  name: { flex: 1, fontSize: 15, color: Colors.textPrimary },
  tag: { fontSize: 10, fontWeight: '800', color: Colors.primary, backgroundColor: 'rgba(0,0,0,0.05)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  loading: { textAlign: 'center', color: Colors.textSecondary, padding: 20 },
});
