import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../theme';

/**
 * iter-325 CALL WAITING — an in-call banner shown when a SECOND call rings
 * while the user is already on an active call. It lets the user handle the
 * incoming call WITHOUT losing the ongoing one.
 *
 * Phase 1 (this build) wires the two actions that are safe on the published
 * single-call engine:
 *   • End & Accept  → hang up the current call, then answer the incoming one.
 *   • Decline       → reject the incoming call, keep talking on the current one.
 *
 * The two "Hold" options (hold current & accept / hold incoming) require a
 * dual-session call engine and land in Phase 2.
 */
export default function CallWaitingOverlay({
  callerName,
  isVideo,
  onEndAndAccept,
  onDecline,
}: {
  callerName: string;
  isVideo: boolean;
  onEndAndAccept: () => void;
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

        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.declineBtn]}
            activeOpacity={0.85}
            onPress={onDecline}
            testID="call-waiting-decline"
          >
            <Ionicons name="close" size={20} color={Colors.white} />
            <Text style={styles.actionLabel}>Decline</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionBtn, styles.acceptBtn]}
            activeOpacity={0.85}
            onPress={onEndAndAccept}
            testID="call-waiting-end-accept"
          >
            <MaterialCommunityIcons name="phone-check" size={20} color={Colors.white} />
            <Text style={styles.actionLabel}>End &amp; Accept</Text>
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
  actionsRow: { flexDirection: 'row', gap: 12, marginTop: Spacing.base },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: Radius.md,
    minHeight: 48,
  },
  declineBtn: { backgroundColor: Colors.danger },
  acceptBtn: { backgroundColor: Colors.success || '#2E7D32' },
  actionLabel: { color: Colors.white, fontSize: FontSize.base, fontWeight: FontWeight.bold },
});
