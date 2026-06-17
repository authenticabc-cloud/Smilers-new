/**
 * LiveLocationRequestBanner — receiver-side live-location request flow.
 *
 * When a contact requests your live location (web canonical
 * `api.locationRequests.getIncomingRequests`), this surfaces a tappable
 * banner. Tapping it opens a confirmation dialog ("Share your live
 * location?") with a 15 / 30 / 60-minute selector. Only when the user
 * presses "Send my live location" do we capture the current position and
 * call `api.locationRequests.respondToRequest` with
 * `{ requestId, accept: true, latitude, longitude, durationMinutes }`.
 *
 * The quick X on the banner declines the request
 * (`respondToRequest({ requestId, accept: false })`).
 *
 * Mounted in two places (user requested "both"):
 *   • Chats tab — global banner (no `conversationId` → any incoming request)
 *   • Chat screen — scoped banner (filters to the open `conversationId`)
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useMutation } from 'convex/react';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';
import { useSafeConvexQuery } from '../hooks/useSafeConvexQuery';
import { errorToMessage } from '../lib/safeString';
import { Colors, FontSize, FontWeight, Radius, Shadow } from '../theme';

const EMPTY: any[] = [];
const DURATIONS = [15, 30, 60];

const requesterName = (row: any): string =>
  row?.requesterName ||
  row?.fromName ||
  row?.senderName ||
  row?.requesterDisplayName ||
  row?.fromDisplayName ||
  'A contact';

const requestId = (row: any): any => row?._id || row?.requestId || row?.id;

type Props = { conversationId?: string };

export function LiveLocationRequestBanner({ conversationId }: Props) {
  const { isAuthenticated } = useAuth();
  const respondToRequest = useMutation((api as any).locationRequests.respondToRequest);
  const { data } = useSafeConvexQuery<any[]>(
    (api as any).locationRequests.getIncomingRequests,
    {},
    EMPTY,
    isAuthenticated,
  );

  const now = Date.now();
  const list = (Array.isArray(data) ? data : EMPTY).filter((row: any) => {
    if (!requestId(row)) return false;
    if (row?.expiresAt && Number(row.expiresAt) < now) return false;
    if (row?.status && String(row.status) !== 'pending') return false;
    if (conversationId && String(row?.conversationId) !== String(conversationId)) return false;
    return true;
  });

  const [active, setActive] = useState<any | null>(null);
  const [duration, setDuration] = useState(30);
  const [sending, setSending] = useState(false);

  const openConfirm = useCallback((row: any) => {
    setActive(row);
    const preset = Number(row?.durationMinutes);
    setDuration(DURATIONS.includes(preset) ? preset : 30);
  }, []);

  const closeConfirm = useCallback(() => {
    if (!sending) setActive(null);
  }, [sending]);

  const decline = useCallback(
    async (row: any) => {
      try {
        await respondToRequest({ requestId: requestId(row), accept: false });
      } catch {
        // Best-effort: declining a request that already expired is harmless.
      }
      setActive(null);
    },
    [respondToRequest],
  );

  const confirmShare = useCallback(async () => {
    if (!active) return;
    setSending(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission needed', 'Allow location access to share your live location.');
        setSending(false);
        return;
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      await respondToRequest({
        requestId: requestId(active),
        accept: true,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        durationMinutes: duration,
      });
      setActive(null);
    } catch (errorValue: any) {
      Alert.alert('Could not share location', errorToMessage(errorValue) || 'Please try again.');
    } finally {
      setSending(false);
    }
  }, [active, duration, respondToRequest]);

  if (list.length === 0 && !active) return null;
  const first = list[0];

  return (
    <>
      {first ? (
        <View style={styles.banner}>
          <TouchableOpacity
            style={styles.bannerMain}
            onPress={() => openConfirm(first)}
            activeOpacity={0.85}
            testID="live-location-request-banner"
          >
            <View style={styles.iconWrap}>
              <MaterialCommunityIcons name="map-marker-radius" size={20} color={Colors.headerBg} />
            </View>
            <View style={styles.flexOne}>
              <Text style={styles.title} testID="live-location-request-title">
                Live location requested
              </Text>
              <Text style={styles.sub} numberOfLines={1}>
                {requesterName(first)} wants your live location — tap to share
              </Text>
            </View>
            <Feather name="chevron-right" size={20} color={Colors.warningDark} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.dismissBtn}
            onPress={() => decline(first)}
            testID="live-location-request-decline"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Feather name="x" size={18} color={Colors.warningDark} />
          </TouchableOpacity>
        </View>
      ) : null}

      <Modal visible={!!active} transparent animationType="fade" onRequestClose={closeConfirm}>
        <Pressable style={styles.backdrop} onPress={closeConfirm}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetIconWrap}>
              <MaterialCommunityIcons name="map-marker-radius" size={28} color={Colors.headerBg} />
            </View>
            <Text style={styles.sheetTitle} testID="live-location-confirm-title">
              Share your live location?
            </Text>
            <Text style={styles.sheetBody}>
              {active ? requesterName(active) : ''} will be able to see your live location for the
              selected duration.
            </Text>

            <View style={styles.durationRow}>
              {DURATIONS.map((d) => {
                const selected = duration === d;
                return (
                  <TouchableOpacity
                    key={d}
                    style={[styles.durationChip, selected && styles.durationChipActive]}
                    onPress={() => setDuration(d)}
                    testID={`live-location-duration-${d}`}
                  >
                    <Text style={[styles.durationText, selected && styles.durationTextActive]}>
                      {d} min
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity
              style={[styles.confirmBtn, sending && styles.confirmBtnDisabled]}
              onPress={confirmShare}
              disabled={sending}
              testID="live-location-confirm-send"
            >
              {sending ? (
                <ActivityIndicator color={Colors.headerBg} />
              ) : (
                <>
                  <MaterialCommunityIcons name="send" size={16} color={Colors.headerBg} />
                  <Text style={styles.confirmText}>Send my live location</Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={closeConfirm}
              disabled={sending}
              testID="live-location-cancel"
            >
              <Text style={styles.cancelText}>Not now</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  flexOne: { flex: 1 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.primaryLight,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: '#FCD34D',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    ...Shadow.sm,
  },
  bannerMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#FDE68A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.warningDark },
  sub: { fontSize: FontSize.xs, color: '#B45309', marginTop: 1 },
  dismissBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  sheet: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl,
    padding: 22,
    alignItems: 'center',
    ...Shadow.lg,
  },
  sheetIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  sheetTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  sheetBody: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  durationRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
    marginBottom: 4,
    alignSelf: 'stretch',
    justifyContent: 'center',
  },
  durationChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
    alignItems: 'center',
  },
  durationChipActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  durationText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: Colors.textSecondary },
  durationTextActive: { color: Colors.warningDark, fontWeight: FontWeight.bold },
  confirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    alignSelf: 'stretch',
    backgroundColor: Colors.primary,
    paddingVertical: 13,
    borderRadius: Radius.pill,
    marginTop: 20,
  },
  confirmBtnDisabled: { opacity: 0.7 },
  confirmText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.headerBg },
  cancelBtn: { paddingVertical: 12, marginTop: 4 },
  cancelText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: Colors.textSecondary },
});
