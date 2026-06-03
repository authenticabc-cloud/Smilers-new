/**
 * Devotional Broadcasts — Preferences
 *
 * Two sections:
 *   1. FEED FILTER (synced to backend via
 *      api.devotionals.updatePreferences):
 *        • Every broadcast
 *        • Only my contacts
 *        • Only selected contacts  (TODO: contact picker is a follow-up;
 *          for v1 we expose the feed filter toggle—filtering by SET of
 *          contacts can be added once the picker UI is shared with the
 *          Communities feature.)
 *
 *   2. DO NOT TRANSLATE FROM (local, AsyncStorage):
 *        Languages whose source-language broadcasts the user wants to
 *        see in their ORIGINAL form (i.e. don't auto-translate from them).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';

import { api } from '../../src/convexApi';
import { LANGUAGES, getLanguageByCode } from '../../src/lib/languages';
import {
  readNoTranslateLangs,
  writeNoTranslateLangs,
} from '../../src/lib/devotionalsLocalPrefs';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../src/theme';

type FeedFilter = 'all' | 'contacts' | 'selected';

interface PreferencesShape {
  feedFilter?: FeedFilter;
  selectedContactIds?: string[];
}

export default function DevotionalsPreferencesScreen() {
  const router = useRouter();
  const remotePrefs = useQuery((api as any).devotionals?.getPreferences, {});
  const updatePreferences = useMutation((api as any).devotionals?.updatePreferences);

  const [feedFilter, setFeedFilter] = useState<FeedFilter>('all');
  const [noTranslateLangs, setNoTranslateLangs] = useState<string[]>([]);
  const [savingFilter, setSavingFilter] = useState(false);
  const [savingLangs, setSavingLangs] = useState(false);
  const [search, setSearch] = useState('');

  // Hydrate from server.
  useEffect(() => {
    if (remotePrefs && typeof remotePrefs === 'object') {
      const p = remotePrefs as PreferencesShape;
      if (p.feedFilter && p.feedFilter !== feedFilter) {
        setFeedFilter(p.feedFilter);
      }
    }
  }, [remotePrefs]);

  // Hydrate the local-only language exclusions.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const langs = await readNoTranslateLangs();
      if (!cancelled) setNoTranslateLangs(langs);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSelectFilter = useCallback(
    async (value: FeedFilter) => {
      const prev = feedFilter;
      setFeedFilter(value);
      setSavingFilter(true);
      try {
        await (updatePreferences as any)({
          feedFilter: value,
          ...(value === 'selected' ? { selectedContactIds: [] } : {}),
        });
      } catch (errorValue: any) {
        setFeedFilter(prev); // revert
        Alert.alert(
          'Could not save',
          errorValue?.message?.includes('CouldNotFindFunction') ||
            errorValue?.message?.toLowerCase().includes('not found')
            ? 'Feed-filter sync needs the latest backend update. The choice is still applied for this session.'
            : errorValue?.message || 'Unknown error',
        );
      } finally {
        setSavingFilter(false);
      }
    },
    [feedFilter, updatePreferences],
  );

  const toggleLanguage = useCallback(
    async (code: string) => {
      const exists = noTranslateLangs.includes(code);
      const next = exists
        ? noTranslateLangs.filter((c) => c !== code)
        : [...noTranslateLangs, code];
      setNoTranslateLangs(next);
      setSavingLangs(true);
      try {
        await writeNoTranslateLangs(next);
      } catch {
        /* swallow — AsyncStorage failures are non-fatal */
      } finally {
        setSavingLangs(false);
      }
    },
    [noTranslateLangs],
  );

  const filteredLanguages = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return LANGUAGES;
    return LANGUAGES.filter(
      (lang) =>
        lang.name.toLowerCase().includes(q) ||
        lang.nativeName.toLowerCase().includes(q) ||
        lang.code.toLowerCase() === q,
    );
  }, [search]);

  const renderHeader = () => (
    <View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Show me broadcasts from</Text>
        <Text style={styles.sectionSubtitle}>
          Controls which devotionals appear in your feed.
        </Text>

        <FilterRow
          label="Every broadcast"
          description="Posts from anyone on Smilers."
          icon="globe"
          active={feedFilter === 'all'}
          disabled={savingFilter}
          onPress={() => onSelectFilter('all')}
          testID="devotionals-filter-all"
        />
        <FilterRow
          label="Only my contacts"
          description="Posts from people you've added as contacts."
          icon="users"
          active={feedFilter === 'contacts'}
          disabled={savingFilter}
          onPress={() => onSelectFilter('contacts')}
          testID="devotionals-filter-contacts"
        />
        <FilterRow
          label="Only selected contacts"
          description="Posts from a chosen subset of contacts. (Picker coming soon — for now this acts like ‘Only my contacts’.)"
          icon="user-check"
          active={feedFilter === 'selected'}
          disabled={savingFilter}
          onPress={() => onSelectFilter('selected')}
          testID="devotionals-filter-selected"
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Do not translate from</Text>
        <Text style={styles.sectionSubtitle}>
          Broadcasts originally written in these languages stay in their
          original form. Everything else is translated to your preferred
          language.
        </Text>
        {noTranslateLangs.length > 0 ? (
          <View style={styles.selectedRow}>
            {noTranslateLangs.slice(0, 6).map((code) => {
              const lang = getLanguageByCode(code);
              return (
                <View key={code} style={styles.selectedPill}>
                  <Text style={styles.selectedPillText}>
                    {lang?.flag || ''} {lang?.name || code}
                  </Text>
                </View>
              );
            })}
            {noTranslateLangs.length > 6 ? (
              <Text style={styles.selectedMore}>+{noTranslateLangs.length - 6}</Text>
            ) : null}
          </View>
        ) : null}
        <View style={styles.searchWrap}>
          <Feather name="search" size={16} color={Colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search languages"
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
            testID="devotionals-lang-search"
          />
        </View>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="devotionals-prefs-back">
          <Feather name="arrow-left" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Devotional preferences</Text>
        <View style={styles.headerSpacer} />
      </View>

      <FlatList
        data={filteredLanguages}
        keyExtractor={(lang) => lang.code}
        ListHeaderComponent={renderHeader}
        renderItem={({ item }) => {
          const selected = noTranslateLangs.includes(item.code);
          return (
            <TouchableOpacity
              style={styles.langRow}
              onPress={() => toggleLanguage(item.code)}
              disabled={savingLangs}
              testID={`devotionals-lang-${item.code}`}
            >
              <Text style={styles.langFlag}>{item.flag}</Text>
              <View style={styles.flexOne}>
                <Text style={styles.langName}>{item.name}</Text>
                <Text style={styles.langNative}>{item.nativeName}</Text>
              </View>
              {selected ? (
                <MaterialCommunityIcons
                  name="check-circle"
                  size={22}
                  color={Colors.primary}
                />
              ) : (
                <Feather name="circle" size={20} color={Colors.border} />
              )}
            </TouchableOpacity>
          );
        }}
        contentContainerStyle={styles.listContent}
      />
    </SafeAreaView>
  );
}

function FilterRow({
  label,
  description,
  icon,
  active,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  description: string;
  icon: any;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.filterRow, active ? styles.filterRowActive : null]}
      onPress={onPress}
      disabled={disabled}
      testID={testID}
    >
      <Feather name={icon} size={18} color={active ? Colors.primary : Colors.textSecondary} />
      <View style={styles.flexOne}>
        <Text style={[styles.filterLabel, active ? styles.filterLabelActive : null]}>{label}</Text>
        <Text style={styles.filterDescription}>{description}</Text>
      </View>
      {active ? (
        <MaterialCommunityIcons name="check-circle" size={22} color={Colors.primary} />
      ) : (
        <Feather name="circle" size={20} color={Colors.border} />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  headerSpacer: { width: 22 },
  listContent: { padding: Spacing.base, paddingBottom: 40 },
  section: {
    backgroundColor: Colors.white,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    marginBottom: 14,
    ...Shadow.sm,
  },
  sectionTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  sectionSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4, marginBottom: 12 },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 8,
  },
  filterRowActive: { borderColor: Colors.primary, backgroundColor: '#F2FBF5' },
  filterLabel: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.medium },
  filterLabelActive: { color: Colors.primary },
  filterDescription: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  selectedRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  selectedPill: {
    backgroundColor: '#E6F8EC',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  selectedPillText: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: FontWeight.medium },
  selectedMore: { fontSize: FontSize.xs, color: Colors.textSecondary, alignSelf: 'center' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: Radius.md,
    backgroundColor: Colors.background,
    marginTop: 4,
  },
  searchInput: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary, paddingVertical: 0 },
  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: Spacing.base,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  langFlag: { fontSize: 22 },
  langName: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.medium },
  langNative: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 2 },
  flexOne: { flex: 1 },
});
