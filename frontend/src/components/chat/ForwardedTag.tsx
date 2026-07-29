import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { FontSize } from '../../theme';

/**
 * ForwardedTag — WhatsApp-style "Forwarded" indicator with the Smilers global
 * forward count ("FW<n>"). The backend owns the counting and returns
 * `isForwarded` + `forwardCount` on each message (see the forward-count
 * contract). We NEVER compute the number on the client — we only render it.
 *
 *   forwardCount > 0  → "↪ Forwarded · FW3"
 *   isForwarded only  → "↪ Forwarded"  (older copies, pre-count)
 *
 * Both sender and recipients see the same number. Renders nothing when the
 * message isn't a forward.
 */
export function ForwardedTag({
  msg,
  color = 'rgba(0,0,0,0.55)',
}: {
  msg: any;
  color?: string;
}) {
  if (!msg?.isForwarded) return null;
  const n = Number(msg?.forwardCount) || 0;
  return (
    <View style={styles.row} testID={`forwarded-tag-${msg?._id ?? ''}`}>
      <MaterialCommunityIcons name="share" size={12} color={color} style={styles.icon} />
      <Text style={[styles.label, { color }]}>Forwarded</Text>
      {n > 0 ? (
        <View style={[styles.pill, { borderColor: color }]}>
          <Text style={[styles.pillText, { color }]}>FW{n}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
  },
  icon: {
    marginRight: 4,
    transform: [{ scaleX: -1 }], // point the arrow like a "forward" chevron
  },
  label: {
    fontSize: FontSize.xs,
    fontStyle: 'italic',
    fontWeight: '600',
  },
  pill: {
    marginLeft: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pillText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
});

export default ForwardedTag;
