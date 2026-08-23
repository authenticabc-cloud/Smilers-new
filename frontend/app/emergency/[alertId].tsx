/**
 * Emergency Alert VIEWER — /emergency/<alertId>
 *
 * Opened when a trustee (or nearby user, for broadcast alerts) taps an
 * emergency push. The push carries `action_url = "/emergency/<alertId>"` and
 * `data.alertId`, so tapping routes here.
 *
 * Shows, all reactive via Convex live queries (no polling):
 *   1. The alerter's identity + live status (active / resolved) + quick-call.
 *   2. A live-updating map pin at the alerter's current location.
 *   3. Audio recordings the alerter's device uploads (~every 30s).
 *   4. Camera captures (photo / video) the alerter uploads.
 *
 * Backend contract (native-emergency-viewer-contract.json):
 *   - api.emergencyAlerts.getAlertForViewer({ alertId })       (reactive)
 *   - api.emergencyRecordings.getRecordingsForAlert({ alertId }) (reactive)
 *   - api.emergencyCaptures.getCapturesForAlert({ alertId })     (reactive)
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { markAlertOpened } from '../../src/lib/emergencyRead';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useMutation } from 'convex/react';

import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../src/theme';

interface AlertViewer {
  _id: string;
  userId?: string;
  latitude?: number;
  longitude?: number;
  triggeredAt?: string;
  status?: 'active' | 'resolved';
  broadcastEnabled?: boolean;
  broadcastRadius?: number;
  alerterName?: string;
  alerterAvatar?: string | null;
  alerterPhone?: string | null;
  resolvedByName?: string | null;
  resolvedByUserId?: string | null;
  resolvedAt?: string | null;
}

interface Recording {
  _id: string;
  storageId?: string;
  durationSeconds?: number;
  recordedAt?: string;
  url?: string;
}

interface Capture {
  _id: string;
  type?: 'photo' | 'video';
  durationSeconds?: number;
  capturedAt?: string;
  url?: string;
}

function formatDuration(sec?: number): string {
  if (!sec || !Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatClock(value?: string): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ────────────────────────────────────────────────────────────────────────
// Live map — Leaflet over OpenStreetMap in a WebView (no API key required).
// The marker is repositioned via injectJavaScript so the pin glides to the
// alerter's new coordinates without a jarring full reload.
// ────────────────────────────────────────────────────────────────────────

/** Great-circle distance between two lat/lng points, in metres. */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Human-friendly distance label ("120 m", "1.4 km", "23 km"). */
function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '';
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

function LiveMap({ latitude, longitude }: { latitude: number; longitude: number }) {
  const webRef = useRef<WebView>(null);

  const html = useMemo(
    () => `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>html,body,#map{height:100%;margin:0;padding:0;background:#F4F1E8}</style>
</head><body><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var map = L.map('map', { zoomControl: true, attributionControl: false }).setView([${latitude}, ${longitude}], 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  var marker = L.marker([${latitude}, ${longitude}]).addTo(map);
  var circle = L.circle([${latitude}, ${longitude}], { radius: 40, color: '#EF4444', fillColor: '#EF4444', fillOpacity: 0.25 }).addTo(map);
  window.updateMarker = function(lat, lng) {
    var ll = [lat, lng];
    marker.setLatLng(ll);
    circle.setLatLng(ll);
    map.panTo(ll, { animate: true });
  };
</script>
</body></html>`,
    // Only build the HTML once; subsequent moves go through injectJavaScript.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    webRef.current?.injectJavaScript(
      `if (window.updateMarker) { window.updateMarker(${latitude}, ${longitude}); } true;`,
    );
  }, [latitude, longitude]);

  return (
    <WebView
      ref={webRef}
      originWhitelist={['*']}
      source={{ html }}
      style={styles.map}
      scrollEnabled={false}
      javaScriptEnabled
      domStorageEnabled
    />
  );
}

// ────────────────────────────────────────────────────────────────────────
// Single audio recording row — its own useAudioPlayer instance.
// ────────────────────────────────────────────────────────────────────────
function AudioClip({ recording, index }: { recording: Recording; index: number }) {
  const player = useAudioPlayer(recording.url ? { uri: recording.url } : null);
  const status = useAudioPlayerStatus(player);
  const isPlaying = !!status?.playing;

  return (
    <View style={styles.clipRow}>
      <TouchableOpacity
        style={styles.clipPlayBtn}
        activeOpacity={0.8}
        disabled={!recording.url}
        onPress={() => {
          if (isPlaying) {
            player.pause();
          } else {
            try {
              player.seekTo(0);
            } catch {}
            player.play();
          }
        }}
        testID={`emergency-audio-${index}`}
      >
        <Ionicons name={isPlaying ? 'pause' : 'play'} size={20} color={Colors.white} />
      </TouchableOpacity>
      <View style={styles.clipMeta}>
        <Text style={styles.clipTitle}>Audio clip {index + 1}</Text>
        <Text style={styles.clipSub}>
          {formatClock(recording.recordedAt)}
          {recording.durationSeconds ? ` \u00B7 ${formatDuration(recording.durationSeconds)}` : ''}
        </Text>
      </View>
      <MaterialCommunityIcons name="waveform" size={22} color={Colors.textMuted} />
    </View>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Single camera capture (photo or video).
// ────────────────────────────────────────────────────────────────────────
function CaptureItem({ capture }: { capture: Capture }) {
  if (capture.type === 'video' && capture.url) {
    return <CaptureVideo url={capture.url} capturedAt={capture.capturedAt} />;
  }
  return (
    <View style={styles.captureCard}>
      {capture.url ? (
        <Image source={{ uri: capture.url }} style={styles.captureMedia} resizeMode="cover" />
      ) : (
        <View style={[styles.captureMedia, styles.captureUnavailable]}>
          <Feather name="image" size={22} color={Colors.textMuted} />
        </View>
      )}
      <Text style={styles.captureCaption}>{formatClock(capture.capturedAt)}</Text>
    </View>
  );
}

function CaptureVideo({ url, capturedAt }: { url: string; capturedAt?: string }) {
  const player = useVideoPlayer({ uri: url }, (p) => {
    p.loop = false;
  });
  useEffect(() => {
    return () => {
      try {
        player.pause();
      } catch {}
    };
  }, [player]);
  return (
    <View style={styles.captureCard}>
      <VideoView player={player} style={styles.captureMedia} contentFit="cover" nativeControls />
      <Text style={styles.captureCaption}>{`${formatClock(capturedAt)} \u00B7 Video`}</Text>
    </View>
  );
}

export default function EmergencyViewerScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ alertId?: string }>();
  const alertId = typeof params.alertId === 'string' ? params.alertId : '';

  // Mark this alert as opened so the Settings Emergency badge clears it, and
  // stop any remaining loud repeat notifications for it.
  useEffect(() => {
    if (!alertId) return;
    void markAlertOpened(alertId);
    import('../../src/push/emergencyAlertNotify')
      .then((m) => m.cancelEmergencyRepeats(alertId))
      .catch(() => {});
  }, [alertId]);

  const { data: alert, loading: alertLoading } = useSafeConvexQuery<AlertViewer | null>(
    api.emergencyAlerts.getAlertForViewer,
    { alertId },
    null,
    !!alertId,
  );
  const { data: recordings } = useSafeConvexQuery<Recording[]>(
    api.emergencyRecordings.getRecordingsForAlert,
    { alertId },
    [],
    !!alertId,
  );
  const { data: captures } = useSafeConvexQuery<Capture[]>(
    api.emergencyCaptures.getCapturesForAlert,
    { alertId },
    [],
    !!alertId,
  );

  const sortedRecordings = useMemo(
    () =>
      [...(recordings || [])].sort(
        (a, b) => new Date(a.recordedAt || 0).getTime() - new Date(b.recordedAt || 0).getTime(),
      ),
    [recordings],
  );
  const sortedCaptures = useMemo(
    () =>
      [...(captures || [])].sort(
        (a, b) => new Date(b.capturedAt || 0).getTime() - new Date(a.capturedAt || 0).getTime(),
      ),
    [captures],
  );

  const hasLocation =
    !!alert && typeof alert.latitude === 'number' && typeof alert.longitude === 'number';
  const isResolved = alert?.status === 'resolved';

  // How far the trustee is from the alerter. Recomputes as the alerter's live
  // location updates. Location permission is requested contextually (the user
  // opened an emergency to help); if denied we simply hide the distance.
  const [distanceLabel, setDistanceLabel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const lat = alert?.latitude;
    const lng = alert?.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      setDistanceLabel(null);
      return;
    }
    (async () => {
      try {
        const Location = await import('expo-location');
        let perm = await Location.getForegroundPermissionsAsync();
        if (!perm.granted && perm.canAskAgain) {
          perm = await Location.requestForegroundPermissionsAsync();
        }
        if (!perm.granted || cancelled) return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (cancelled) return;
        const meters = haversineMeters(pos.coords.latitude, pos.coords.longitude, lat, lng);
        setDistanceLabel(formatDistance(meters));
      } catch {
        /* ignore — distance is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [alert?.latitude, alert?.longitude]);

  const openInMaps = () => {
    if (!hasLocation) return;
    const { latitude, longitude } = alert!;
    const url = Platform.select({
      ios: `maps://?ll=${latitude},${longitude}`,
      default: `geo:${latitude},${longitude}?q=${latitude},${longitude}`,
    });
    Linking.openURL(url as string).catch(() =>
      Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`),
    );
  };

  const navigateToAlerter = () => {
    if (!hasLocation) return;
    const { latitude, longitude } = alert!;
    // Open turn-by-turn DIRECTIONS to the alerter's location.
    const url = Platform.select({
      ios: `maps://?daddr=${latitude},${longitude}&dirflg=d`,
      default: `google.navigation:q=${latitude},${longitude}`,
    });
    Linking.openURL(url as string).catch(() =>
      Linking.openURL(
        `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}&travelmode=driving`,
      ),
    );
  };

  const callAlerter = () => {
    if (alert?.alerterPhone) Linking.openURL(`tel:${alert.alerterPhone}`);
  };

  // "I've got this" — a trustee marks the alert resolved from the viewer. This
  // only flips the RECORD to resolved and notifies the alerter (backend does
  // NOT stop the alerter's device recording/broadcast — they end that
  // themselves). Backend contract: emergencyAlerts.resolveAlertByTrustee.
  const resolveByTrustee = useMutation((api as any).emergencyAlerts.resolveAlertByTrustee);
  const [resolving, setResolving] = useState(false);
  const doResolve = async () => {
    if (resolving || !alertId) return;
    setResolving(true);
    try {
      await resolveByTrustee({ alertId });
      // The reactive getAlertForViewer query flips status → resolved on its own.
    } catch {
      Alert.alert(
        'Could not update',
        'We couldn’t mark this as resolved right now. Please try again.',
      );
    } finally {
      setResolving(false);
    }
  };
  const confirmResolve = () => {
    Alert.alert(
      'Mark as resolved?',
      'This tells ' +
        (alert?.alerterName || 'them') +
        ' that you’ve got this. Their phone keeps sharing until they stop it themselves.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: "I've got this", style: 'default', onPress: () => void doResolve() },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="emergency-viewer-back">
          <Feather name="arrow-left" size={24} color={Colors.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Emergency Alert</Text>
        <View style={{ width: 24 }} />
      </View>

      {alertLoading && !alert ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.danger} />
          <Text style={styles.centeredText}>Loading alert…</Text>
        </View>
      ) : !alert ? (
        <View style={styles.centered}>
          <MaterialCommunityIcons name="shield-alert-outline" size={48} color={Colors.textMuted} />
          <Text style={styles.centeredTitle}>Alert unavailable</Text>
          <Text style={styles.centeredText}>
            This alert may have ended, or you don’t have access to view it.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {/* Alerter card */}
          <View style={styles.card}>
            <View style={styles.alerterRow}>
              {alert.alerterAvatar ? (
                <Image source={{ uri: alert.alerterAvatar }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <Text style={styles.avatarInitial}>
                    {(alert.alerterName || '?').trim().charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.alerterName} numberOfLines={1}>
                  {alert.alerterName || 'Smilers user'}
                </Text>
                <View style={styles.statusRow}>
                  <View
                    style={[
                      styles.statusDot,
                      { backgroundColor: isResolved ? Colors.textMuted : Colors.danger },
                    ]}
                  />
                  <Text
                    style={[styles.statusText, { color: isResolved ? Colors.textSecondary : Colors.danger }]}
                  >
                    {isResolved ? 'Resolved' : 'Active emergency'}
                  </Text>
                  {alert.triggeredAt ? (
                    <Text style={styles.statusTime}> · {formatClock(alert.triggeredAt)}</Text>
                  ) : null}
                </View>
              </View>
              {alert.alerterPhone ? (
                <TouchableOpacity style={styles.callBtn} onPress={callAlerter} testID="emergency-call">
                  <Feather name="phone" size={18} color={Colors.white} />
                </TouchableOpacity>
              ) : null}
            </View>

            {isResolved && alert.resolvedByName ? (
              <View style={styles.resolvedByRow} testID="emergency-resolved-by">
                <Feather name="check-circle" size={14} color={Colors.success} />
                <Text style={styles.resolvedByText}>Resolved by {alert.resolvedByName}</Text>
              </View>
            ) : null}

            {!isResolved ? (
              <TouchableOpacity
                style={styles.resolveBtn}
                onPress={confirmResolve}
                disabled={resolving}
                activeOpacity={0.85}
                testID="emergency-resolve"
              >
                {resolving ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <Feather name="check-circle" size={16} color={Colors.white} />
                )}
                <Text style={styles.resolveBtnText}>
                  {resolving ? 'Marking resolved…' : "I've got this — mark resolved"}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {/* Live location */}
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Live location</Text>
            {hasLocation ? (
              <TouchableOpacity onPress={openInMaps} testID="emergency-open-maps">
                <Text style={styles.linkText}>Open in Maps</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.mapCard}>
            {hasLocation ? (
              <LiveMap latitude={alert.latitude!} longitude={alert.longitude!} />
            ) : (
              <View style={[styles.map, styles.captureUnavailable]}>
                <Feather name="map-pin" size={24} color={Colors.textMuted} />
                <Text style={styles.centeredText}>Location not available yet</Text>
              </View>
            )}
          </View>
          {hasLocation && distanceLabel ? (
            <View style={styles.distanceRow} testID="emergency-distance">
              <Feather name="navigation" size={13} color={Colors.primary} />
              <Text style={styles.distanceText}>{distanceLabel} away from you</Text>
            </View>
          ) : null}
          {hasLocation ? (
            <TouchableOpacity style={styles.navigateBtn} onPress={navigateToAlerter} testID="emergency-navigate">
              <Feather name="navigation-2" size={16} color={Colors.white} />
              <Text style={styles.navigateBtnText}>Navigate to them</Text>
            </TouchableOpacity>
          ) : null}

          {/* Audio recordings */}
          <Text style={styles.sectionTitle}>Audio recordings</Text>
          {sortedRecordings.length === 0 ? (
            <Text style={styles.emptyText}>No audio recordings yet.</Text>
          ) : (
            <View style={styles.card}>
              {sortedRecordings.map((rec, i) => (
                <AudioClip key={rec._id} recording={rec} index={i} />
              ))}
            </View>
          )}

          {/* Camera captures */}
          <Text style={styles.sectionTitle}>Camera captures</Text>
          {sortedCaptures.length === 0 ? (
            <Text style={styles.emptyText}>No photos or videos yet.</Text>
          ) : (
            <View style={styles.captureGrid}>
              {sortedCaptures.map((cap) => (
                <CaptureItem key={cap._id} capture={cap} />
              ))}
            </View>
          )}

          <View style={{ height: Spacing.xl }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.danger,
  },
  headerTitle: { color: Colors.white, fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl, gap: Spacing.sm },
  centeredTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  centeredText: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  scroll: { padding: Spacing.base, gap: Spacing.md },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    ...Shadow.sm,
  },
  alerterRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: Colors.borderLight },
  avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary },
  avatarInitial: { color: Colors.white, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  alerterName: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  statusTime: { fontSize: FontSize.sm, color: Colors.textSecondary },
  callBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resolvedByRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: Spacing.md,
  },
  resolvedByText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: Colors.success },
  resolveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: Spacing.md,
    paddingVertical: 12,
    borderRadius: Radius.md,
    backgroundColor: Colors.success,
  },
  resolveBtnText: { fontSize: 15, fontWeight: '700', color: Colors.white },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    marginTop: Spacing.xs,
  },
  linkText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: Colors.primaryDark },
  mapCard: { borderRadius: Radius.lg, overflow: 'hidden', backgroundColor: Colors.surface, ...Shadow.sm },
  distanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    marginLeft: 2,
  },
  distanceText: { fontSize: 13, fontWeight: '600', color: Colors.primary },
  navigateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 10,
    paddingVertical: 12,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
  },
  navigateBtnText: { fontSize: 15, fontWeight: '700', color: Colors.white },
  map: { width: '100%', height: 240, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm },
  clipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderLight,
  },
  clipPlayBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clipMeta: { flex: 1 },
  clipTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: Colors.textPrimary },
  clipSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  emptyText: { fontSize: FontSize.sm, color: Colors.textMuted, paddingVertical: Spacing.xs },
  captureGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  captureCard: {
    width: '48%',
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    overflow: 'hidden',
    ...Shadow.sm,
  },
  captureMedia: { width: '100%', height: 140, backgroundColor: Colors.borderLight },
  captureUnavailable: { alignItems: 'center', justifyContent: 'center', gap: Spacing.xs },
  captureCaption: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    padding: Spacing.sm,
  },
});
