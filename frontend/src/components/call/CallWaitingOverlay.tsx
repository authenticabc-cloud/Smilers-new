import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../theme';

/**
 * iter-325/327 CALL WAITING — an in-call banner shown when a SECOND call rings
 * while the user is already on an active call. Offers the 4 options without
 * losing the ongoing call:
 *   (a) End & Accept     → hang up current, answer incoming
 *   (b) Hold & Accept    → hold current (media), answer incoming (foreground)
 *   (c) Decline          → reject incoming, keep current
 *   (d) Hold incoming    → answer incoming but keep it held; stay on current
 */
export default function CallWaitingOverlay({
  callerName,
  isVideo,
  onEndAndAccept,
  onHoldAndAccept,
  onHoldIncoming,
  onDecline,
}: {
  callerName: string;
  isVideo: boolean;
  onEndAndAccept: () => void;
  onHoldAndAccept: () => void;
  onHoldIncoming: () => void;
  onDecline: () => void;
}) {
  return (
    <View style={styles.wrap} pointerEvents="box-none" testID="call-waiting-overlay">
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <View style={styles.iconBadge}>
            <MaterialCommunityIcons
              name={isVideo ? 'video' : 'phone-incoming'}
              size={18}
              color={Colors.white}
            />
          </View>
          <View style={styles.flexOne}>
            <Text style={styles.title}>Incoming call</Text>
            <Text style={styles.name} numberOfLines={1}>
              {callerName || 'Smilers user'}
            </Text>
          </View>
        </View>

        <View style={styles.grid}>
          <TouchableOpacity
            style={[styles.gridBtn, styles.acceptBtn]}
            activeOpacity={0.85}
            onPress={onHoldAndAccept}
            testID="call-waiting-hold-accept"
          >
            <MaterialCommunityIcons name="phone-paused" size={18} color={Colors.white} />
            <Text style={styles.gridLabel}>Hold &amp; Accept</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.gridBtn, styles.holdBtn]}
            activeOpacity={0.85}
            onPress={onHoldIncoming}
            testID="call-waiting-hold-incoming"
          >
            <MaterialCommunityIcons name="pause-circle" size={18} color={Colors.white} />
            <Text style={styles.gridLabel}>Hold incoming</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.gridBtn, styles.endAcceptBtn]}
            activeOpacity={0.85}
            onPress={onEndAndAccept}
            testID="call-waiting-end-accept"
          >
            <MaterialCommunityIcons name="phone-check" size={18} color={Colors.white} />
            <Text style={styles.gridLabel}>End &amp; Accept</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.gridBtn, styles.declineBtn]}
            activeOpacity={0.85}
            onPress={onDecline}
            testID="call-waiting-decline"
          >
            <Ionicons name="close" size={18} color={Colors.white} />
            <Text style={styles.gridLabel}>Decline</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingTop: Spacing.xl,
    paddingHorizontal: Spacing.base,
  },
  card: {
    width: '100%',
    maxWidth: 520,
    backgroundColor: 'rgba(20,20,24,0.94)',
    borderRadius: Radius.lg,
    padding: Spacing.base,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flexOne: { flex: 1 },
  title: { color: 'rgba(255,255,255,0.7)', fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  name: { color: Colors.white, fontSize: FontSize.lg, fontWeight: FontWeight.bold, marginTop: 2 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: Spacing.base,
  },
  gridBtn: {
    flexGrow: 1,
    flexBasis: '46%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: Radius.md,
    minHeight: 48,
  },
  acceptBtn: { backgroundColor: Colors.success || '#2E7D32' },
  holdBtn: { backgroundColor: '#4B5563' },
  endAcceptBtn: { backgroundColor: '#2563EB' },
  declineBtn: { backgroundColor: Colors.danger },
  gridLabel: { color: Colors.white, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
});
