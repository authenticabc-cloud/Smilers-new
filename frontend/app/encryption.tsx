import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../src/theme';

export default function EncryptionScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Encryption</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.heroCircle}>
          <Feather name="lock" size={48} color={Colors.primary} />
        </View>
        <Text style={styles.heroTitle}>Your messages are end-to-end encrypted</Text>
        <Text style={styles.heroSubtitle}>
          Messages, calls, status updates and media are protected with AES-256-GCM. Not even Smilers can read them.
        </Text>

        <View style={styles.card}>
          <InfoRow
            icon={<MaterialCommunityIcons name="shield-key-outline" size={22} color={Colors.primary} />}
            title="AES-256-GCM"
            body="Industry-standard authenticated encryption used for every message and attachment."
          />
          <InfoRow
            icon={<MaterialCommunityIcons name="key-variant" size={22} color={Colors.primary} />}
            title="PBKDF2 key derivation"
            body="Your keys are derived from a passphrase using PBKDF2 with 600,000 iterations."
          />
          <InfoRow
            icon={<Feather name="phone-call" size={22} color={Colors.primary} />}
            title="Calls are SRTP-encrypted"
            body="Voice, video and screen-share streams use SRTP with DTLS handshakes between devices."
          />
          <InfoRow
            icon={<Feather name="server" size={22} color={Colors.primary} />}
            title="Zero-knowledge backend"
            body="Convex stores ciphertext only — your private keys never leave this device."
            isLast
          />
        </View>

        <View style={styles.footerBox}>
          <Feather name="info" size={16} color={Colors.textSecondary} />
          <Text style={styles.footerText}>
            For maximum security, set up App Lock and verify the security code with each contact.
          </Text>
        </View>

        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => router.push('/app-lock' as any)}
          activeOpacity={0.8}
        >
          <Feather name="shield" size={18} color={Colors.textPrimary} />
          <Text style={styles.actionText}>App Lock settings</Text>
          <Feather name="chevron-right" size={20} color={Colors.textSecondary} style={{ marginLeft: 'auto' }} />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoRow({
  icon,
  title,
  body,
  isLast,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  isLast?: boolean;
}) {
  return (
    <View style={[styles.infoRow, isLast && { borderBottomWidth: 0 }]}>
      <View style={styles.infoIcon}>{icon}</View>
      <View style={{ flex: 1 }}>
        <Text style={styles.infoTitle}>{title}</Text>
        <Text style={styles.infoBody}>{body}</Text>
      </View>
    </View>
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
    borderBottomColor: 'rgba(0,0,0,0.08)',
  },
  backBtn: { width: 24 },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  body: { padding: Spacing.lg, alignItems: 'stretch', paddingBottom: Spacing.xxl },
  heroCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: Spacing.lg,
  },
  heroTitle: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  heroSubtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: Spacing.base,
    marginTop: Spacing.sm,
    marginBottom: Spacing.lg,
    lineHeight: 20,
  },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.base,
    ...Shadow.sm,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: Spacing.base,
    gap: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  infoIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  infoBody: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2, lineHeight: 18 },
  footerBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.base,
    marginTop: Spacing.base,
  },
  footerText: { flex: 1, fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 18 },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.base,
    marginTop: Spacing.sm,
    ...Shadow.sm,
  },
  actionText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
});
