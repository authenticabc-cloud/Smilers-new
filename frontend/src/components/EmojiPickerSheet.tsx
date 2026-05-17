import React, { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Spacing } from '../theme';

type EmojiCategoryKey = 'recent' | 'smileys' | 'animals' | 'food' | 'travel' | 'activities' | 'objects' | 'symbols' | 'flags';

const EMOJI_CATEGORY_META: Array<{ key: EmojiCategoryKey; label: string; title: string; icon: string; lib: 'ion' | 'feather' | 'mc' }> = [
  { key: 'recent', label: 'Recent', title: 'Recently used', icon: 'time-outline', lib: 'ion' },
  { key: 'smileys', label: 'Smileys', title: 'Smileys & People', icon: 'happy-outline', lib: 'ion' },
  { key: 'animals', label: 'Animals', title: 'Animals & Nature', icon: 'cat', lib: 'mc' },
  { key: 'food', label: 'Food', title: 'Food & Drink', icon: 'fast-food-outline', lib: 'ion' },
  { key: 'travel', label: 'Travel', title: 'Travel & Places', icon: 'bus-outline', lib: 'ion' },
  { key: 'activities', label: 'Activities', title: 'Activities', icon: 'football-outline', lib: 'ion' },
  { key: 'objects', label: 'Objects', title: 'Objects', icon: 'shirt-outline', lib: 'ion' },
  { key: 'symbols', label: 'Symbols', title: 'Symbols', icon: 'musical-notes-outline', lib: 'ion' },
  { key: 'flags', label: 'Flags', title: 'Flags', icon: 'flag-outline', lib: 'ion' },
];

const EMOJI_LIBRARY: Record<Exclude<EmojiCategoryKey, 'recent'>, string[]> = {
  smileys: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '😘', '😗', '😚', '😋', '😛', '😜', '🤪', '🤗', '🤩', '🥳', '😎', '🤓', '🫠', '😭', '🙏'],
  animals: ['🐶', '🐺', '🦊', '🦝', '🐱', '🐈', '🐈‍⬛', '🦁', '🐯', '🐅', '🐆', '🐴', '🫎', '🫏', '🐮', '🐄', '🐃', '🐂', '🐷', '🐖', '🐗', '🐏', '🐑', '🐐', '🐪', '🐫', '🦄', '🐼', '🦓', '🦒'],
  food: ['🍗', '🥩', '🥓', '🍔', '🍟', '🍕', '🌭', '🥪', '🌮', '🌯', '🥙', '🍲', '🥘', '🥣', '🥗', '🍿', '🧈', '🧂', '🥫', '🍱', '🍙', '🍚', '🍛', '🍜', '🍝', '🍠', '🍣', '🥟', '🍤', '🥚'],
  travel: ['🏔️', '🌋', '⛰️', '🏕️', '🏖️', '🏜️', '🏝️', '🖼️', '🏟️', '🏛️', '🏗️', '🪨', '🪵', '🛖', '🏠', '🏡', '🏘️', '🏢', '🏬', '🏪', '🏥', '🏦', '🏨', '🏭', '🏯', '⛩️', '🗼', '🗽', '🚏', '🛣️'],
  activities: ['🎃', '🎄', '🎆', '🎇', '🧨', '✨', '🎈', '🎉', '🎍', '🎎', '🎏', '🎐', '🎑', '🧧', '🎀', '🎁', '🎗️', '🎫', '🎟️', '🏅', '🏆', '🥇', '🥈', '🥉', '⚽', '⚾', '🥎', '🏀', '🏐', '🎾'],
  objects: ['👓', '🕶️', '🥽', '🧥', '🦺', '👕', '👔', '👗', '👘', '🥻', '🩱', '🩲', '🩳', '🧤', '🧣', '🧦', '👞', '👟', '🥾', '🥿', '👠', '👡', '👜', '👝', '🎒', '🛍️', '🧳', '💼', '👑', '🎓'],
  symbols: ['⛔', '🚳', '🚭', '🚯', '📵', '🔞', '☢️', '☣️', '⬆️', '↗️', '➡️', '↘️', '⬇️', '↙️', '⬅️', '↖️', '↕️', '↔️', '🔁', '🔄', '↪️', '↩️', '➕', '➖', '➗', '✖️', '♻️', '✅', '⚠️', '❌'],
  flags: ['🇨🇩', '🇨🇫', '🇨🇬', '🇨🇭', '🇨🇮', '🇨🇰', '🇨🇱', '🇨🇲', '🇨🇳', '🇨🇴', '🇨🇷', '🇨🇺', '🇨🇻', '🇨🇼', '🇨🇾', '🇨🇿', '🇩🇪', '🇩🇯', '🇩🇰', '🇩🇲', '🇩🇿', '🇪🇨', '🇪🇪', '🇪🇬', '🇪🇷', '🇪🇸', '🇫🇷', '🇬🇧', '🇬🇭', '🇿🇦'],
};

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelectEmoji: (emoji: string) => void;
  recentEmojis: string[];
}

export default function EmojiPickerSheet({ visible, onClose, onSelectEmoji, recentEmojis }: Props) {
  const [selectedCategory, setSelectedCategory] = useState<EmojiCategoryKey>('smileys');
  const [query, setQuery] = useState('');

  const recentList = recentEmojis.length > 0 ? recentEmojis : ['😀', '😂', '😍', '🙏', '🔥', '🎉', '❤️', '👍'];
  const normalizedQuery = query.trim().toLowerCase();

  const displayedEmojis = useMemo(() => {
    if (normalizedQuery) {
      const fullSet = [...recentList, ...Object.values(EMOJI_LIBRARY).flat()];
      return Array.from(new Set(fullSet.filter((emoji) => emoji.includes(normalizedQuery) || emoji === normalizedQuery)));
    }
    if (selectedCategory === 'recent') {
      return recentList;
    }
    return EMOJI_LIBRARY[selectedCategory];
  }, [normalizedQuery, recentList, selectedCategory]);

  const title = normalizedQuery
    ? 'Search results'
    : EMOJI_CATEGORY_META.find((item) => item.key === selectedCategory)?.title || 'Emojis';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}} testID="emoji-picker-sheet">
          <View style={styles.searchRow}>
            <Feather name="search" size={22} color={Colors.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search"
              placeholderTextColor={Colors.textMuted}
              style={styles.searchInput}
              testID="emoji-search-input"
            />
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryRow} testID="emoji-category-row">
            {EMOJI_CATEGORY_META.map((category) => {
              const selected = category.key === selectedCategory;
              const Icon: any = category.lib === 'mc' ? MaterialCommunityIcons : category.lib === 'feather' ? Feather : Ionicons;
              return (
                <TouchableOpacity
                  key={category.key}
                  style={[styles.categoryBtn, selected ? styles.categoryBtnActive : null]}
                  onPress={() => {
                    setQuery('');
                    setSelectedCategory(category.key);
                  }}
                  testID={`emoji-category-${category.key}`}
                >
                  <Icon name={category.icon as any} size={30} color={selected ? '#66B7F2' : '#8D8D8D'} />
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <Text style={styles.sectionTitle}>{title}</Text>

          <ScrollView style={styles.gridScroll} contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false} testID="emoji-grid-scroll">
            {displayedEmojis.map((emoji, index) => (
              <TouchableOpacity
                key={`${emoji}-${index}`}
                style={styles.emojiBtn}
                onPress={() => onSelectEmoji(emoji)}
                testID={`emoji-option-${selectedCategory}-${index}`}
              >
                <Text style={styles.emojiText}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.12)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#FBF9F6',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingTop: 16,
    paddingHorizontal: 18,
    paddingBottom: 14,
    minHeight: 470,
    maxHeight: '74%',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F1F1F4',
    borderRadius: 18,
    paddingHorizontal: 16,
    minHeight: 56,
  },
  searchInput: {
    flex: 1,
    marginLeft: 10,
    fontSize: 20,
    color: Colors.textPrimary,
  },
  categoryRow: {
    paddingTop: 18,
    paddingBottom: 12,
    gap: 18,
    alignItems: 'center',
  },
  categoryBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryBtnActive: {
    borderWidth: 2,
    borderColor: '#77BDF0',
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: FontWeight.bold,
    color: '#707070',
    marginBottom: 12,
  },
  gridScroll: {
    flex: 1,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingBottom: 16,
  },
  emojiBtn: {
    width: '11%',
    minWidth: 34,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 42,
  },
  emojiText: {
    fontSize: 31,
  },
});