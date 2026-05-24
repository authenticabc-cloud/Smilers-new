/**
 * New Community — mirrors the Smilers web "New Community" form layout.
 *
 * Fields:
 *  - Avatar/icon (placeholder building icon — actual image upload deferred)
 *  - Community Name (required)
 *  - Description (optional)
 *  - "What are communities?" informational callout
 *
 * Submits to `api.communities.createCommunity`. Falls back gracefully if the
 * backend hasn't shipped the endpoint.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';

import { api } from '../src/convexApi';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../src/theme';

export default function CommunityCreateScreen() {
  const router = useRouter();
  const createCommunity = useMutation((api as any).communities.createCommunity);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const canSubmit = name.trim().length >= 2;

  const handleCreate = useCallback(async () => {
    if (!canSubmit || creating) return;
    setCreating(true);
    try {
      const created: any = await createCommunity({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      const id =
        typeof created === 'string'
          ? created
          : created?._id || created?.communityId || created?.id;
      Alert.alert(
        'Community created',
        `"${name.trim()}" is ready. Invite people to start the conversation.`,
        [
          {
            text: 'OK',
            onPress: () => {
              if (id) {
                // Future: route to community details. For now, head back.
                router.back();
              } else {
                router.back();
              }
            },
          },
        ],
      );
    } catch (errorValue: any) {
      const message = String(errorValue?.message || '');
      const isMissing = message.includes('CouldNotFindFunction') || message.includes('not found');
      Alert.alert(
        'Could not create community',
        isMissing
          ? 'The Communities backend endpoints have not been deployed yet. Once the web team ships api.communities.createCommunity, this flow will work end-to-end.'
          : message || 'Please try again.',
      );
    } finally {
      setCreating(false);
    }
  }, [canSubmit, createCommunity, creating, description, name, router]);

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="community-create-screen">
      {/* Dark header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.headerBack} testID="community-back">
          <Ionicons name="arrow-back" size={26} color={Colors.white} />
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.headerTitle}>New Community</Text>
        </View>
        <TouchableOpacity
          onPress={handleCreate}
          disabled={!canSubmit || creating}
          style={[styles.headerCta, !canSubmit ? styles.headerCtaDisabled : null]}
          testID="community-create-btn"
        >
          {creating ? (
            <ActivityIndicator size="small" color={Colors.headerBg} />
          ) : (
            <Text style={styles.headerCtaText}>Create</Text>
          )}
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Icon */}
          <View style={styles.iconWrap}>
            <View style={styles.iconCircle}>
              <MaterialCommunityIcons name="office-building-outline" size={56} color={Colors.primary} />
            </View>
          </View>

          {/* Name */}
          <View style={styles.fieldWrap}>
            <Text style={styles.label}>
              Community Name <Text style={styles.required}>*</Text>
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="e.g. Photography Club, Tech Hub..."
              placeholderTextColor={Colors.textMuted}
              style={[styles.input, name.trim().length > 0 ? styles.inputFocused : null]}
              maxLength={50}
              testID="community-name-input"
              returnKeyType="next"
            />
          </View>

          {/* Description */}
          <View style={styles.fieldWrap}>
            <Text style={styles.label}>
              Description <Text style={styles.optional}>(optional)</Text>
            </Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="What's this community about?"
              placeholderTextColor={Colors.textMuted}
              style={[styles.input, styles.inputMulti]}
              multiline
              maxLength={500}
              textAlignVertical="top"
              testID="community-description-input"
            />
          </View>

          {/* Info callout */}
          <View style={styles.callout} testID="community-info-callout">
            <View style={styles.calloutHeaderRow}>
              <MaterialCommunityIcons name="account-group-outline" size={22} color={Colors.primary} />
              <Text style={styles.calloutTitle}>What are communities?</Text>
            </View>
            <Text style={styles.calloutBody}>
              Communities are organized spaces where people with shared interests can chat, share
              posts, and host events. As an admin, you can:
            </Text>
            <View style={styles.bulletList}>
              <CalloutBullet text="Invite members by phone or link" />
              <CalloutBullet text="Create channels for different topics" />
              <CalloutBullet text="Pin announcements visible to everyone" />
              <CalloutBullet text="Moderate content and manage roles" />
            </View>
          </View>

          {/* Big primary action (in case header CTA missed) */}
          <TouchableOpacity
            onPress={handleCreate}
            disabled={!canSubmit || creating}
            style={[styles.primaryCta, !canSubmit ? styles.primaryCtaDisabled : null]}
            activeOpacity={0.85}
            testID="community-primary-cta"
          >
            {creating ? (
              <ActivityIndicator color={Colors.headerBg} />
            ) : (
              <>
                <Feather name="check" size={20} color={Colors.headerBg} />
                <Text style={styles.primaryCtaText}>Create community</Text>
              </>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function CalloutBullet({ text }: { text: string }) {
  return (
    <View style={styles.bulletRow}>
      <View style={styles.bulletDot} />
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.headerBg,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
    minHeight: 64,
  },
  headerBack: { padding: 4 },
  headerTextWrap: { flex: 1, marginLeft: 4 },
  headerTitle: { color: Colors.white, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  headerCta: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCtaDisabled: { opacity: 0.5 },
  headerCtaText: { color: Colors.headerBg, fontWeight: FontWeight.bold, fontSize: FontSize.sm },

  scrollContent: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.xl,
    paddingBottom: 60,
  },

  iconWrap: { alignItems: 'center', marginBottom: Spacing.xl },
  iconCircle: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.sm,
  },

  fieldWrap: { marginBottom: Spacing.lg },
  label: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    fontWeight: FontWeight.bold,
    marginBottom: 8,
  },
  required: { color: Colors.danger },
  optional: { color: Colors.textMuted, fontWeight: FontWeight.regular },
  input: {
    minHeight: 50,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  inputFocused: { borderColor: Colors.primary, borderWidth: 2 },
  inputMulti: { minHeight: 90, textAlignVertical: 'top' },

  callout: {
    backgroundColor: Colors.primaryLight,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(228,181,59,0.4)',
    marginBottom: Spacing.lg,
  },
  calloutHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  calloutTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  calloutBody: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
    marginBottom: 10,
  },
  bulletList: { gap: 6 },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  bulletDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.primary,
    marginTop: 7,
  },
  bulletText: { flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary, lineHeight: 20 },

  primaryCta: {
    minHeight: 52,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    ...Shadow.md,
  },
  primaryCtaDisabled: { opacity: 0.5 },
  primaryCtaText: { color: Colors.headerBg, fontSize: FontSize.base, fontWeight: FontWeight.bold },
});
