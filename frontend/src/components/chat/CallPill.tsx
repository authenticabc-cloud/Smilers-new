/**
 * CallPill (iter 156, extracted iter-184) — renders a single call-log row
 * as a centered "system pill" inside the chat timeline. Matches Smilers
 * web parity (per user screenshots):
 *   "Call declined"
 *   "No answer"
 *   "Outgoing call · 26s"
 *   "Incoming call · 1m 32s · Recorded"
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors } from '../../theme';
import { formatCallDuration } from '../../lib/chatFormat';

export function CallPill({ item, onPress, hasRecording, testID }: { item: any; onPress?: () => void; hasRecording?: boolean; testID?: string }) {
  const outcome = String(item?.outcome || '');
  const direction = item?.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const isVideo = item?.callType === 'video';
  const duration = formatCallDuration(Number(item?.durationSeconds || 0));
  const isMissed = outcome === 'missed';
  const isDeclined = outcome === 'declined';
  const isNegative = isMissed || isDeclined;

  let label = '';
  if (isMissed) {
    label = isVideo ? 'Missed video call' : 'Missed call';
  } else if (isDeclined) {
    label = isVideo ? 'Video call declined' : 'Call declined';
  } else if (outcome === 'completed') {
    const dirLabel = direction === 'outgoing' ? 'Outgoing' : 'Incoming';
    const typeLabel = isVideo ? 'video call' : 'call';
    label = duration ? `${dirLabel} ${typeLabel} \u00B7 ${duration}` : `${dirLabel} ${typeLabel}`;
  } else {
    label = isVideo ? 'No answer (video)' : 'No answer';
  }

  const iconName = isNegative
    ? 'phone-missed'
    : direction === 'outgoing'
      ? 'phone-outgoing'
      : 'phone-incoming';
  const iconColor = isNegative ? '#EF4444' : '#10B981';

  const Wrapper: any = onPress && hasRecording ? TouchableOpacity : View;
  const wrapperProps: any = onPress && hasRecording
    ? { onPress, activeOpacity: 0.7, accessibilityRole: 'button' as const }
    : {};
  return (
    <View style={callPillStyles.row} testID={testID}>
      <Wrapper
        {...wrapperProps}
        style={[
          callPillStyles.pill,
          isNegative ? callPillStyles.pillDanger : null,
        ]}
      >
        <MaterialCommunityIcons name={iconName as any} size={14} color={iconColor} />
        <Text
          style={[
            callPillStyles.text,
            isNegative ? callPillStyles.textDanger : null,
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
        {item?.wasRecorded ? (
          <View style={callPillStyles.recordedBadge}>
            <View style={callPillStyles.recordedDot} />
            <Text style={callPillStyles.recordedText}>Recorded</Text>
          </View>
        ) : null}
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
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(60, 40, 0, 0.06)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(60, 40, 0, 0.10)',
    maxWidth: '90%',
  },
  pillDanger: {
    backgroundColor: 'rgba(239, 68, 68, 0.10)',
    borderColor: 'rgba(239, 68, 68, 0.22)',
  },
  text: {
    fontSize: 13,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  textDanger: {
    color: '#B91C1C',
  },
  recordedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
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
