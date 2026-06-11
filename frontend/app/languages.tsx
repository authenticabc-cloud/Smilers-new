import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
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
import { getLanguageByCode, LANGUAGES, LanguageItem, UN_OFFICIAL_LANGUAGE_CODES } from '../src/lib/languages';
import { readStoredJson, writeStoredJson } from '../src/lib/settingsStorage';
import { safeMutation } from '../src/lib/safeMutation';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../src/theme';

const LOCAL_KEY = 'smilers_user_languages';

function LegacyLanguagesScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { data: me, refetch } = useSafeConvexQuery<any | null>(
    api.users.getCurrentUser,
    {},
    null,
    isAuthenticated,
  );
  const updateProfile = useMutation(api.users.updateProfile);
  // iter-149: try alternative canonical mutation names — the user's
  // server may expose languages on a dedicated mutation rather than as
  // a field of `updateProfile`. We attempt each in turn during save.
  const updateLanguagesM = useMutation((api as any).users?.updateLanguages);
  const setLanguagesM = useMutation((api as any).users?.setLanguages);
  const updateUserLanguagesM = useMutation((api as any).languages?.update);

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

  const groupedFiltered = useMemo(() => {
    if (search.trim()) {
      return [{ title: 'SEARCH RESULTS', items: filtered }];
    }

    const unOfficial = filtered.filter((item) => UN_OFFICIAL_LANGUAGE_CODES.includes(item.code as any));
    const otherLanguages = filtered.filter((item) => !UN_OFFICIAL_LANGUAGE_CODES.includes(item.code as any));

    return [
      { title: 'UN OFFICIAL LANGUAGES', items: unOfficial },
      { title: 'OTHER LANGUAGES', items: otherLanguages },
    ].filter((section) => section.items.length > 0);
  }, [filtered, search]);

  const defaultLanguage = getLanguageByCode(me?.preferredLanguage || '') || getLanguageByCode('en');

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
    let lastError: any = null;

    // iter-149: server contract for "skip translation languages" varies
    // by deployment. Try the canonical mutation + field-name candidates
    // in order until one succeeds. This mirrors what the web app does
    // when negotiating against an older/newer backend.
    const candidates: Array<{
      label: string;
      run?: (args: any) => Promise<any>;
      payload: any;
    }> = [
      {
        label: 'users.updateLanguages',
        run: updateLanguagesM as any,
        payload: { languages: selected },
      },
      {
        label: 'users.setLanguages',
        run: setLanguagesM as any,
        payload: { languages: selected },
      },
      {
        label: 'languages.update',
        run: updateUserLanguagesM as any,
        payload: { languages: selected },
      },
      {
        label: 'users.updateProfile(languages)',
        run: updateProfile as any,
        payload: { languages: selected },
      },
      {
        label: 'users.updateProfile(skipTranslationLanguages)',
        run: updateProfile as any,
        payload: { skipTranslationLanguages: selected },
      },
      {
        label: 'users.updateProfile(spokenLanguages)',
        run: updateProfile as any,
        payload: { spokenLanguages: selected },
      },
    ];

    for (const candidate of candidates) {
      if (typeof candidate.run !== 'function') continue;
      try {
        // iter-182: hard 10s timeout per candidate. If the Convex client's
        // auth handshake glitches, a mutation can be queued FOREVER without
        // resolving or rejecting — which left the Save spinner turning "till
        // eternity". On timeout we stop trying, keep the local copy, and
        // release the UI.
        await Promise.race([
          safeMutation(candidate.label, () => candidate.run!(candidate.payload), candidate.payload),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timed out — please check your connection.')), 10_000),
          ),
        ]);
        serverOk = true;
        break;
      } catch (errorValue: any) {
        lastError = errorValue;
        const message = String(errorValue?.message || '');
        if (message.includes('timed out')) {
          // Network/auth stall — no point trying more candidates.
          break;
        }
        // If the function literally doesn't exist on the server OR if
        // the field is rejected by the validator, fall through to the
        // next candidate. Anything else (auth, network) ➝ stop.
        const isMissing =
          message.includes('CouldNotFindFunction') ||
          message.includes('not found') ||
          message.includes('ArgumentValidationError') ||
          message.includes('ValidatorError') ||
          message.includes('Object contains extra field') ||
          message.includes('Object is missing the required field');
        if (!isMissing) {
          // Real server error — abort but still write locally.
          break;
        }
      }
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
      // Surface the actual server error so we can iterate, while still
      // keeping the local copy so the user's choice isn't lost.
      const detail =
        (lastError?.message && String(lastError.message).slice(0, 200)) ||
        'Server did not accept the request.';
      Alert.alert(
        'Could not save to server',
        `${detail}\n\nYour selection is kept locally and will retry next time you save.`,
      );
    }
  }, [refetch, saving, selected, setLanguagesM, updateLanguagesM, updateProfile, updateUserLanguagesM]);

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
          <Text style={styles.introBodyCentered}>
            Your <Text style={styles.bold}>default language</Text> is your primary language.
          </Text>
          <Text style={styles.introBodyCentered}>
            Messages in your <Text style={styles.bold}>selected languages</Text> will not be translated. Tap a language to select it.
          </Text>
        </View>

        <View style={styles.defaultRow} testID="languages-default-row">
          <Ionicons name="star" size={18} color={Colors.primary} />
          <Text style={styles.defaultLabel}>Default:</Text>
          <Text style={styles.defaultValue}>{defaultLanguage?.name || 'English'}</Text>
        </View>

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
            groupedFiltered.map((section) => (
              <View key={section.title}>
                <Text style={styles.sectionHeading}>{section.title}</Text>
                {section.items.map((l) => {
                  const checked = selected.includes(l.code);
                  const isPrimary = me?.preferredLanguage === l.code;
                  return (
                    <TouchableOpacity
                      key={l.code}
                      style={styles.row}
                      activeOpacity={0.7}
                      onPress={() => toggle(l.code)}
                      testID={`language-row-${l.code}`}
                    >
                      <View
                        style={[styles.checkbox, checked ? styles.checkboxOn : null]}
                        testID={`language-checkbox-${l.code}${checked ? '-on' : '-off'}`}
                      >
                        {checked ? <Ionicons name="checkmark" size={16} color={Colors.white} /> : null}
                      </View>
                      <View style={styles.rowMid}>
                        <View style={styles.rowTitleLine}>
                          <Text style={[styles.rowName, isPrimary ? styles.rowNamePrimary : null]} numberOfLines={1}>
                            {l.name}
                          </Text>
                          {isPrimary ? (
                            <View style={styles.primaryBadge}>
                              <Text style={styles.primaryBadgeText}>DEFAULT</Text>
                            </View>
                          ) : null}
                        </View>
                        <Text style={styles.rowNative} numberOfLines={1}>
                          {l.nativeName}
                        </Text>
                      </View>
                      {checked ? <Ionicons name="checkmark" size={22} color={Colors.primary} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))
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
    gap: 6,
  },
  introBodyCentered: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
    textAlign: 'center',
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
  defaultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.base,
    marginBottom: 4,
    paddingHorizontal: Spacing.base,
    paddingVertical: 10,
    borderRadius: Radius.md,
  },
  defaultLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  defaultValue: {
    fontSize: FontSize.sm,
    color: Colors.textPrimary,
    fontWeight: FontWeight.bold,
  },
  sectionHeading: {
    fontSize: 12,
    fontWeight: FontWeight.bold,
    color: Colors.textMuted,
    letterSpacing: 0.8,
    marginTop: 14,
    marginBottom: 6,
    marginHorizontal: Spacing.base,
    textTransform: 'uppercase',
  },
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
  rowNamePrimary: {
    color: Colors.primaryDark,
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

const PREFERRED_LANGUAGE_KEY = 'smilers_preferred_language';

export function MessageLanguageScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { data: me, refetch } = useSafeConvexQuery<any | null>(api.users.getCurrentUser, {}, null, isAuthenticated);
  const updateProfile = useMutation(api.users.updateProfile);

  const [initialized, setInitialized] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedCode, setSelectedCode] = useState('en');
  const [savingCode, setSavingCode] = useState<string | null>(null);

  useEffect(() => {
    if (initialized) return;
    let active = true;
    const load = async () => {
      const local = (await readStoredJson(PREFERRED_LANGUAGE_KEY, 'en')) as string;
      const preferred = me?.preferredLanguage || local || 'en';
      const selected = getLanguageByCode(preferred) || getLanguageByCode('en');
      if (!active || !selected) return;
      setSelectedCode(selected.code);
      setQuery('');
      setInitialized(true);
    };
    void load();
    return () => {
      active = false;
    };
  }, [initialized, me?.preferredLanguage]);

  const selectedLanguage = useMemo(() => getLanguageByCode(selectedCode) || LANGUAGES[0], [selectedCode]);

  const filteredLanguages = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return LANGUAGES;
    return LANGUAGES.filter((item) => {
      const haystack = `${item.name} ${item.nativeName} ${item.code}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [query]);

  const clearSearch = useCallback(() => {
    setQuery('');
  }, []);

  const saveLanguage = useCallback(
    async (item: LanguageItem) => {
      if (savingCode) return;
      setSavingCode(item.code);
      setSelectedCode(item.code);
      setQuery('');

      let savedToServer = false;
      try {
        const payload = { preferredLanguage: item.code };
        // iter-182: same 10s timeout guard as onSave — a queued Convex
        // mutation can hang forever and freeze the saving state.
        await Promise.race([
          safeMutation(
            'users.updateProfile(preferredLanguage)',
            () => updateProfile(payload),
            payload,
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timed out')), 10_000),
          ),
        ]);
        savedToServer = true;
      } catch (errorValue: any) {
        console.warn('updateProfile(preferredLanguage) failed:', errorValue?.message);
      }

      try {
        await writeStoredJson(PREFERRED_LANGUAGE_KEY, item.code);
      } catch {}

      if (savedToServer) {
        try {
          await refetch();
        } catch {}
      }

      setSavingCode(null);
      Alert.alert(
        'Message language updated',
        `All messages you receive will be auto-translated into ${item.name}.`,
        [{ text: 'OK', onPress: () => router.back() }],
      );
    },
    [refetch, router, savingCode, updateProfile],
  );

  return (
    <SafeAreaView style={screenshotStyles.container} edges={['top']} testID="languages-screen">
      <StatusBar barStyle="dark-content" backgroundColor="#DAA514" />

      <View style={screenshotStyles.topBar} testID="languages-top-bar">
        <TouchableOpacity onPress={() => router.back()} style={screenshotStyles.backButton} testID="languages-back-button">
          <Ionicons name="arrow-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView style={screenshotStyles.flexOne} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={screenshotStyles.content} keyboardShouldPersistTaps="handled" testID="languages-scroll-view">
          <View style={screenshotStyles.sectionHeader} testID="languages-section-header">
            <Ionicons name="globe-outline" size={30} color={Colors.primary} />
            <View style={screenshotStyles.sectionTextWrap}>
              <Text style={screenshotStyles.sectionLabel} testID="languages-section-label">MESSAGE LANGUAGE</Text>
              <Text style={screenshotStyles.sectionHelp} testID="languages-section-help">
                All messages you receive will be auto-translated into this language.
              </Text>
            </View>
          </View>

          <View style={screenshotStyles.searchRow} testID="languages-search-row">
            <View style={screenshotStyles.searchShell}>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search language"
                placeholderTextColor="#9D9385"
                autoCapitalize="words"
                autoCorrect={false}
                style={screenshotStyles.searchInput}
                testID="languages-search-input"
              />
            </View>

            <TouchableOpacity onPress={clearSearch} style={screenshotStyles.clearButton} testID="languages-clear-button">
              {savingCode ? (
                <ActivityIndicator size="small" color={Colors.textPrimary} />
              ) : (
                <Ionicons name="close" size={24} color={Colors.textPrimary} />
              )}
            </TouchableOpacity>
          </View>

          <View style={screenshotStyles.resultsCard} testID="languages-results-card">
            {!initialized ? (
              <View style={screenshotStyles.feedbackState} testID="languages-loading-state">
                <ActivityIndicator size="small" color={Colors.primary} />
                <Text style={screenshotStyles.feedbackText}>Loading languages…</Text>
              </View>
            ) : filteredLanguages.length === 0 ? (
              <View style={screenshotStyles.feedbackState} testID="languages-empty-state">
                <Ionicons name="search-outline" size={26} color={Colors.textMuted} />
                <Text style={screenshotStyles.feedbackText}>No languages match “{query}”.</Text>
              </View>
            ) : (
              filteredLanguages.map((item, index) => {
                const selected = item.code === selectedLanguage.code;
                return (
                  <TouchableOpacity
                    key={item.code}
                    style={[screenshotStyles.languageRow, index === filteredLanguages.length - 1 ? screenshotStyles.languageRowLast : null]}
                    onPress={() => saveLanguage(item)}
                    activeOpacity={0.82}
                    testID={`language-row-${item.code}`}
                  >
                    <View style={screenshotStyles.languageTextWrap}>
                      <Text style={[screenshotStyles.languageName, selected ? screenshotStyles.languageNameSelected : null]} numberOfLines={1}>
                        {item.name}
                      </Text>
                    </View>
                    {selected ? <Ionicons name="checkmark-circle" size={22} color={Colors.primary} /> : null}
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const screenshotStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8F3EA',
  },
  flexOne: {
    flex: 1,
  },
  topBar: {
    minHeight: 54,
    backgroundColor: '#DAA514',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#DBCBAF',
  },
  backButton: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 36,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 18,
  },
  sectionTextWrap: {
    flex: 1,
  },
  sectionLabel: {
    fontSize: 17,
    fontWeight: FontWeight.semibold,
    letterSpacing: 0.8,
    color: Colors.primary,
  },
  sectionHelp: {
    marginTop: 8,
    fontSize: 17,
    lineHeight: 24,
    color: '#5F5A52',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  searchShell: {
    flex: 1,
    minHeight: 94,
    borderRadius: 22,
    backgroundColor: '#FCF8F0',
    borderWidth: 4,
    borderColor: '#E4BE43',
    justifyContent: 'center',
    paddingHorizontal: 18,
    ...Shadow.md,
  },
  searchInput: {
    fontSize: 25,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },
  clearButton: {
    width: 74,
    height: 74,
    borderRadius: 37,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F4EDE2',
  },
  resultsCard: {
    borderRadius: 26,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 18,
    paddingVertical: 10,
    ...Shadow.md,
  },
  feedbackState: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 32,
  },
  feedbackText: {
    fontSize: 15,
    color: Colors.textSecondary,
  },
  languageRow: {
    minHeight: 84,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#F0E8DB',
  },
  languageRowLast: {
    borderBottomWidth: 0,
  },
  languageTextWrap: {
    flex: 1,
    paddingRight: 12,
  },
  languageName: {
    fontSize: 24,
    color: '#22201C',
  },
  languageNameSelected: {
    fontWeight: FontWeight.semibold,
    color: Colors.primaryDark,
  },
});

export default LegacyLanguagesScreen;
