/**
 * CallPill (iter-203) — 1:1 port of the web Smilers call pill.
 *
 * Canonical Convex source (per the web-team-confirmed
 * `api.calls.listCallLogsForConversation` doc):
 *
 *   {
 *     callType: 'voice' | 'video',
 *     outcome: 'completed' | 'missed' | 'declined',
 *     direction: 'incoming' | 'outgoing',
 *     startedAt: string,            // ISO 8601 — NOT a number
 *     durationSeconds?: number,     // only set on `completed`
 *     wasRecorded?: boolean,
 *     isConference?: boolean,
 *   }
 *
 * Label mapping (matches the web table exactly):
 *   completed + outgoing → "Outgoing call · {duration}"
 *   completed + incoming → "Incoming call · {duration}"
 *   missed   + outgoing  → "No answer"   (we called, they didn't answer)
 *   missed   + incoming  → "Missed call" (they called, we missed)
 *   declined + any       → "Call declined"   (use callType for a leading video icon)
 *
 * Visual notes from the web screenshots:
 *   • Two-line layout: label on top (bold), time below (smaller, muted).
 *   • Negative outcomes (missed / declined) get a soft-pink pill.
 *   • Completed outgoing  → green outgoing-arrow icon, neutral pill.
 *   • Completed incoming  → green incoming-arrow icon, neutral pill.
 *   • Video calls get an extra `video` icon BEFORE the label text
 *     (not inside the label string).
 *   • `wasRecorded` shows a red "● Recorded" sub-badge under the time.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors } from '../../theme';
import { formatCallDuration } from '../../lib/chatFormat';

function formatPillTime(startedAt: any): string {
  if (!startedAt) return '';
  // Canonical contract says `startedAt` is an ISO 8601 string. Be lenient
  // and accept epoch ms too, so legacy / mocked rows still render.
  let ms: number;
  if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {
    ms = startedAt;
  } else {
    ms = Date.parse(String(startedAt));
  }
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function CallPill({
  item,
  onPress,
  onCallBack,
  hasRecording,
  testID,
}: {
  item: any;
  /** Recording playback. Only fires when there IS an attached recording. */
  onPress?: () => void;
  /** Tap-to-call-back — fires on EVERY pill tap, matching the web behavior
   *  ("when the log in the conversation is tapped, it initiates a call"). */
  onCallBack?: (callType: 'voice' | 'video') => void;
  hasRecording?: boolean;
  testID?: string;
}) {
  const outcome = String(item?.outcome || '');
  const direction = item?.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const isVideo = item?.callType === 'video';
  const duration = formatCallDuration(Number(item?.durationSeconds || 0));
  const isMissed = outcome === 'missed';
  const isDeclined = outcome === 'declined';
  const isCompleted = outcome === 'completed';
  const isNegative = isMissed || isDeclined;

  // Label per the canonical table.
  let label = '';
  if (isDeclined) {
    label = 'Call declined';
  } else if (isMissed) {
    label = direction === 'outgoing' ? 'No answer' : 'Missed call';
  } else if (isCompleted) {
    const dirLabel = direction === 'outgoing' ? 'Outgoing call' : 'Incoming call';
    label = duration ? `${dirLabel} \u00B7 ${duration}` : dirLabel;
  } else {
    // Unknown outcome — neutral fallback.
    label = direction === 'outgoing' ? 'Outgoing call' : 'Incoming call';
  }

  // Leading icon — color matches outcome.
  let leadingIcon: any = 'phone';
  let leadingColor = '#10B981'; // green for positive outcomes
  if (isNegative) {
    leadingIcon = 'phone-missed';
    leadingColor = '#EF4444';
  } else if (direction === 'outgoing') {
    leadingIcon = 'phone-outgoing';
  } else {
    leadingIcon = 'phone-incoming';
  }

  const timeText = formatPillTime(item?.startedAt) || formatPillTime(item?._creationTime);

  // iter-204: the pill is now ALWAYS tappable — tap initiates a callback
  // (matches web "tap log → call contact"). Playback of a recorded call,
  // when one exists, has moved to a dedicated tap target on the
  // "● Recorded" badge so the two gestures don't conflict.
  const callTypeForBack: 'voice' | 'video' = isVideo ? 'video' : 'voice';
  const handlePillPress = () => {
    if (onCallBack) onCallBack(callTypeForBack);
  };
  const handleRecordingPress = () => {
    if (onPress) onPress();
  };
  const pressable = !!onCallBack;
  const Wrapper: any = pressable ? TouchableOpacity : View;
  const wrapperProps: any = pressable
    ? { onPress: handlePillPress, activeOpacity: 0.7, accessibilityRole: 'button' as const }
    : {};

  return (
    <View style={callPillStyles.row} testID={testID}>
      <Wrapper
        {...wrapperProps}
        style={[callPillStyles.pill, isNegative ? callPillStyles.pillDanger : callPillStyles.pillNeutral]}
      >
        {/* Circular icon disc — softer than a flat icon. */}
        <View
          style={[
            callPillStyles.iconDisc,
            isNegative ? callPillStyles.iconDiscDanger : callPillStyles.iconDiscNeutral,
          ]}
        >
          <MaterialCommunityIcons name={leadingIcon as any} size={14} color={leadingColor} />
        </View>

        {/* Two-line label block. */}
        <View style={callPillStyles.labelBlock}>
          <View style={callPillStyles.labelRow}>
            {/* Web shows a small video icon before "Call declined" for video calls. */}
            {isVideo ? (
              <MaterialCommunityIcons
                name="video-outline"
                size={14}
                color={isNegative ? '#B91C1C' : Colors.textSecondary}
                style={{ marginRight: 4 }}
              />
            ) : null}
            <Text
              style={[callPillStyles.text, isNegative ? callPillStyles.textDanger : null]}
              numberOfLines={1}
            >
              {label}
            </Text>
          </View>
          {timeText ? (
            <Text
              style={[callPillStyles.subText, isNegative ? callPillStyles.subTextDanger : null]}
              numberOfLines={1}
            >
              {timeText}
            </Text>
          ) : null}
          {item?.wasRecorded ? (
            <TouchableOpacity
              onPress={hasRecording && onPress ? handleRecordingPress : undefined}
              disabled={!(hasRecording && onPress)}
              style={callPillStyles.recordedBadge}
              testID="call-pill-recorded"
            >
              <View style={callPillStyles.recordedDot} />
              <Text style={callPillStyles.recordedText}>
                {hasRecording ? 'Play recording' : 'Recorded'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </Wrapper>
    </View>
  );
}

const callPillStyles = StyleSheet.create({
  row: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 22,
    maxWidth: '90%',
    borderWidth: StyleSheet.hairlineWidth,
  },
  pillNeutral: {
    backgroundColor: 'rgba(255, 250, 235, 0.90)',
    borderColor: 'rgba(60, 40, 0, 0.10)',
  },
  pillDanger: {
    backgroundColor: 'rgba(255, 235, 230, 0.95)',
    borderColor: 'rgba(239, 68, 68, 0.18)',
  },
  iconDisc: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconDiscNeutral: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
  },
  iconDiscDanger: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
  },
  labelBlock: {
    flexShrink: 1,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  text: {
    fontSize: 14,
    color: Colors.textPrimary,
    fontWeight: '700',
  },
  textDanger: {
    color: '#B91C1C',
  },
  subText: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 1,
  },
  subTextDanger: {
    color: '#B91C1C',
    opacity: 0.85,
  },
  recordedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    alignSelf: 'flex-start',
  },
  recordedDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#EF4444',
  },
  recordedText: {
    fontSize: 11,
    color: '#B91C1C',
    fontWeight: '700',
  },
});
