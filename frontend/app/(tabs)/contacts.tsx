import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery, useMutation } from 'convex/react';
import Header from '../../src/components/Header';
import Avatar from '../../src/components/Avatar';
import { api } from '../../src/convexApi';
import { Colors, FontSize, FontWeight, Spacing, Radius } from '../../src/theme';

export default function ContactsScreen() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const contacts = useQuery(api.contacts.getContacts);
  const pending = useQuery(api.contacts.getPendingRequests);
  const searchResults = useQuery(
    api.users.searchUsers,
    search.trim().length >= 2 ? { query: search.trim() } : 'skip'
  );
  const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);
  const sendRequest = useMutation(api.contacts.sendRequest);
  const acceptRequest = useMutation(api.contacts.acceptRequest);

  const list: any[] = Array.isArray(contacts) ? contacts : [];
  const pendingList: any[] = Array.isArray(pending) ? pending : [];
  const results: any[] = Array.isArray(searchResults) ? searchResults : [];

  const openChat = async (userId: string) => {
    try {
      const convId: any = await getOrCreateDirect({ otherUserId: userId });
      if (convId) router.push(`/chat/${convId}` as any);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Could not open chat');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="contacts-screen">
      <Header title="Contacts" variant="dark" />

      <View style={styles.searchWrap}>
        <Feather name="search" size={18} color={Colors.textMuted} />
        <TextInput
          placeholder="Search people by name or email"
          placeholderTextColor={Colors.textMuted}
          value={search}
          onChangeText={setSearch}
          style={styles.searchInput}
          autoCapitalize="none"
          testID="contacts-search"
        />
      </View>

      <FlatList
        data={search.trim().length >= 2 ? results : list}
        keyExtractor={(item: any) => item._id}
        contentContainerStyle={{ paddingBottom: 100 }}
        ListHeaderComponent={
          <>
            {pendingList.length > 0 && search.trim().length < 2 && (
              <>
                <Text style={styles.sectionLabel}>PENDING REQUESTS</Text>
                {pendingList.map((p: any) => (
                  <View key={p._id} style={styles.row}>
                    <Avatar name={p.name} size={44} />
                    <View style={styles.rowMid}>
                      <Text style={styles.rowName}>{p.name || 'Smilers user'}</Text>
                      <Text style={styles.rowSub}>{p.email || 'wants to connect'}</Text>
                    </View>
                    <TouchableOpacity
                      style={styles.acceptBtn}
                      onPress={() => acceptRequest({ contactId: p._id }).catch(() => {})}
                      testID={`accept-${p._id}`}
                    >
                      <Text style={styles.acceptText}>Accept</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </>
            )}
            <Text style={styles.sectionLabel}>
              {search.trim().length >= 2 ? 'SEARCH RESULTS' : 'CONTACTS'}
            </Text>
          </>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.7}
            onPress={() => openChat(item._id)}
            testID={`contact-${item._id}`}
          >
            <Avatar name={item.name} size={44} />
            <View style={styles.rowMid}>
              <Text style={styles.rowName}>{item.name || 'Smilers user'}</Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {item.email || item.about || 'Available'}
              </Text>
            </View>
            {search.trim().length >= 2 ? (
              <TouchableOpacity
                style={styles.addBtn}
                onPress={() => sendRequest({ contactId: item._id }).catch(() => {})}
              >
                <Ionicons name="person-add-outline" size={18} color={Colors.primary} />
              </TouchableOpacity>
            ) : (
              <Ionicons name="chatbubble-ellipses-outline" size={22} color={Colors.primary} />
            )}
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          contacts !== undefined ? (
            <View style={styles.empty}>
              <Feather name="users" size={32} color={Colors.textMuted} />
              <Text style={styles.emptyText}>
                {search.trim().length >= 2
                  ? 'No users found'
                  : 'No contacts yet. Search above to find friends.'}
              </Text>
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
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
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.primary,
    letterSpacing: 1,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    backgroundColor: Colors.background,
  },
  rowMid: {
    flex: 1,
    marginLeft: Spacing.md,
  },
  rowName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  rowSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  addBtn: {
    padding: 8,
  },
  acceptBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: Radius.pill,
  },
  acceptText: {
    color: Colors.white,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
  },
  empty: {
    alignItems: 'center',
    paddingTop: Spacing.xxl,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.md,
  },
  emptyText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
});
