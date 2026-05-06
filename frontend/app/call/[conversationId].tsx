import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../src/convexApi';
import Avatar from '../../src/components/Avatar';
import { Colors, FontSize, FontWeight, Spacing, Shadow } from '../../src/theme';

export default function CallScreen() {
  const router = useRouter();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const conversation = useQuery(
    api.conversations.getConversation,
    conversationId ? { conversationId } : 'skip'
  );
  const activeCall = useQuery(
    api.calls.getActiveCall,
    conversationId ? { conversationId } : 'skip'
  );
  const initiateCall = useMutation(api.calls.initiateCall);
  const answerCall = useMutation(api.calls.answerCall);
  const endCall = useMutation(api.calls.endCall);
  const declineCall = useMutation(api.calls.declineCall);
  const [callId, setCallId] = useState<string | null>(null);

  const me = useQuery(api.users.getCurrentUser);
  const isIncoming = activeCall && activeCall.callerId !== me?._id && activeCall.status === 'ringing';
  const isActive = activeCall && activeCall.status === 'active';
  const isOutgoing = activeCall && activeCall.callerId === me?._id && activeCall.status === 'ringing';

  useEffect(() => {
    if (activeCall?._id) setCallId(activeCall._id);
  }, [activeCall?._id]);

  const startCall = async (callType: 'voice' | 'video') => {
    if (!conversationId) return;
    try {
      const id: any = await initiateCall({ conversationId, callType });
      setCallId(id);
    } catch (e: any) {
      console.warn('initiateCall failed', e?.message);
    }
  };

  const handleAnswer = async () => {
    if (!callId) return;
    try {
      await answerCall({ callId });
    } catch (e: any) {
      console.warn('answer failed', e?.message);
    }
  };

  const handleHangup = async () => {
    if (callId) {
      try {
        await endCall({ callId });
      } catch {}
    }
    router.back();
  };

  const handleDecline = async () => {
    if (callId) {
      try {
        await declineCall({ callId });
      } catch {}
    }
    router.back();
  };

  const otherName = conversation?.name || conversation?.otherUserName || 'Smilers';
  const status = isIncoming
    ? 'Incoming call…'
    : isActive
    ? 'In call'
    : isOutgoing
    ? 'Calling…'
    : 'Tap to start a call';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="call-screen">
      <View style={styles.topArea}>
        <Avatar name={otherName} size={140} backgroundColor={Colors.primaryLight} />
        <Text style={styles.name}>{otherName}</Text>
        <Text style={styles.status}>{status}</Text>
        {isOutgoing && <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.lg }} />}
      </View>

      <View style={styles.controls}>
        {isIncoming ? (
          <View style={styles.row}>
            <TouchableOpacity style={[styles.bigBtn, styles.declineBtn]} onPress={handleDecline} testID="decline-call-btn">
              <Ionicons name="close" size={32} color={Colors.white} />
              <Text style={styles.bigBtnLabel}>Decline</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.bigBtn, styles.answerBtn]} onPress={handleAnswer} testID="answer-call-btn">
              <Ionicons name="call" size={32} color={Colors.white} />
              <Text style={styles.bigBtnLabel}>Answer</Text>
            </TouchableOpacity>
          </View>
        ) : isActive || isOutgoing ? (
          <View style={styles.row}>
            <TouchableOpacity style={[styles.bigBtn, styles.declineBtn]} onPress={handleHangup} testID="hangup-btn">
              <Ionicons name="call" size={32} color={Colors.white} style={{ transform: [{ rotate: '135deg' }] }} />
              <Text style={styles.bigBtnLabel}>Hang up</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.bigBtn, styles.callBtn]}
              onPress={() => startCall('voice')}
              testID="voice-call-btn"
            >
              <Ionicons name="call" size={32} color={Colors.white} />
              <Text style={styles.bigBtnLabel}>Voice</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.bigBtn, styles.videoBtn]}
              onPress={() => startCall('video')}
              testID="video-call-btn"
            >
              <Feather name="video" size={32} color={Colors.white} />
              <Text style={styles.bigBtnLabel}>Video</Text>
            </TouchableOpacity>
          </View>
        )}

        <Text style={styles.note}>
          WebRTC voice/video calls launch in a future update — push notifications and call signaling are wired up now.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.headerBg,
    justifyContent: 'space-between',
  },
  topArea: {
    alignItems: 'center',
    paddingTop: Spacing.xxl,
    gap: Spacing.md,
  },
  name: {
    fontSize: FontSize.xxxl,
    fontWeight: FontWeight.bold,
    color: Colors.white,
    marginTop: Spacing.lg,
  },
  status: {
    fontSize: FontSize.base,
    color: Colors.primaryLight,
  },
  controls: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.xl,
    gap: Spacing.lg,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    gap: Spacing.lg,
  },
  bigBtn: {
    width: 100,
    height: 100,
    borderRadius: 50,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.lg,
  },
  bigBtnLabel: {
    color: Colors.white,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    marginTop: 4,
  },
  answerBtn: { backgroundColor: Colors.success },
  declineBtn: { backgroundColor: Colors.danger },
  callBtn: { backgroundColor: Colors.primary },
  videoBtn: { backgroundColor: Colors.primaryDark },
  note: {
    color: Colors.primaryLight,
    fontSize: FontSize.xs,
    textAlign: 'center',
    paddingTop: Spacing.md,
  },
});
