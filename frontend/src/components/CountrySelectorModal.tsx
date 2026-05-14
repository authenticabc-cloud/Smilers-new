import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather, Ionicons } from '@expo/vector-icons';
import { COUNTRIES } from '../constants/countries';
import { Colors, FontSize, FontWeight, Radius, Spacing, Shadow } from '../theme';

interface Props {
  selected: string[];
  title: string;
  visible: boolean;
  onApply: (countries: string[]) => void;
  onClose: () => void;
}

export default function CountrySelectorModal({ selected, title, visible, onApply, onClose }: Props) {
  const [draft, setDraft] = useState<string[]>(selected);
  const [query, setQuery] = useState('');

  React.useEffect(() => {
    if (visible) {
      setDraft(selected);
      setQuery('');
    }
  }, [selected, visible]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [...COUNTRIES];
    return COUNTRIES.filter((country) => country.toLowerCase().includes(needle));
  }, [query]);

  const toggle = (country: string) => {
    setDraft((current) =>
      current.includes(country) ? current.filter((item) => item !== country) : [...current, country]
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}} testID="country-selector-modal">
          <View style={styles.header}>
            <Text style={styles.title} testID="country-selector-title">
              {title}
            </Text>
            <TouchableOpacity onPress={onClose} testID="country-selector-close">
              <Feather name="x" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.searchWrap}>
            <Feather name="search" size={18} color={Colors.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search countries"
              placeholderTextColor={Colors.textMuted}
              style={styles.searchInput}
              testID="country-selector-search"
            />
          </View>

          <FlatList
            data={filtered}
            keyExtractor={(item) => item}
            style={styles.list}
            renderItem={({ item }) => {
              const checked = draft.includes(item);
              return (
                <TouchableOpacity
                  style={styles.row}
                  onPress={() => toggle(item)}
                  activeOpacity={0.7}
                  testID={`country-option-${item}`}
                >
                  <View style={[styles.checkbox, checked ? styles.checkboxChecked : null]}>
                    {checked ? <Ionicons name="checkmark" size={16} color={Colors.white} /> : null}
                  </View>
                  <Text style={styles.rowText}>{item}</Text>
                </TouchableOpacity>
              );
            }}
          />

          <View style={styles.footer}>
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => setDraft([])} testID="country-selector-clear">
              <Text style={styles.secondaryText}>Clear</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => {
                onApply(draft);
                onClose();
              }}
              testID="country-selector-apply"
            >
              <Text style={styles.primaryText}>Apply ({draft.length})</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: Spacing.base,
    maxHeight: '85%',
    ...Shadow.lg,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.base },
  title: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.base,
  },
  searchInput: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  list: { maxHeight: 420 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  rowText: { fontSize: FontSize.base, color: Colors.textPrimary },
  footer: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.base },
  secondaryBtn: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  primaryBtn: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
  },
  secondaryText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.medium },
  primaryText: { fontSize: FontSize.base, color: Colors.white, fontWeight: FontWeight.bold },
});