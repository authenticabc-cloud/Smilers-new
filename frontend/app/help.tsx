import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useMutation } from 'convex/react';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { useAuth } from '../src/providers/AuthProvider';
import { FAQS, FAQ_CATEGORIES, FaqCategory, FaqItem } from '../src/lib/faqs';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

// iter-174: support inbox was switched from support@smilers.online
// (broken MX records — mail bounced) to a Gmail-hosted alias that the
// team monitors directly. All mailto: links + the on-screen footer
// reference this constant so any future change is a one-line edit.
const SUPPORT_EMAIL = 'support.smilers@gmail.com';
const HELP_CENTER_URL = 'https://smilers.online/help';

type TopicKey = 'question' | 'bug' | 'feature' | 'billing' | 'other';

const TOPICS: { key: TopicKey; label: string; icon: string; tone: string }[] = [
  { key: 'question', label: 'Ask a question', icon: 'help-circle-outline', tone: Colors.primary },
  { key: 'bug', label: 'Report a bug', icon: 'bug-outline', tone: Colors.danger },
  { key: 'feature', label: 'Request a feature', icon: 'sparkles-outline', tone: '#8B5CF6' },
  { key: 'billing', label: 'Billing & ads', icon: 'card-outline', tone: '#0EA5E9' },
  { key: 'other', label: 'Something else', icon: 'chatbubble-ellipses-outline', tone: Colors.textSecondary },
];

export default function HelpScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { data: me } = useSafeConvexQuery<any | null>(
    api.users.getCurrentUser,
    {},
    null,
    isAuthenticated,
  );
  const submitTicket = useMutation(api.support.submitTicket);

  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<FaqCategory | 'All'>('All');
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});
  const [topic, setTopic] = useState<TopicKey>('question');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const filtered = useMemo<FaqItem[]>(() => {
    const q = search.trim().toLowerCase();
    return FAQS.filter((item) => {
      const matchCategory = activeCategory === 'All' || item.category === activeCategory;
      if (!matchCategory) return false;
      if (!q) return true;
      return (
        item.q.toLowerCase().includes(q) ||
        item.a.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
      );
    });
  }, [activeCategory, search]);

  const toggle = useCallback((key: string) => {
    setOpenKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const openSupportEmail = useCallback(async () => {
    const subj = encodeURIComponent('Smilers support request');
    const url = `mailto:${SUPPORT_EMAIL}?subject=${subj}`;
    const canOpen = await Linking.canOpenURL(url).catch(() => false);
    if (canOpen) {
      await Linking.openURL(url);
    } else {
      Alert.alert('Email not available', `Please email us at ${SUPPORT_EMAIL}.`);
    }
  }, []);

  const openHelpCenter = useCallback(async () => {
    const canOpen = await Linking.canOpenURL(HELP_CENTER_URL).catch(() => false);
    if (canOpen) {
      await Linking.openURL(HELP_CENTER_URL);
    } else {
      Alert.alert('Cannot open link', HELP_CENTER_URL);
    }
  }, []);

  const submit = useCallback(async () => {
    const trimmedSubject = subject.trim();
    const trimmedMessage = message.trim();
    if (!trimmedSubject) {
      Alert.alert('Add a subject', 'Please add a short subject so we know what your request is about.');
      return;
    }
    if (trimmedMessage.length < 10) {
      Alert.alert('Tell us more', 'Please share at least a sentence about what is happening so we can help.');
      return;
    }
    setSubmitting(true);
    const appVersion =
      Constants.expoConfig?.version || (Constants as any).manifest?.version || 'unknown';
    const payload = {
      topic,
      subject: trimmedSubject,
      message: trimmedMessage,
      contactEmail: me?.email,
      contactPhone: me?.phone,
      userId: me?._id,
      platform: Platform.OS,
      appVersion,
    };
    try {
      await submitTicket(payload);
      setSubject('');
      setMessage('');
      Alert.alert(
        'Message sent',
        'Thanks for reaching out! Our support team will reply by email as soon as possible.',
      );
    } catch (errorValue: any) {
      // Backend may not have submitTicket yet — fall back to mailto with the
      // user’s pre-filled message.
      console.warn('submitTicket failed:', errorValue?.message);
      const body = encodeURIComponent(
        `${trimmedMessage}\n\n---\nTopic: ${topic}\nPlatform: ${Platform.OS}\nVersion: ${appVersion}` +
          (me?.email ? `\nFrom: ${me.email}` : '') +
          (me?.phone ? `\nPhone: ${me.phone}` : ''),
      );
      const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(trimmedSubject)}&body=${body}`;
      const canOpen = await Linking.canOpenURL(url).catch(() => false);
      if (canOpen) {
        await Linking.openURL(url);
        setSubject('');
        setMessage('');
      } else {
        Alert.alert(
          'Could not send',
          `Please email us directly at ${SUPPORT_EMAIL}.`,
        );
      }
    } finally {
      setSubmitting(false);
    }
  }, [me, message, subject, submitTicket, topic]);

  const categories: Array<FaqCategory | 'All'> = ['All', ...FAQ_CATEGORIES];

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="help-screen">
      <Header title="Help & Support" showBack onBack={() => router.back()} variant="dark" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
      >
        <ScrollView
          contentContainerStyle={{ paddingBottom: 48 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Quick actions */}
          <View style={styles.quickRow}>
            <TouchableOpacity
              style={styles.quickCard}
              onPress={openHelpCenter}
              activeOpacity={0.85}
              testID="help-quick-center"
            >
              <View style={[styles.quickIcon, { backgroundColor: '#DBEAFE' }]}>
                <Ionicons name="library-outline" size={22} color="#1D4ED8" />
              </View>
              <Text style={styles.quickTitle}>Help center</Text>
              <Text style={styles.quickSub}>Open online docs</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.quickCard}
              onPress={openSupportEmail}
              activeOpacity={0.85}
              testID="help-quick-email"
            >
              <View style={[styles.quickIcon, { backgroundColor: Colors.primaryLight }]}>
                <Ionicons name="mail-outline" size={22} color={Colors.primaryDark} />
              </View>
              <Text style={styles.quickTitle}>Email us</Text>
              <Text style={styles.quickSub} numberOfLines={1}>{SUPPORT_EMAIL}</Text>
            </TouchableOpacity>
          </View>

          {/* Search */}
          <View style={styles.searchWrap}>
            <Ionicons name="search" size={18} color={Colors.textMuted} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search help articles"
              placeholderTextColor={Colors.textMuted}
              style={styles.searchInput}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              testID="help-search"
            />
            {search ? (
              <TouchableOpacity onPress={() => setSearch('')} hitSlop={10}>
                <Ionicons name="close-circle" size={18} color={Colors.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>

          {/* Category chips */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.categoryRow}
            testID="help-category-row"
          >
            {categories.map((c) => {
              const active = activeCategory === c;
              return (
                <Pressable
                  key={c}
                  onPress={() => setActiveCategory(c)}
                  style={[styles.categoryChip, active ? styles.categoryChipActive : null]}
                  testID={`help-category-${c}`}
                >
                  <Text style={[styles.categoryChipText, active ? styles.categoryChipTextActive : null]}>{c}</Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {/* FAQ list */}
          <Text style={styles.sectionLabel}>
            {filtered.length} {filtered.length === 1 ? 'article' : 'articles'}
          </Text>

          {filtered.length === 0 ? (
            <View style={styles.emptyWrap}>
              <Ionicons name="search-outline" size={36} color={Colors.textMuted} />
              <Text style={styles.emptyText}>No articles match “{search}”.</Text>
            </View>
          ) : (
            <View style={styles.faqCard}>
              {filtered.map((item, index) => {
                const key = `${item.category}-${index}`;
                const open = !!openKeys[key];
                return (
                  <View key={key} style={[styles.faqRow, index === filtered.length - 1 ? styles.faqRowLast : null]}>
                    <TouchableOpacity
                      style={styles.faqHeader}
                      onPress={() => toggle(key)}
                      activeOpacity={0.7}
                      testID={`faq-toggle-${index}`}
                    >
                      <View style={styles.flexOne}>
                        <Text style={styles.faqCategory}>{item.category}</Text>
                        <Text style={styles.faqQ} numberOfLines={open ? undefined : 2}>
                          {item.q}
                        </Text>
                      </View>
                      <Ionicons
                        name={open ? 'chevron-up' : 'chevron-down'}
                        size={20}
                        color={Colors.textSecondary}
                      />
                    </TouchableOpacity>
                    {open ? <Text style={styles.faqA}>{item.a}</Text> : null}
                  </View>
                );
              })}
            </View>
          )}

          {/* Contact form */}
          <Text style={styles.sectionLabel}>Still need help? Send us a message</Text>
          <View style={styles.formCard}>
            <Text style={styles.label}>What is this about?</Text>
            <View style={styles.topicWrap}>
              {TOPICS.map((t) => {
                const active = t.key === topic;
                return (
                  <Pressable
                    key={t.key}
                    onPress={() => setTopic(t.key)}
                    style={[styles.topicChip, active ? styles.topicChipActive : null]}
                    testID={`help-topic-${t.key}`}
                  >
                    <Ionicons name={t.icon as any} size={16} color={active ? Colors.headerBg : t.tone} />
                    <Text style={[styles.topicText, active ? styles.topicTextActive : null]}>{t.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.label}>Subject</Text>
            <TextInput
              value={subject}
              onChangeText={setSubject}
              placeholder="e.g. Can’t add a trustee"
              placeholderTextColor={Colors.textMuted}
              style={styles.input}
              editable={!submitting}
              testID="help-subject"
            />

            <Text style={styles.label}>Message</Text>
            <TextInput
              value={message}
              onChangeText={setMessage}
              placeholder="Share as much detail as you can. Screenshots help — you can email us those after."
              placeholderTextColor={Colors.textMuted}
              style={[styles.input, styles.textarea]}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
              editable={!submitting}
              testID="help-message"
            />

            <Text style={styles.helper}>
              We’ll reply to {me?.email || 'your account email'}. Your account ID is automatically included so we can locate your data.
            </Text>

            <TouchableOpacity
              style={[styles.submitBtn, submitting ? { opacity: 0.7 } : null]}
              onPress={submit}
              disabled={submitting}
              testID="help-submit"
            >
              {submitting ? (
                <ActivityIndicator size="small" color={Colors.headerBg} />
              ) : (
                <>
                  <Ionicons name="send-outline" size={18} color={Colors.headerBg} />
                  <Text style={styles.submitText}>Send message</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {/* Footer info */}
          <View style={styles.footerCard}>
            <Text style={styles.footerLine}>
              Smilers v{Constants.expoConfig?.version || '1.0'} · Platform {Platform.OS}
            </Text>
            <Text style={styles.footerLine}>{SUPPORT_EMAIL}</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  quickRow: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.base,
    gap: Spacing.sm,
  },
  quickCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  quickIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  quickTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  quickSub: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginTop: 2,
  },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },

  categoryRow: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: 4,
    gap: 8,
  },
  categoryChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  categoryChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  categoryChipText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
  },
  categoryChipTextActive: {
    color: Colors.headerBg,
  },

  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
  },

  emptyWrap: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    gap: 8,
    paddingHorizontal: Spacing.lg,
  },
  emptyText: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },

  faqCard: {
    marginHorizontal: Spacing.base,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    overflow: 'hidden',
  },
  faqRow: {
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  faqRowLast: { borderBottomWidth: 0 },
  faqHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  faqCategory: {
    fontSize: 10,
    fontWeight: FontWeight.bold,
    color: Colors.primaryDark,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  faqQ: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    lineHeight: 22,
  },
  faqA: {
    marginTop: Spacing.sm,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },

  formCard: {
    marginHorizontal: Spacing.base,
    padding: Spacing.base,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  label: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: Spacing.md,
    marginBottom: 6,
  },
  topicWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  topicChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  topicChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  topicText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
  },
  topicTextActive: { color: Colors.headerBg },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    backgroundColor: Colors.background,
  },
  textarea: {
    minHeight: 120,
    paddingTop: 12,
  },
  helper: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: Spacing.md,
    lineHeight: 18,
  },
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: Spacing.md,
    paddingVertical: 14,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    minHeight: 48,
  },
  submitText: {
    color: Colors.headerBg,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.base,
  },
  footerCard: {
    alignItems: 'center',
    paddingVertical: Spacing.lg,
    gap: 4,
  },
  footerLine: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  flexOne: { flex: 1 },
});
