import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { LANGUAGES, LanguageItem } from '../src/lib/languages';
import { readStoredJson, writeStoredJson } from '../src/lib/settingsStorage';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

const LOCAL_KEY = 'smilers_user_languages';

export default function LanguagesScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { data: me, refetch } = useSafeConvexQuery<any | null>(
    api.users.getCurrentUser,
    isAuthenticated ? {} : 'skip',
    null,
  );
  const updateProfile = useMutation(api.users.updateProfile);

  const [selected, setSelected] = useState<string[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Hydrate selected languages from server (preferred) or local fallback.
  useEffect(() => {
    if (initialized) return;
    let cancelled = false;
    (async () => {
      // 1. From server. Try multiple possible field names so we stay in sync
      //    with whatever the web app calls this collection.
      let initial: string[] | null = null;
      if (me) {
        if (Array.isArray(me.languages)) initial = me.languages;
        else if (Array.isArray(me.skipTranslationLanguages)) initial = me.skipTranslationLanguages;
        else if (Array.isArray(me.spokenLanguages)) initial = me.spokenLanguages;
      }
      // 2. Local fallback (e.g. backend hasn't deployed the field yet).
      if (!initial) {
        initial = (await readStoredJson(LOCAL_KEY, [])) as string[];
      }
      // Always include the user's primary preferredLanguage if it's set.
      if (me?.preferredLanguage && !initial.includes(me.preferredLanguage)) {
        initial = [me.preferredLanguage, ...initial];
      }
      if (!cancelled) {
        setSelected(Array.isArray(initial) ? initial : []);
        setInitialized(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialized, me]);

  const filtered = useMemo<LanguageItem[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return LANGUAGES;
    return LANGUAGES.filter(
      (l) =>
        l.name.toLowerCase().includes(q) ||
        l.nativeName.toLowerCase().includes(q) ||
        l.code.toLowerCase().includes(q),
    );
  }, [search]);

  const selectedLanguages = useMemo<LanguageItem[]>(() => {
    return selected
      .map((code) => LANGUAGES.find((l) => l.code === code))
      .filter((l): l is LanguageItem => Boolean(l));
  }, [selected]);

  const toggle = useCallback((code: string) => {
    setSelected((prev) => {
      const next = prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code];
      return next;
    });
    setDirty(true);
  }, []);

  const onSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    let serverOk = false;
    try {
      await updateProfile({ languages: selected });
      serverOk = true;
    } catch (errorValue: any) {
      // Backend may not have the field yet — write locally so the choice
      // isn't lost, and surface a clear message.
      console.warn('updateProfile(languages) failed:', errorValue?.message);
    }
    try {
      await writeStoredJson(LOCAL_KEY, selected);
    } catch {}
    if (serverOk) {
      try {
        await refetch();
      } catch {}
    }
    setDirty(false);
    setSaving(false);
    if (serverOk) {
      Alert.alert('Languages saved', 'Smilers will skip translation for these languages.');
    } else {
      Alert.alert(
        'Saved on this device',
        'Your language preferences were saved locally. We’ll sync them with the server once the backend update ships.',
      );
    }
  }, [refetch, saving, selected, updateProfile]);

  const onBack = useCallback(() => {
    if (!dirty) {
      router.back();
      return;
    }
    Alert.alert('Discard changes?', 'You have unsaved language changes.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => router.back() },
    ]);
  }, [dirty, router]);

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="languages-screen">
      <Header
        title="Languages"
        showBack
        onBack={onBack}
        variant="dark"
        right={
          <TouchableOpacity
            disabled={!dirty || saving}
            onPress={onSave}
            style={[styles.saveBtn, !dirty || saving ? styles.saveBtnDisabled : null]}
            testID="languages-save"
          >
            {saving ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <Text style={styles.saveBtnText}>Save</Text>
            )}
          </TouchableOpacity>
        }
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.intro}>
          <Text style={styles.introTitle}>Languages you understand</Text>
          <Text style={styles.introBody}>
            Messages in these languages will <Text style={styles.bold}>not</Text> be auto-translated. Everything else is
            translated into your primary language.
          </Text>
        </View>

        {selectedLanguages.length > 0 ? (
          <View style={styles.chipsWrap}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipsRow}
            >
              {selectedLanguages.map((l) => (
                <Pressable
                  key={l.code}
                  onPress={() => toggle(l.code)}
                  style={styles.chip}
                  testID={`language-chip-${l.code}`}
                >
                  <Text style={styles.chipFlag}>{l.flag}</Text>
                  <Text style={styles.chipText} numberOfLines={1}>
                    {l.name}
                  </Text>
                  <Ionicons name="close" size={14} color={Colors.primaryDark} />
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}

        <View style={styles.searchWrap}>
          <Ionicons name="search" size={18} color={Colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search languages"
            placeholderTextColor={Colors.textMuted}
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            testID="languages-search"
          />
          {search ? (
            <TouchableOpacity onPress={() => setSearch('')} hitSlop={10}>
              <Ionicons name="close-circle" size={18} color={Colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>

        <ScrollView
          contentContainerStyle={{ paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
          testID="languages-list"
        >
          {!initialized ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="small" color={Colors.primary} />
            </View>
          ) : filtered.length === 0 ? (
            <View style={styles.emptyWrap}>
              <Ionicons name="search-outline" size={36} color={Colors.textMuted} />
              <Text style={styles.emptyText}>No languages match “{search}”.</Text>
            </View>
          ) : (
            filtered.map((l, index) => {
              const checked = selected.includes(l.code);
              const isPrimary = me?.preferredLanguage === l.code;
              return (
                <TouchableOpacity
                  key={l.code}
                  style={[styles.row, index === 0 ? styles.rowFirst : null]}
                  activeOpacity={0.7}
                  onPress={() => toggle(l.code)}
                  testID={`language-row-${l.code}`}
                >
                  <Text style={styles.rowFlag}>{l.flag}</Text>
                  <View style={styles.rowMid}>
                    <View style={styles.rowTitleLine}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {l.name}
                      </Text>
                      {isPrimary ? (
                        <View style={styles.primaryBadge}>
                          <Text style={styles.primaryBadgeText}>Primary</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={styles.rowNative} numberOfLines={1}>
                      {l.nativeName}
                    </Text>
                  </View>
                  <View
                    style={[styles.checkbox, checked ? styles.checkboxOn : null]}
                    testID={`language-checkbox-${l.code}${checked ? '-on' : '-off'}`}
                  >
                    {checked ? <Ionicons name="checkmark" size={16} color={Colors.white} /> : null}
                  </View>
                </TouchableOpacity>
              );
            })
          )}

          <View style={styles.footer}>
            <Text style={styles.footerText}>
              {selectedLanguages.length} {selectedLanguages.length === 1 ? 'language' : 'languages'} selected
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  saveBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.md,
    minWidth: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnDisabled: {
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  saveBtnText: {
    color: Colors.headerBg,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.sm,
  },
  intro: {
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  introTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  introBody: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  bold: { fontWeight: FontWeight.bold, color: Colors.textPrimary },
  chipsWrap: {
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
    paddingVertical: Spacing.sm,
  },
  chipsRow: {
    paddingHorizontal: Spacing.base,
    gap: Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    maxWidth: 200,
  },
  chipFlag: { fontSize: 14 },
  chipText: {
    fontSize: FontSize.sm,
    color: Colors.primaryDark,
    fontWeight: FontWeight.semibold,
    maxWidth: 140,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },
  loadingWrap: { alignItems: 'center', paddingVertical: Spacing.xl },
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    gap: 8,
  },
  emptyText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  rowFirst: { borderTopWidth: 1, borderTopColor: Colors.borderLight },
  rowFlag: { fontSize: 26 },
  rowMid: { flex: 1 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  rowNative: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  primaryBadge: {
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.sm,
  },
  primaryBadgeText: {
    fontSize: 10,
    fontWeight: FontWeight.bold,
    color: Colors.primaryDark,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
  },
  checkboxOn: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  footer: {
    alignItems: 'center',
    paddingVertical: Spacing.lg,
  },
  footerText: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
});
