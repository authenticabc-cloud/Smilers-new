import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  TextInput,
  Switch,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { api } from '../convexApi';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

const PRESET_TITLES = [
  'President',
  'Vice President',
  'Chairman',
  'Secretary',
  'Treasurer',
  'Organizer',
];

/**
 * SubGroupPositionModal — assign / update / clear a member's position title in a
 * sub group. Any sub-group admin can set a title; only the Chief Admin can flip
 * "Show in mother group". Backend: subGroups.setPosition / setPositionVisibility.
 */
export function SubGroupPositionModal({
  visible,
  subGroupId,
  backend = 'subGroups',
  allowVisibility = true,
  userId,
  memberName,
  currentTitle,
  currentShowInMother,
  isChief,
  onClose,
}: {
  visible: boolean;
  subGroupId: string;
  /** 'subGroups' (default, uses subGroupId) or 'groupPositions' (top-level group,
   *  uses conversationId). Both take { userId, title }. */
  backend?: 'subGroups' | 'groupPositions';
  /** Top-level groups have no "show in mother" concept → hide that toggle. */
  allowVisibility?: boolean;
  userId: string | null;
  memberName: string;
  currentTitle: string;
  currentShowInMother: boolean;
  isChief: boolean;
  onClose: () => void;
}) {
  const positionApi = backend === 'groupPositions' ? (api as any).groupPositions : (api as any).subGroups;
  const setPositionM = useMutation(positionApi?.setPosition);
  const idArg = backend === 'groupPositions' ? { conversationId: subGroupId } : { subGroupId };
  const canShowVisibility = allowVisibility && backend === 'subGroups';

  const [title, setTitle] = useState(currentTitle);
  const [showInMother, setShowInMother] = useState(currentShowInMother);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) {
      setTitle(currentTitle);
      setShowInMother(currentShowInMother);
    }
  }, [visible, currentTitle, currentShowInMother]);

  const save = useCallback(async () => {
    if (!userId || !setPositionM) return;
    setBusy(true);
    try {
      await setPositionM({
        ...idArg,
        userId,
        title: title.trim(),
        ...(canShowVisibility && isChief ? { showInMother } : {}),
      });
      onClose();
    } catch (e: any) {
      Alert.alert('Could not save', e?.data?.message || e?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [userId, setPositionM, idArg, title, canShowVisibility, isChief, showInMother, onClose]);

  const clear = useCallback(async () => {
    if (!userId || !setPositionM) return;
    setBusy(true);
    try {
      await setPositionM({ ...idArg, userId, title: '' });
      onClose();
    } catch (e: any) {
      Alert.alert('Could not clear', e?.data?.message || e?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [userId, setPositionM, idArg, onClose]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
              Position · {memberName}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} testID="sub-group-position-close">
              <Ionicons name="close" size={24} color={Colors.textPrimary} />
            </TouchableOpacity>
          </View>

          <View style={styles.chipsWrap}>
            {PRESET_TITLES.map((t) => {
              const on = title.trim().toLowerCase() === t.toLowerCase();
              return (
                <TouchableOpacity
                  key={t}
                  style={[styles.chip, on && styles.chipOn]}
                  onPress={() => setTitle(t)}
                  testID={`position-chip-${t}`}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{t}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TextInput
            style={styles.input}
            placeholder="Custom title (e.g. Coordinator)"
            placeholderTextColor={Colors.textSecondary}
            value={title}
            onChangeText={setTitle}
            maxLength={40}
            testID="position-title-input"
          />

          {canShowVisibility && isChief ? (
            <View style={styles.switchRow}>
              <View style={styles.switchTextWrap}>
                <Text style={styles.switchLabel}>Show in mother group</Text>
                <Text style={styles.switchHint}>Let this title appear next to the name in the main group.</Text>
              </View>
              <Switch
                value={showInMother}
                onValueChange={setShowInMother}
                trackColor={{ true: Colors.primary }}
                testID="position-show-in-mother"
              />
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.primaryBtn, busy && styles.btnDisabled]}
            onPress={save}
            disabled={busy}
            testID="position-save"
          >
            {busy ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.primaryBtnText}>Save position</Text>}
          </TouchableOpacity>
          {currentTitle ? (
            <TouchableOpacity style={styles.clearBtn} onPress={clear} disabled={busy} testID="position-clear">
              <Text style={styles.clearBtnText}>Clear position</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  card: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { flex: 1, fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border || '#E5E7EB',
  },
  chipOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.medium },
  chipTextOn: { color: Colors.white },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: Colors.border || '#E5E7EB',
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  switchTextWrap: { flex: 1 },
  switchLabel: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  switchHint: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  primaryBtn: { backgroundColor: Colors.primary, paddingVertical: 14, borderRadius: Radius.pill, alignItems: 'center' },
  primaryBtnText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  btnDisabled: { opacity: 0.6 },
  clearBtn: { paddingVertical: 10, alignItems: 'center' },
  clearBtnText: { color: Colors.danger, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
});
