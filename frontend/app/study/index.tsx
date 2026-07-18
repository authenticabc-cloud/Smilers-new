/**
 * Study AI dashboard — six subject cards + recent sessions.
 * Gated behind Premium (usePremiumAccess). Non-premium users can see the
 * dashboard but are prompted to upgrade when they open a tool.
 */
import React from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Colors } from '../../src/theme';
import { usePremiumAccess } from '../../src/hooks/usePremiumAccess';
import { useStudySessions } from '../../src/lib/study/useStudyAi';

interface CardDef {
  key: string;
  title: string;
  subtitle: string;
  icon: string;
  color: string;
  params: Record<string, string>;
  soon?: boolean;
}

const CARDS: CardDef[] = [
  { key: 'scan', title: 'Scan Homework', subtitle: 'Photo or PDF → step by step', icon: 'camera', color: '#2563EB', params: { capture: '1' } },
  { key: 'ask', title: 'Ask a Question', subtitle: 'Type anything to learn', icon: 'message-circle', color: '#7C3AED', params: {} },
  { key: 'math', title: 'Mathematics', subtitle: 'Solve & explain, step by step', icon: 'divide-circle', color: '#2563EB', params: { subject: 'mathematics' } },
  { key: 'science', title: 'Science Lab', subtitle: 'Biology, chemistry, physics', icon: 'thermometer', color: '#16A34A', params: { subject: 'science' } },
  { key: 'language', title: 'Language Coach', subtitle: 'Speak, write & practise', icon: 'globe', color: '#9333EA', params: { subject: 'language' } },
  { key: 'revision', title: 'Revision Studio', subtitle: 'Quizzes, flashcards, plans', icon: 'layers', color: '#EA580C', params: {} },
];

export default function StudyDashboard() {
  const insets = useSafeAreaInsets();
  const premium = usePremiumAccess();
  const { sessions } = useStudySessions();

  const openTool = (card: CardDef) => {
    if (card.soon) {
      Alert.alert('Coming soon', `${card.title} is on the way. Try Scan Homework or Ask a Question for now.`);
      return;
    }
    if (!premium.hasAccess && !premium.isLoading) {
      Alert.alert(
        'Study AI is Premium',
        'Unlock the AI tutor — scan homework, solve step by step and practise. Upgrade in your profile to continue.',
        [{ text: 'Not now', style: 'cancel' }, { text: 'Upgrade', onPress: () => router.push('/premium' as any) }],
      );
      return;
    }
    router.push({ pathname: card.key === 'revision' ? '/study/revision' : '/study/session', params: card.params } as any);
  };

  const recent = (sessions || []).slice(0, 6);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Feather name="arrow-left" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle}>Study AI</Text>
          <Text style={styles.headerSub}>Photograph it. Understand it. Master it.</Text>
        </View>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {!premium.hasAccess && !premium.isLoading ? (
          <Pressable style={styles.premiumBanner} onPress={() => router.push('/premium' as any)}>
            <Feather name="star" size={16} color="#7A5C00" />
            <Text style={styles.premiumText}>Study AI is a Premium feature — tap to upgrade.</Text>
          </Pressable>
        ) : null}

        <View style={styles.grid}>
          {CARDS.map((c) => (
            <TouchableOpacity
              key={c.key}
              style={styles.card}
              activeOpacity={0.85}
              onPress={() => openTool(c)}
              testID={`study-card-${c.key}`}
            >
              <View style={[styles.cardIcon, { backgroundColor: c.color }]}>
                <Feather name={c.icon as any} size={20} color="#fff" />
              </View>
              <Text style={styles.cardTitle}>{c.title}</Text>
              <Text style={styles.cardSub}>{c.subtitle}</Text>
              {c.soon ? <Text style={styles.soon}>Soon</Text> : null}
            </TouchableOpacity>
          ))}
        </View>

        {recent.length > 0 ? (
          <View style={styles.recentSection}>
            <Text style={styles.sectionTitle}>Recent sessions</Text>
            {recent.map((s: any) => (
              <TouchableOpacity
                key={String(s._id)}
                style={styles.recentRow}
                onPress={() =>
                  router.push({ pathname: '/study/session', params: { sessionId: String(s._id) } } as any)
                }
              >
                <Feather name="clock" size={16} color={Colors.textSecondary} />
                <Text style={styles.recentTitle} numberOfLines={1}>
                  {s.title || s.subject || 'Study session'}
                </Text>
                {s.isSaved ? <Feather name="bookmark" size={14} color={Colors.primary} /> : null}
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  headerTitleWrap: { flex: 1 },
  headerTitle: { color: Colors.textPrimary, fontSize: 20, fontWeight: '800' },
  headerSub: { color: Colors.textSecondary, fontSize: 12, marginTop: 1 },
  content: { padding: 16, paddingBottom: 40 },
  premiumBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFF4CC',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  premiumText: { flex: 1, color: '#7A5C00', fontSize: 13, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: {
    width: '47.5%',
    backgroundColor: Colors.surface || '#fff',
    borderRadius: 16,
    padding: 14,
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border || 'rgba(0,0,0,0.06)',
  },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  cardTitle: { color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
  cardSub: { color: Colors.textSecondary, fontSize: 12, lineHeight: 16 },
  soon: {
    alignSelf: 'flex-start',
    marginTop: 4,
    fontSize: 10,
    fontWeight: '700',
    color: '#EA580C',
    backgroundColor: 'rgba(234,88,12,0.12)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  recentSection: { marginTop: 24 },
  sectionTitle: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border || 'rgba(0,0,0,0.06)',
  },
  recentTitle: { flex: 1, color: Colors.textPrimary, fontSize: 15 },
});
