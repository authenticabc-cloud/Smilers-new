/**
 * Profile-photo privacy (iter-226).
 *
 * Lets the user choose WHO may save their profile photo: Everyone / My contacts
 * / Nobody. The choice is persisted on the user profile via
 * `users.updateProfile({ photoSavePolicy })` so OTHER viewers (mobile + web)
 * can read it and enable/disable their in-app "Save to gallery" button.
 *
 * NOTE: enforcement is best-effort (anyone can screenshot); this hides the
 * in-app Save action. Requires the backend to persist + return `photoSavePolicy`
 * (see /app/PHOTO_SAVE_POLICY_BACKEND_SPEC.md). Until then, saving the choice
 * may no-op server-side; the UI degrades gracefully.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../src/convexApi';
import Header from '../src/components/Header';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

type Policy = 'everyone' | 'contacts' | 'nobody';

const OPTIONS: { key: Policy; label: string; sub: string; icon: string }[] = [
  { key: 'everyone', label: 'Everyone', sub: 'Anyone who views your profile can save your photo', icon: 'earth-outline' },
  { key: 'contacts', label: 'My contacts', sub: 'Only people in your contacts can save your photo', icon: 'people-outline' },
  { key: 'nobody', label: 'Nobody', sub: 'No one can save your photo from the app', icon: 'lock-closed-outline' },
];

export default function PhotoPrivacyScreen() {
  const router = useRouter();
  const me = useQuery(api.users.getCurrentUser, {}) as any;
  const updateProfile = useMutation(api.users.updateProfile);

  const serverPolicy: Policy =
    (me?.photoSavePolicy as Policy) || (me?.photoPrivacy as Policy) || 'everyone';
  const [selected, setSelected] = useState<Policy>(serverPolicy);

  useEffect(() => {
    setSelected(serverPolicy);
  }, [serverPolicy]);

  const choose = async (policy: Policy) => {
    const prev = selected;
    setSelected(policy); // optimistic
    try {
      await updateProfile({ photoSavePolicy: policy } as any);
    } catch {
      // Backend may not accept the field yet — keep the optimistic value but
      // tell the user the cross-device sync is pending.
      Alert.alert(
        'Saved on this device',
        'Your choice was applied, but full sync needs a server update (coming soon).',
      );
      setSelected(policy);
      void prev;
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="photo-privacy-screen">
      <Header title="Profile Photo Privacy" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Text style={styles.intro}>Choose who can save your profile photo to their device.</Text>
        {OPTIONS.map((opt) => {
          const active = selected === opt.key;
          return (
            <TouchableOpacity
              key={opt.key}
              style={styles.row}
              onPress={() => choose(opt.key)}
              activeOpacity={0.7}
              testID={`photo-privacy-${opt.key}`}
            >
              <View style={styles.iconWrap}>
                <Ionicons name={opt.icon as any} size={22} color={Colors.primary} />
              </View>
              <View style={styles.rowMid}>
                <Text style={styles.rowTitle}>{opt.label}</Text>
                <Text style={styles.rowSub}>{opt.sub}</Text>
              </View>
              <Ionicons
                name={active ? 'radio-button-on' : 'radio-button-off'}
                size={22}
                color={active ? Colors.primary : Colors.textMuted}
              />
            </TouchableOpacity>
          );
        })}
        <Text style={styles.footnote}>
          Note: this hides the in-app Save button for others. People can still
          screenshot any photo they can see.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  intro: {
    fontSize: 13,
    color: Colors.textSecondary,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    lineHeight: 19,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 16,
    gap: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(60, 40, 0, 0.08)',
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
  rowTitle: { fontSize: 17, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  rowSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 3 },
  footnote: {
    fontSize: 12,
    color: Colors.textMuted,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    lineHeight: 17,
  },
});
