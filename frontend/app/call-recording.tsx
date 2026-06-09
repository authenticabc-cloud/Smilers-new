/**
 * Call Recording settings — auto-record policy & exceptions.
 *
 * Backed by canonical Convex contract (confirmed iter 155):
 *   - api.callRecording.getMySettings({})
 *     → { mode: 'always'|'never'|'exceptions',
 *         exceptionBehavior: 'record_except'|'record_only',
 *         exceptionContactIds: Id<'users'>[] }
 *   - api.callRecording.updateSettings({ mode, exceptionBehavior?, exceptionContactIds? })
 *
 * Modes (user-facing labels):
 *   1. Always record   → backend `mode: 'always'`
 *   2. Never record    → backend `mode: 'never'`
 *   3. Record with exceptions  → backend `mode: 'exceptions'` + behavior:
 *        - 'record_except' (default)  = record everyone EXCEPT ticked contacts
 *        - 'record_only'              = record ONLY ticked contacts (whitelist)
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';

import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import { getDisplayInitials } from '../src/lib/displayName';
import Header from '../src/components/Header';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

type Mode = 'always' | 'never' | 'exceptions';
type ExceptionBehavior = 'record_except' | 'record_only';

interface Settings {
  mode: Mode;
  exceptionBehavior: ExceptionBehavior;
  exceptionContactIds: string[];
}

const DEFAULT_SETTINGS: Settings = {
  mode: 'never',
  exceptionBehavior: 'record_except',
  exceptionContactIds: [],
};

export default function CallRecordingSettingsScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();

  const remoteSettings = useQuery(
    (api as any).callRecording.getMySettings,
    isAuthenticated ? {} : 'skip',
  ) as any;
  const contacts = useQuery(
    (api as any).contacts.getContacts,
    isAuthenticated ? {} : 'skip',
  ) as any[] | undefined;
  const updateSettings = useMutation((api as any).callRecording.updateSettings);

  const [local, setLocal] = useState<Settings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!remoteSettings) return;
    setLocal({
      mode: (remoteSettings.mode as Mode) || 'never',
      exceptionBehavior:
        (remoteSettings.exceptionBehavior as ExceptionBehavior) || 'record_except',
      exceptionContactIds: Array.isArray(remoteSettings.exceptionContactIds)
        ? remoteSettings.exceptionContactIds.map((id: any) => String(id))
        : [],
    });
  }, [remoteSettings]);

  const exceptionIdSet = useMemo(
    () => new Set(local.exceptionContactIds),
    [local.exceptionContactIds],
  );

  const save = useCallback(
    async (next: Settings) => {
      if (!isAuthenticated) return;
      setSaving(true);
      try {
        const payload: any = { mode: next.mode };
        if (next.mode === 'exceptions') {
          payload.exceptionBehavior = next.exceptionBehavior;
          payload.exceptionContactIds = next.exceptionContactIds;
        }
        await updateSettings(payload);
      } catch (e: any) {
        Alert.alert(
          'Could not save',
          String(e?.message || 'Something went wrong. Please try again.'),
        );
      } finally {
        setSaving(false);
      }
    },
    [isAuthenticated, updateSettings],
  );

  const handleSelectMode = useCallback(
    (nextMode: Mode) => {
      const next: Settings = { ...local, mode: nextMode };
      setLocal(next);
      void save(next);
    },
    [local, save],
  );

  const handleToggleBehavior = useCallback(() => {
    const next: Settings = {
      ...local,
      exceptionBehavior:
        local.exceptionBehavior === 'record_except' ? 'record_only' : 'record_except',
    };
    setLocal(next);
    void save(next);
  }, [local, save]);

  const handleToggleContact = useCallback(
    (contactId: string) => {
      const has = exceptionIdSet.has(contactId);
      const nextIds = has
        ? local.exceptionContactIds.filter((id) => id !== contactId)
        : [...local.exceptionContactIds, contactId];
      const next: Settings = { ...local, exceptionContactIds: nextIds };
      setLocal(next);
      void save(next);
    },
    [exceptionIdSet, local, save],
  );

  if (!isAuthenticated) {
    return (
      <SafeAreaView style={styles.container} edges={['top']} testID="call-recording-settings">
        <Header title="Call Recording" showBack onBack={() => router.back()} variant="dark" />
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>Sign in required</Text>
          <Text style={styles.emptyBody}>Sign in to manage call recording.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const showExceptionsList = local.mode === 'exceptions';
  const behaviorLabel =
    local.exceptionBehavior === 'record_only'
      ? 'Record ONLY ticked contacts'
      : 'Record EVERYONE except ticked contacts';

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="call-recording-settings">
      <Header title="Call Recording" showBack onBack={() => router.back()} variant="dark" />
      <FlatList
        data={showExceptionsList ? contacts || [] : []}
        keyExtractor={(c) => String(c._id || c.userId)}
        contentContainerStyle={{ paddingBottom: 40 }}
        ListHeaderComponent={
          <View>
            <View style={styles.banner} testID="call-recording-banner">
              <MaterialCommunityIcons name="record-rec" size={20} color={Colors.danger} />
              <Text style={styles.bannerText}>
                When you record a call, both parties will see a recording indicator.
              </Text>
            </View>

            <Text style={styles.sectionTitle}>CALL RECORDING MODE</Text>
            <ModeRow
              icon="record-rec"
              title="Always record"
              subtitle="Every voice & video call is recorded automatically."
              selected={local.mode === 'always'}
              onPress={() => handleSelectMode('always')}
              testID="mode-always"
            />
            <ModeRow
              icon="close-circle-outline"
              title="Never record"
              subtitle="Nothing is recorded."
              selected={local.mode === 'never'}
              onPress={() => handleSelectMode('never')}
              testID="mode-never"
            />
            <ModeRow
              icon="account-multiple-check-outline"
              title="Record with exceptions"
              subtitle="Choose contacts to include or exclude."
              selected={local.mode === 'exceptions'}
              onPress={() => handleSelectMode('exceptions')}
              testID="mode-exceptions"
              isLast
            />

            {showExceptionsList ? (
              <View>
                <Text style={styles.sectionTitle}>EXCEPTION BEHAVIOR</Text>
                <TouchableOpacity
                  style={styles.behaviorRow}
                  activeOpacity={0.7}
                  onPress={handleToggleBehavior}
                  testID="behavior-toggle"
                >
                  <View style={styles.behaviorIcon}>
                    <MaterialCommunityIcons
                      name={
                        local.exceptionBehavior === 'record_only'
                          ? 'filter-check-outline'
                          : 'filter-remove-outline'
                      }
                      size={20}
                      color={Colors.primary}
                    />
                  </View>
                  <Text style={styles.behaviorText}>{behaviorLabel}</Text>
                  <Feather name="refresh-cw" size={18} color={Colors.textMuted} />
                </TouchableOpacity>

                <Text style={styles.sectionTitle}>
                  CONTACTS ({local.exceptionContactIds.length} selected)
                </Text>
                {contacts === undefined ? (
                  <View style={styles.loadingWrap}>
                    <ActivityIndicator size="small" color={Colors.primary} />
                  </View>
                ) : (contacts || []).length === 0 ? (
                  <Text style={styles.emptyContactsText}>
                    No contacts yet. Add contacts first to set exceptions.
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          const cid = String(item._id || item.userId);
          const ticked = exceptionIdSet.has(cid);
          const name = item.name || item.displayName || 'Contact';
          return (
            <TouchableOpacity
              style={styles.contactRow}
              activeOpacity={0.7}
              onPress={() => handleToggleContact(cid)}
              testID={`contact-${cid}`}
            >
              <View style={styles.contactAvatar}>
                <Text style={styles.contactAvatarText}>{getDisplayInitials(name, 1)}</Text>
              </View>
              <Text style={styles.contactName} numberOfLines={1}>
                {name}
              </Text>
              <View style={[styles.checkbox, ticked ? styles.checkboxOn : null]}>
                {ticked ? <Feather name="check" size={16} color={Colors.white} /> : null}
              </View>
            </TouchableOpacity>
          );
        }}
        ListFooterComponent={
          saving ? (
            <View style={styles.savingRow}>
              <ActivityIndicator size="small" color={Colors.primary} />
              <Text style={styles.savingText}>Saving{'\u2026'}</Text>
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

function ModeRow({
  icon,
  title,
  subtitle,
  selected,
  onPress,
  isLast,
  testID,
}: {
  icon: string;
  title: string;
  subtitle: string;
  selected: boolean;
  onPress: () => void;
  isLast?: boolean;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.modeRow, isLast ? styles.modeRowLast : null]}
      activeOpacity={0.7}
      onPress={onPress}
      testID={testID}
    >
      <View style={[styles.modeIcon, selected ? styles.modeIconSelected : null]}>
        <MaterialCommunityIcons
          name={icon as any}
          size={22}
          color={selected ? Colors.white : Colors.primary}
        />
      </View>
      <View style={styles.modeText}>
        <Text style={styles.modeTitle}>{title}</Text>
        <Text style={styles.modeSubtitle}>{subtitle}</Text>
      </View>
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={22}
        color={selected ? Colors.primary : Colors.textMuted}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  banner: {
    margin: Spacing.base,
    padding: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: '#FEF3C7',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: '#F59E0B33',
  },
  bannerText: { flex: 1, fontSize: FontSize.sm, color: '#7C2D12', lineHeight: 18 },

  sectionTitle: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.xs,
    fontSize: 12,
    fontWeight: FontWeight.bold,
    letterSpacing: 1.2,
    color: Colors.textSecondary,
  },

  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(60,40,0,0.10)',
    minHeight: 64,
  },
  modeRowLast: { borderBottomWidth: 0 },
  modeIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeIconSelected: { backgroundColor: Colors.primary },
  modeText: { flex: 1 },
  modeTitle: { fontSize: 17, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  modeSubtitle: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },

  behaviorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    minHeight: 56,
  },
  behaviorIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  behaviorText: { flex: 1, fontSize: 15, color: Colors.textPrimary, fontWeight: FontWeight.semibold },

  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    minHeight: 56,
  },
  contactAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#FEF3C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactAvatarText: { color: '#92400E', fontWeight: FontWeight.bold, fontSize: 16 },
  contactName: { flex: 1, fontSize: 16, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: Colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  emptyContactsText: {
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontStyle: 'italic',
  },

  loadingWrap: { padding: Spacing.lg, alignItems: 'center' },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  emptyBody: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', paddingHorizontal: Spacing.lg },

  savingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: Spacing.md },
  savingText: { fontSize: FontSize.sm, color: Colors.textSecondary },
});
