import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
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
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

function getContactId(item: any): string | null {
  const value = item?.userId || item?._id || item?.id;
  return value ? String(value) : null;
}

export default function GroupsCreateScreen() {
  const router = useRouter();
  const createGroup = useMutation((api as any).conversations.createGroup);
  const { data: contacts, loading } = useSafeConvexQuery<any[]>(api.contacts.getContacts, {}, []);
  const [groupName, setGroupName] = useState('');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const filteredContacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = Array.isArray(contacts) ? contacts : [];
    if (!q) return list;
    return list.filter((item: any) => `${item?.name || ''} ${item?.phone || ''} ${item?.email || ''}`.toLowerCase().includes(q));
  }, [contacts, search]);

  const toggleContact = (contactId: string) => {
    setSelectedIds((current) =>
      current.includes(contactId) ? current.filter((item) => item !== contactId) : [...current, contactId]
    );
  };

  const handleCreate = async () => {
    const name = groupName.trim();
    if (!name) {
      Alert.alert('Group name required', 'Enter a name for your new group.');
      return;
    }
    if (selectedIds.length === 0) {
      Alert.alert('Add members', 'Choose at least one contact for the group.');
      return;
    }

    setCreating(true);
    try {
      const created: any = await createGroup({ name, participantIds: selectedIds });
      const conversationId = typeof created === 'string' ? created : created?._id || created?.conversationId;
      if (conversationId) {
        router.replace(`/chat/${conversationId}` as any);
        return;
      }
      Alert.alert('Group created', 'Your group was created successfully.');
      router.back();
    } catch (errorValue: any) {
      Alert.alert('Could not create group', errorValue?.message || 'This backend has not enabled group creation yet.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="groups-create-screen">
      <Header title="New Group" showBack onBack={() => router.back()} variant="dark" subtitle="Choose members and create your group" />

      <View style={styles.formCard} testID="groups-create-form-card">
        <Text style={styles.label} testID="groups-create-name-label">Group name</Text>
        <TextInput
          value={groupName}
          onChangeText={setGroupName}
          placeholder="Enter group name"
          placeholderTextColor={Colors.textMuted}
          style={styles.input}
          testID="groups-create-name-input"
        />

        <Text style={styles.label} testID="groups-create-search-label">Add members</Text>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search contacts"
          placeholderTextColor={Colors.textMuted}
          style={styles.input}
          testID="groups-create-search-input"
        />

        <Text style={styles.selectionText} testID="groups-create-selection-count">
          {selectedIds.length} member{selectedIds.length === 1 ? '' : 's'} selected
        </Text>
      </View>

      {loading ? (
        <View style={styles.loadingWrap} testID="groups-create-loading-state">
          <ActivityIndicator color={Colors.primary} />
          <Text style={styles.loadingText}>Loading contacts…</Text>
        </View>
      ) : (
        <FlatList
          data={filteredContacts}
          keyExtractor={(item: any, index) => getContactId(item) || `contact-${index}`}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const contactId = getContactId(item);
            const selected = contactId ? selectedIds.includes(contactId) : false;
            return (
              <TouchableOpacity
                style={[styles.contactRow, selected ? styles.contactRowSelected : null]}
                activeOpacity={0.8}
                disabled={!contactId}
                onPress={() => (contactId ? toggleContact(contactId) : undefined)}
                testID={`groups-create-contact-${contactId || 'unknown'}`}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{(item?.name || 'S').charAt(0).toUpperCase()}</Text>
                </View>
                <View style={styles.contactTextWrap}>
                  <Text style={styles.contactName}>{item?.name || 'Smilers User'}</Text>
                  <Text style={styles.contactSub} numberOfLines={1}>{item?.phone || item?.email || 'Contact'}</Text>
                </View>
                <Ionicons name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={selected ? Colors.primary : Colors.textMuted} />
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyState} testID="groups-create-empty-state">
              <Ionicons name="people-outline" size={34} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No contacts found</Text>
              <Text style={styles.emptySub}>Add contacts first to create a group.</Text>
            </View>
          }
        />
      )}

      <View style={styles.footer} testID="groups-create-footer">
        <TouchableOpacity
          style={[styles.createButton, creating ? styles.createButtonDisabled : null]}
          onPress={handleCreate}
          disabled={creating}
          activeOpacity={0.85}
          testID="groups-create-submit-button"
        >
          <Text style={styles.createButtonText}>{creating ? 'Creating…' : 'Create Group'}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  formCard: {
    margin: Spacing.base,
    marginBottom: 0,
    padding: Spacing.base,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: Spacing.sm,
  },
  label: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
  },
  input: {
    minHeight: 46,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.md,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  selectionText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  loadingText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  listContent: {
    padding: Spacing.base,
    paddingBottom: 120,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.sm,
  },
  contactRowSelected: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryLight,
  },
  avatarText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.primary,
  },
  contactTextWrap: { flex: 1 },
  contactName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  contactSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: Spacing.xxl,
    gap: Spacing.sm,
  },
  emptyTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  emptySub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  footer: {
    padding: Spacing.base,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.background,
  },
  createButton: {
    minHeight: 50,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
  },
  createButtonDisabled: {
    opacity: 0.7,
  },
  createButtonText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.white,
  },
});