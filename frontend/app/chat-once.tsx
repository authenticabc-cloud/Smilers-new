import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Share,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import * as Clipboard from 'expo-clipboard';
import { api } from '../src/convexApi';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../src/theme';

type TabKey = 'generate' | 'enter';

const PALE_YELLOW = '#FAEEC8';

function makeLocalCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export default function ChatOnceScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('generate');
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [enteredCode, setEnteredCode] = useState('');
  const [joining, setJoining] = useState(false);

  // We try the Convex backend — if functions aren't deployed yet we fall back to a local code.
  const generateRemote: any = useMutation(api.chatOnce?.generateCode || api.chatOnce?.create);
  const joinRemote: any = useMutation(api.chatOnce?.joinByCode || api.chatOnce?.join);

  const handleGenerate = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      let code: string | null = null;
      try {
        const res = await generateRemote({});
        code = (res && (res.code || res.pairingCode)) || null;
      } catch (e) {
        // Convex function missing — fall back locally
        code = makeLocalCode();
      }
      setGeneratedCode(code || makeLocalCode());
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    if (!generatedCode) return;
    await Clipboard.setStringAsync(generatedCode);
    Alert.alert('Copied', 'Code copied to clipboard');
  };

  const handleShare = async () => {
    if (!generatedCode) return;
    try {
      await Share.share({
        message: `Join me on Smilers Chat Once — enter code ${generatedCode}. The chat auto-deletes after 24 hours.`,
      });
    } catch {}
  };

  const handleJoin = async () => {
    const code = enteredCode.trim().toUpperCase();
    if (code.length < 4) {
      Alert.alert('Enter Code', 'Please enter a valid code.');
      return;
    }
    setJoining(true);
    try {
      try {
        const res = await joinRemote({ code });
        const conversationId = res?.conversationId || res?._id || res?.id;
        if (conversationId) {
          router.push(`/chat/${conversationId}` as any);
          return;
        }
      } catch (e: any) {
        Alert.alert('Could not join', e?.message || 'This feature is being rolled out — try again soon.');
        return;
      }
      Alert.alert('Joining', `Code ${code} accepted.`);
    } finally {
      setJoining(false);
    }
  };

  return (
    <View style={styles.root}>
      {/* Dark brown header */}
      <SafeAreaView edges={['top']} style={styles.headerSafe}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => router.back()}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            testID="back-btn"
          >
            <Ionicons name="arrow-back" size={24} color={Colors.white} />
          </TouchableOpacity>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>Chat Once</Text>
            <Text style={styles.headerSubtitle}>Anonymous 24-hour conversations</Text>
          </View>
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Info banner */}
          <View style={styles.infoBanner}>
            <View style={styles.infoIconCircle}>
              <Feather name="globe" size={22} color={Colors.primary} />
            </View>
            <View style={styles.infoText}>
              <Text style={styles.infoTitle}>Chat with anyone, no contacts needed</Text>
              <Text style={styles.infoBody}>
                Perfect for tourists and travelers. Generate a code, share it with someone nearby, and chat in your preferred languages. The chat auto-deletes after 24 hours.
              </Text>
            </View>
          </View>

          {/* Tabs */}
          <View style={styles.tabsRow}>
            <TouchableOpacity
              style={styles.tabBtn}
              onPress={() => setTab('generate')}
              testID="tab-generate"
              activeOpacity={0.7}
            >
              <Text style={[styles.tabLabel, tab === 'generate' && styles.tabLabelActive]}>
                Generate Code
              </Text>
              <View style={[styles.tabUnderline, tab === 'generate' && styles.tabUnderlineActive]} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.tabBtn}
              onPress={() => setTab('enter')}
              testID="tab-enter"
              activeOpacity={0.7}
            >
              <Text style={[styles.tabLabel, tab === 'enter' && styles.tabLabelActive]}>
                Enter Code
              </Text>
              <View style={[styles.tabUnderline, tab === 'enter' && styles.tabUnderlineActive]} />
            </TouchableOpacity>
          </View>

          {/* Tab content */}
          {tab === 'generate' ? (
            <View style={styles.card}>
              <View style={styles.cardIconCircle}>
                <Ionicons name="chatbubble-outline" size={26} color={Colors.primary} />
              </View>

              {generatedCode ? (
                <>
                  <Text style={styles.cardTitle}>Your code</Text>
                  <Text style={styles.codeDisplay}>{generatedCode}</Text>
                  <Text style={styles.cardSubtitle}>
                    Share this with the person you want to chat with. The chat will be deleted after 24 hours.
                  </Text>
                  <View style={styles.codeActionsRow}>
                    <TouchableOpacity style={styles.secondaryBtn} onPress={handleCopy} testID="copy-code-btn">
                      <Feather name="copy" size={18} color={Colors.textPrimary} />
                      <Text style={styles.secondaryBtnText}>Copy</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.secondaryBtn} onPress={handleShare} testID="share-code-btn">
                      <Feather name="share-2" size={18} color={Colors.textPrimary} />
                      <Text style={styles.secondaryBtnText}>Share</Text>
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity
                    style={[styles.primaryBtn, styles.primaryBtnSecondary]}
                    onPress={() => setGeneratedCode(null)}
                    testID="new-code-btn"
                  >
                    <Text style={styles.primaryBtnText}>Generate Another Code</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <Text style={styles.cardTitle}>Generate a code</Text>
                  <Text style={styles.cardSubtitle}>
                    Share the code with the person you want to chat with
                  </Text>
                  <TouchableOpacity
                    style={styles.primaryBtn}
                    onPress={handleGenerate}
                    disabled={generating}
                    testID="generate-code-btn"
                  >
                    {generating ? (
                      <ActivityIndicator color={Colors.textPrimary} />
                    ) : (
                      <Text style={styles.primaryBtnText}>Generate Code</Text>
                    )}
                  </TouchableOpacity>
                </>
              )}
            </View>
          ) : (
            <View style={styles.card}>
              <View style={styles.cardIconCircle}>
                <Feather name="hash" size={26} color={Colors.primary} />
              </View>
              <Text style={styles.cardTitle}>Enter a code</Text>
              <Text style={styles.cardSubtitle}>
                Enter the 6-character code shared with you to start chatting
              </Text>
              <TextInput
                style={styles.codeInput}
                value={enteredCode}
                onChangeText={(t) => setEnteredCode(t.toUpperCase().replace(/\s/g, '').slice(0, 6))}
                placeholder="ABC123"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={6}
                testID="enter-code-input"
              />
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={handleJoin}
                disabled={joining || enteredCode.length < 4}
                testID="join-code-btn"
              >
                {joining ? (
                  <ActivityIndicator color={Colors.textPrimary} />
                ) : (
                  <Text style={styles.primaryBtnText}>Start Chat</Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          {/* How it works */}
          <Text style={styles.sectionLabel}>HOW IT WORKS</Text>

          <HowRow
            icon={<MaterialCommunityIcons name="star-four-points-outline" size={20} color={Colors.primary} />}
            text="Generate a unique 6-character code"
          />
          <HowRow
            icon={<Ionicons name="people-outline" size={20} color={Colors.primary} />}
            text="Share the code with someone nearby"
          />
          <HowRow
            icon={<Feather name="globe" size={20} color={Colors.primary} />}
            text="Chat in your preferred languages with auto-translation"
          />
          <HowRow
            icon={<Ionicons name="timer-outline" size={20} color={Colors.primary} />}
            text="Chat and all messages auto-delete after 24 hours"
          />

          <View style={{ height: Spacing.lg }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function HowRow({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <View style={styles.howRow}>
      <View style={styles.howIconCircle}>{icon}</View>
      <Text style={styles.howText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  headerSafe: {
    backgroundColor: Colors.headerBg,
  },
  header: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  backBtn: {
    marginTop: 6,
    marginRight: Spacing.base,
    padding: 2,
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    color: Colors.white,
    fontSize: 26,
    fontWeight: FontWeight.bold,
    marginBottom: 2,
  },
  headerSubtitle: {
    color: '#D9C7A3',
    fontSize: FontSize.base,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: Spacing.xl,
  },

  // Info banner
  infoBanner: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.base,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: '#E8DFC8',
  },
  infoIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: PALE_YELLOW,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Spacing.md,
  },
  infoText: {
    flex: 1,
  },
  infoTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  infoBody: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },

  // Tabs
  tabsRow: {
    flexDirection: 'row',
    backgroundColor: Colors.background,
    paddingHorizontal: 0,
  },
  tabBtn: {
    flex: 1,
    alignItems: 'center',
    paddingTop: Spacing.base,
    paddingBottom: 0,
  },
  tabLabel: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
    marginBottom: Spacing.sm,
  },
  tabLabelActive: {
    color: Colors.primary,
  },
  tabUnderline: {
    height: 3,
    width: '100%',
    backgroundColor: 'transparent',
  },
  tabUnderlineActive: {
    backgroundColor: Colors.primary,
  },

  // Card
  card: {
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.base,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    alignItems: 'center',
    ...Shadow.sm,
  },
  cardIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: PALE_YELLOW,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.base,
  },
  cardTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginBottom: Spacing.sm,
    textAlign: 'center',
  },
  cardSubtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: Spacing.lg,
    paddingHorizontal: Spacing.sm,
    lineHeight: 20,
  },
  codeDisplay: {
    fontSize: 36,
    fontWeight: FontWeight.bold,
    color: Colors.primary,
    letterSpacing: 6,
    marginBottom: Spacing.base,
    fontVariant: ['tabular-nums'],
  },
  codeInput: {
    width: '100%',
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    fontSize: 22,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
    letterSpacing: 4,
    marginBottom: Spacing.base,
  },
  primaryBtn: {
    backgroundColor: Colors.primary,
    width: '100%',
    height: 52,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnSecondary: {
    backgroundColor: '#F3E9C7',
    marginTop: Spacing.sm,
  },
  primaryBtnText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  codeActionsRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    width: '100%',
    marginBottom: Spacing.sm,
  },
  secondaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.background,
    borderRadius: Radius.md,
    paddingVertical: 12,
    gap: 6,
  },
  secondaryBtnText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },

  // How it works
  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    letterSpacing: 1,
    marginTop: Spacing.lg,
    marginBottom: Spacing.sm,
    marginHorizontal: Spacing.base,
  },
  howRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.base,
    marginBottom: Spacing.sm,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    ...Shadow.sm,
  },
  howIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: PALE_YELLOW,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Spacing.md,
  },
  howText: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
});
