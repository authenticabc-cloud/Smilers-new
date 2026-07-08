/**
 * PaymentsAdmin — admin "Payments" tab. Segments between Premium subscription
 * requests and Ad-click requests, each rendered by the shared
 * PaymentRequestsPanel wired to its own Convex functions.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { api } from '../../convexApi';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../theme';
import { PaymentRequestsPanel, PaymentPanelConfig } from './PaymentRequestsPanel';
import { formatLocalAmount } from '../../lib/mobileMoney';

const premiumConfig: PaymentPanelConfig = {
  listPending: (api as any).mobileMoneyRequests?.listPendingRequests,
  listHistory: (api as any).mobileMoneyRequests?.listRequestHistory,
  complete: (api as any).mobileMoneyRequests?.completeRequest,
  decline: (api as any).mobileMoneyRequests?.declineRequest,
  messageUsers: (api as any).admin?.messaging?.messageUsers,
  emptyPending: 'No pending premium payment requests.',
  emptyHistory: 'No past premium requests yet.',
  itemTitle: (r) => r.planLabel || r.variantId || 'Premium',
  completeBody: (r) =>
    `This will close the request and automatically activate ${r.planLabel || 'the plan'} for ${r.userName || 'the user'}.`,
  messageTemplate: (r) =>
    `Hi ${r.userName || ''}, to complete your ${r.planLabel} plan payment of ${formatLocalAmount(r.amount, r.currency)}, please send mobile money to: `,
};

const adConfig: PaymentPanelConfig = {
  listPending: (api as any).adClickRequests?.listPendingRequests,
  listHistory: (api as any).adClickRequests?.listRequestHistory,
  complete: (api as any).adClickRequests?.completeRequest,
  decline: (api as any).adClickRequests?.declineRequest,
  messageUsers: (api as any).admin?.messaging?.messageUsers,
  emptyPending: 'No pending ad-click requests.',
  emptyHistory: 'No past ad-click requests yet.',
  itemTitle: (r) => `${r.adTitle || r.ad?.productName || 'Ad'} · ${r.clicks ?? r.quantity ?? 0} clicks`,
  completeBody: (r) =>
    `This will close the request and automatically credit ${r.clicks ?? r.quantity ?? 0} clicks to “${r.adTitle || r.ad?.productName || 'the ad'}” for ${r.userName || 'the user'}.`,
  messageTemplate: (r) =>
    `Hi ${r.userName || ''}, to complete your purchase of ${r.clicks ?? r.quantity} ad clicks (${formatLocalAmount(r.amount, r.currency)}), please send mobile money to: `,
};

export function PaymentsAdmin() {
  const [segment, setSegment] = useState<'premium' | 'ads'>('premium');
  return (
    <View>
      <View style={styles.segment}>
        <TouchableOpacity
          style={[styles.segBtn, segment === 'premium' ? styles.segBtnActive : null]}
          onPress={() => setSegment('premium')}
          testID="payments-seg-premium"
        >
          <Text style={[styles.segText, segment === 'premium' ? styles.segTextActive : null]}>Premium</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.segBtn, segment === 'ads' ? styles.segBtnActive : null]}
          onPress={() => setSegment('ads')}
          testID="payments-seg-ads"
        >
          <Text style={[styles.segText, segment === 'ads' ? styles.segTextActive : null]}>Ad Clicks</Text>
        </TouchableOpacity>
      </View>
      <PaymentRequestsPanel config={segment === 'premium' ? premiumConfig : adConfig} />
    </View>
  );
}

const styles = StyleSheet.create({
  segment: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
  },
  segBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
  },
  segBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  segText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textSecondary },
  segTextActive: { color: Colors.white },
});
