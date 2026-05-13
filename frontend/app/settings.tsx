import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Header from '../src/components/Header';
import { Colors, FontSize, FontWeight, Spacing, Radius } from '../src/theme';

const ITEMS = [
  { key: 'privacy', route: '/privacy', title: 'Privacy', sub: 'Last seen, profile photo, about', icon: 'shield-outline', lib: 'ion' },
  { key: 'app-lock', route: '/app-lock', title: 'App Lock', sub: 'PIN code and biometric unlock', icon: 'fingerprint', lib: 'mc' },
  { key: 'face-id', route: '/face-id', title: 'Face ID', sub: 'Verify identity on new devices', icon: 'face-recognition', lib: 'mc' },
  { key: 'notifications', route: '/notifications', title: 'Notifications', sub: 'Message, group, and call alerts', icon: 'notifications-outline', lib: 'ion' },
  { key: 'earnings', route: '/earnings', title: 'Earnings', sub: 'Levels, engagements, and referrals', icon: 'gift-outline', lib: 'ion' },
  { key: 'blocked', route: '/blocked', title: 'Blocked Users', sub: 'Manage your block list', icon: 'ban-outline', lib: 'ion', danger: true },
  { key: 'scheduled', route: '/scheduled', title: 'Scheduled Messages', sub: 'View and manage scheduled messages', icon: 'time-outline', lib: 'ion' },
  { key: 'quick-replies', route: '/templates', title: 'Quick Replies', sub: 'Create and manage message templates', icon: 'message-text-outline', lib: 'mc' },
  { key: 'chat-appearance', route: '/chat-appearance', title: 'Chat Appearance', sub: 'Wallpapers and bubble themes', icon: 'brush-outline', lib: 'ion' },
];

export default function SettingsScreen() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="settings-screen">
      <Header title="Settings" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {ITEMS.map((item) => (
          <TouchableOpacity
            key={item.key}
            style={styles.row}
            activeOpacity={0.7}
            testID={`settings-${item.key}`}
            onPress={() => router.push(item.route as any)}
          >
            <View style={[styles.iconWrap, item.danger ? { backgroundColor: '#FEE2E2' } : undefined]}>
              {item.lib === 'mc' ? (
                <MaterialCommunityIcons
                  name={item.icon as any}
                  size={22}
                  color={item.danger ? Colors.danger : Colors.primary}
                />
              ) : (
                <Ionicons
                  name={item.icon as any}
                  size={22}
                  color={item.danger ? Colors.danger : Colors.primary}
                />
              )}
            </View>
            <View style={styles.rowMid}>
              <Text style={styles.rowTitle}>{item.title}</Text>
              <Text style={styles.rowSub}>{item.sub}</Text>
            </View>
            <Feather name="chevron-right" size={22} color={Colors.textMuted} />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    gap: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMid: { flex: 1 },
  rowTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  rowSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
});
