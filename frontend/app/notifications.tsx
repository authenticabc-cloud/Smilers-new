import React, { useCallback } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Spacing } from '../src/theme';

const ITEMS = [
  { key: 'messages', title: 'Messages', subtitle: 'New chat messages' },
  { key: 'groups', title: 'Groups', subtitle: 'Group messages and mentions' },
  { key: 'calls', title: 'Calls', subtitle: 'Incoming voice and video calls' },
  { key: 'statuses', title: 'Statuses', subtitle: 'New stories from your contacts' },
  { key: 'reactions', title: 'Reactions', subtitle: 'When someone reacts to your messages' },
  { key: 'mentions', title: 'Mentions', subtitle: 'When you are @mentioned' },
];

export default function NotificationsScreen() {
  const router = useRouter();
  const { data: me, refetch } = useSafeConvexQuery<any | null>(api.users.getCurrentUser, {}, null);
  const updateProfile = useMutation(api.users.updateProfile);
  const notifications = (me?.notifications || {}) as Record<string, boolean | undefined>;
  const canEdit = !!me;

  const toggle = useCallback(
    async (key: string, value: boolean) => {
      if (!me) {
        return;
      }
      try {
        await updateProfile({ notifications: { ...notifications, [key]: value } });
        await refetch();
      } catch (errorValue: any) {
        console.warn('Failed to update notification', errorValue);
      }
    },
    [me, notifications, refetch, updateProfile]
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="notifications-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="notifications-back-button">
          <Ionicons name="chevron-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} testID="notifications-header-title">
          Notifications
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content} testID="notifications-scroll-view">
        <Text style={styles.note} testID="notifications-note">
          Choose which notifications you want to receive on this device.
        </Text>
        {!canEdit ? (
          <Text style={styles.helper} testID="notifications-auth-helper">
            Sign in to change notification preferences.
          </Text>
        ) : null}
        {ITEMS.map((item) => (
          <View key={item.key} style={styles.row} testID={`notifications-row-${item.key}`}>
            <View style={styles.flexOne}>
              <Text style={styles.rowTitle} testID={`notifications-title-${item.key}`}>
                {item.title}
              </Text>
              <Text style={styles.rowSub} testID={`notifications-subtitle-${item.key}`}>
                {item.subtitle}
              </Text>
            </View>
            <Switch
              value={notifications[item.key] !== false}
              onValueChange={(value) => toggle(item.key, value)}
              trackColor={{ true: Colors.primary, false: '#cccccc' }}
              disabled={!canEdit}
              testID={`notifications-switch-${item.key}`}
            />
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#00000022',
  },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  headerSpacer: { width: 26 },
  note: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.base, lineHeight: 18 },
  helper: { fontSize: FontSize.sm, color: Colors.textMuted, marginBottom: Spacing.base },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#00000011',
  },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  content: { padding: Spacing.base },
  flexOne: { flex: 1 },
});