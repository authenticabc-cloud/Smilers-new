import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import Header from '../../src/components/Header';
import Avatar from '../../src/components/Avatar';
import SosButton from '../../src/components/SosButton';
import { api } from '../../src/convexApi';
import { useAuth } from '../../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../../src/theme';

export default function ProfileScreen() {
  const router = useRouter();
  const { signOut, userInfo } = useAuth();
  const me = useQuery(api.users.getCurrentUser);

  const name = me?.name || userInfo?.name || 'Smilers';
  const email = me?.email || userInfo?.email || '';
  const about = me?.about || 'Hey there! I am using Smilers.';
  const language = me?.preferredLanguage || 'No preference — show original';

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="profile-screen">
      <Header title="Profile" variant="dark" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.avatarSection}>
          <View style={styles.avatarWrap}>
            <Avatar name={name} size={120} />
            <TouchableOpacity style={styles.cameraBadge} testID="profile-camera-btn">
              <Feather name="camera" size={16} color={Colors.white} />
            </TouchableOpacity>
          </View>
        </View>

        <Section label="YOUR NAME">
          <Row value={name} testID="profile-name" />
        </Section>

        <Section label="ABOUT">
          <Row value={about} testID="profile-about" />
        </Section>

        <Section label="MESSAGE LANGUAGE" icon={<Feather name="globe" size={14} color={Colors.primary} />} helper="All messages you receive will be auto-translated into this language.">
          <Row value={language} testID="profile-language" />
        </Section>

        <Section label="EMAIL">
          <Row value={email} editable={false} testID="profile-email" />
        </Section>

        <View style={styles.buttonsBlock}>
          <TouchableOpacity style={styles.linkBtn} onPress={() => router.push('/starred' as any)} testID="starred-btn">
            <Ionicons name="star-outline" size={20} color={Colors.primary} />
            <Text style={styles.linkText}>Starred Messages</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.linkBtn}
            onPress={() => router.push('/settings')}
            testID="settings-privacy-btn"
          >
            <Ionicons name="settings-outline" size={20} color={Colors.primary} />
            <Text style={styles.linkText}>Settings & Privacy</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.linkBtn, { marginTop: Spacing.base }]}
            onPress={signOut}
            testID="sign-out-btn"
          >
            <Feather name="log-out" size={20} color={Colors.danger} />
            <Text style={[styles.linkText, { color: Colors.danger }]}>Sign Out</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 80 }} />
      </ScrollView>
      <SosButton onPress={() => router.push('/emergency' as any)} />
    </SafeAreaView>
  );
}

function Section({
  label,
  icon,
  helper,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionLabelRow}>
        {icon}
        <Text style={styles.sectionLabel}>{label}</Text>
      </View>
      {helper ? <Text style={styles.helper}>{helper}</Text> : null}
      {children}
    </View>
  );
}

function Row({ value, editable = true, testID }: { value: string; editable?: boolean; testID?: string }) {
  return (
    <View style={styles.valueRow} testID={testID}>
      <Text style={styles.valueText} numberOfLines={2}>
        {value}
      </Text>
      {editable && <Feather name="edit-2" size={16} color={Colors.textMuted} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scroll: { paddingBottom: Spacing.xxl },
  avatarSection: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    backgroundColor: Colors.surface,
  },
  avatarWrap: { position: 'relative' },
  cameraBadge: {
    position: 'absolute',
    right: 0,
    bottom: 5,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: Colors.surface,
    ...Shadow.sm,
  },
  section: {
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.base,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: Spacing.sm,
  },
  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.primary,
    letterSpacing: 1,
  },
  helper: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.sm,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
  },
  valueText: {
    flex: 1,
    fontSize: FontSize.lg,
    color: Colors.textPrimary,
    fontWeight: FontWeight.regular,
  },
  buttonsBlock: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.base,
    gap: 10,
  },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    borderRadius: Radius.lg,
  },
  linkText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
});
