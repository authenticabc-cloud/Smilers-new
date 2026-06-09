/**
 * Emergency Screen — web-parity rebuild
 *
 * Sections:
 *  1. Big red SOS button (tap to trigger / resolve)
 *  2. Trustees count + nearby Smilers users info
 *  3. Panic Mode card — toggle + Pair Device + Trigger / Sustained / Cooldown sliders
 *  4. "How Panic Mode works" pink info callout
 *  5. Emergency Broadcast card — toggle + Radius slider + info text
 *  6. Past Alerts list
 *
 * Backend (all safe-fallback):
 *  - api.emergencyAlerts.{ triggerAlert, resolveAlert, getActiveAlert, getMyAlerts }
 *  - api.trustees.getMyTrustees
 *  - api.panicMode.{ getSettings, updateSettings }
 *  - api.emergencyBroadcast.{ getSettings, updateSettings }
 *  - api.bluetoothDevices.{ getPaired, openPairing }  (stubbed Alert if not deployed)
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import { useMutation } from 'convex/react';
import * as Location from 'expo-location';
import {
  type BleDeviceInfo,
  autoReconnect,
  connectAndSubscribe,
  getBleLoadError,
  scanForDevices,
  setPanicPressListener,
  stopScan,
  unpair,
} from '../src/lib/bleManager';

import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import PremiumGate from '../src/components/PremiumGate';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../src/theme';

interface PanicSettings {
  enabled?: boolean;
  triggerBpm?: number;
  sustainedSeconds?: number;
  cooldownMinutes?: number;
  pairedDeviceName?: string | null;
  pairedDeviceId?: string | null;
}

interface BroadcastSettings {
  enabled?: boolean;
  radiusKm?: number;
}

interface AlertItem {
  _id: string;
  resolvedAt?: string | null;
  triggeredAt?: string;
  _creationTime?: number;
  source?: string;
  lat?: number;
  lng?: number;
}

const TRIGGER_MIN = 100;
const TRIGGER_MAX = 180;
const SUSTAINED_MIN = 5;
const SUSTAINED_MAX = 30;
const COOLDOWN_MIN = 1;
const COOLDOWN_MAX = 30;
const RADIUS_MIN = 0.5;
const RADIUS_MAX = 10;

function timeAgo(iso?: string | number | null): string {
  if (!iso) return '';
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const diff = Date.now() - ms;
  const day = 24 * 60 * 60 * 1000;
  const days = Math.floor(diff / day);
  if (days <= 0) {
    const hours = Math.floor(diff / (60 * 60 * 1000));
    if (hours <= 0) return 'just now';
    return `${hours}h ago`;
  }
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

export default function EmergencyScreen() {
  return (
    <PremiumGate featureName="Emergency Features">
      <EmergencyScreenInner />
    </PremiumGate>
  );
}

function EmergencyScreenInner() {
  const router = useRouter();

  // ---------- Data ----------
  const { data: activeAlert, refetch: refetchActive } = useSafeConvexQuery<any | null>(
    (api as any).emergencyAlerts.getActiveAlert,
    {},
    null,
  );
  const { data: alerts, refetch: refetchAlerts } = useSafeConvexQuery<AlertItem[]>(
    (api as any).emergencyAlerts.getMyAlerts,
    {},
    [],
  );
  const { data: trustees } = useSafeConvexQuery<any[]>((api as any).trustees.getMyTrustees, {}, []);
  const { data: panicRemote } = useSafeConvexQuery<PanicSettings | null>(
    (api as any).panicMode.getSettings,
    {},
    null,
  );
  const { data: broadcastRemote } = useSafeConvexQuery<BroadcastSettings | null>(
    (api as any).emergencyBroadcast.getSettings,
    {},
    null,
  );

  const triggerAlert = useMutation((api as any).emergencyAlerts.triggerAlert);
  const resolveAlert = useMutation((api as any).emergencyAlerts.resolveAlert);
  const updatePanic = useMutation((api as any).panicMode.updateSettings);
  const updateBroadcast = useMutation((api as any).emergencyBroadcast.updateSettings);

  // ---------- Local mirror of settings (so sliders feel snappy) ----------
  const [panic, setPanic] = useState<PanicSettings>({
    enabled: true,
    triggerBpm: 130,
    sustainedSeconds: 10,
    cooldownMinutes: 20,
    pairedDeviceName: null,
    pairedDeviceId: null,
  });
  const [broadcast, setBroadcast] = useState<BroadcastSettings>({ enabled: true, radiusKm: 10 });

  useEffect(() => {
    if (!panicRemote) return;
    setPanic((p) => ({
      enabled: panicRemote.enabled ?? p.enabled,
      triggerBpm: panicRemote.triggerBpm ?? p.triggerBpm,
      sustainedSeconds: panicRemote.sustainedSeconds ?? p.sustainedSeconds,
      cooldownMinutes: panicRemote.cooldownMinutes ?? p.cooldownMinutes,
      pairedDeviceName: panicRemote.pairedDeviceName ?? null,
      pairedDeviceId: panicRemote.pairedDeviceId ?? null,
    }));
  }, [panicRemote]);

  useEffect(() => {
    if (!broadcastRemote) return;
    setBroadcast((b) => ({
      enabled: broadcastRemote.enabled ?? b.enabled,
      radiusKm: broadcastRemote.radiusKm ?? b.radiusKm,
    }));
  }, [broadcastRemote]);

  // ---------- Busy flags ----------
  const [busy, setBusy] = useState(false);

  const trusteeCount = (trustees || []).length;
  const pastAlerts = useMemo(() => {
    return (alerts || []).filter((a) => a?.resolvedAt || a?._creationTime).slice(0, 25);
  }, [alerts]);

  // ---------- Handlers ----------
  const onTriggerSOS = useCallback(() => {
    Alert.alert(
      'Trigger SOS?',
      `${trusteeCount} trustee${trusteeCount === 1 ? '' : 's'} will be notified${
        broadcast.enabled ? ` + nearby Smilers users within ${broadcast.radiusKm}km` : ''
      }.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'TRIGGER',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              // iter-137: canonical contract → triggerAlert needs
              // { latitude, longitude }. Capture coords here. We fall
              // back to (0,0) only if the user explicitly refuses
              // permission — server still broadcasts to trustees in
              // that case, just without geo-aware nearby fan-out.
              let latitude = 0;
              let longitude = 0;
              try {
                const perm = await Location.requestForegroundPermissionsAsync();
                if (perm.granted) {
                  const position = await Location.getCurrentPositionAsync({
                    accuracy: Location.Accuracy.Balanced,
                  });
                  latitude = position.coords.latitude;
                  longitude = position.coords.longitude;
                }
              } catch {
                /* swallow — geolocation is best-effort for SOS */
              }
              await triggerAlert({ latitude, longitude });
              await Promise.all([refetchActive(), refetchAlerts()]);
              Alert.alert('SOS sent', 'Your trustees have been notified.');
            } catch (e: any) {
              Alert.alert('Failed to send SOS', e?.message || 'Please try again.');
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, [broadcast.enabled, broadcast.radiusKm, refetchActive, refetchAlerts, triggerAlert, trusteeCount]);

  const onResolveSOS = useCallback(async () => {
    if (!activeAlert?._id) return;
    setBusy(true);
    try {
      await resolveAlert({ alertId: activeAlert._id });
      await Promise.all([refetchActive(), refetchAlerts()]);
      Alert.alert("I'm safe", 'Your alert has been resolved.');
    } catch (e: any) {
      Alert.alert('Could not resolve alert', e?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [activeAlert, refetchActive, refetchAlerts, resolveAlert]);

  const savePanic = useCallback(
    async (patch: Partial<PanicSettings>) => {
      const next = { ...panic, ...patch };
      setPanic(next);
      try {
        await updatePanic(next);
      } catch (e: any) {
        const message = String(e?.message || '');
        if (!message.includes('CouldNotFindFunction') && !message.includes('not found')) {
          console.warn('[emergency] panic save failed', message);
        }
      }
    },
    [panic, updatePanic],
  );

  const saveBroadcast = useCallback(
    async (patch: Partial<BroadcastSettings>) => {
      const next = { ...broadcast, ...patch };
      setBroadcast(next);
      try {
        await updateBroadcast(next);
      } catch (e: any) {
        const message = String(e?.message || '');
        if (!message.includes('CouldNotFindFunction') && !message.includes('not found')) {
          console.warn('[emergency] broadcast save failed', message);
        }
      }
    },
    [broadcast, updateBroadcast],
  );

  // iter-146: real BLE pairing flow. Replaces the previous "Use
  // Simulated Device" stub. Opens an in-app picker that scans for
  // nearby BLE peripherals, connects + subscribes to notifying
  // characteristics, persists the device id for auto-reconnect on
  // every launch, and routes panic-press notifications to the same
  // `triggerAlert` mutation the SOS button uses. Permissions are
  // requested on-demand inside `scanForDevices`.
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanResults, setScanResults] = useState<BleDeviceInfo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const startScan = useCallback(async () => {
    setScanError(null);
    setScanResults([]);
    const loadErr = getBleLoadError();
    if (loadErr) {
      setScanError(loadErr);
      return;
    }
    setScanning(true);
    try {
      await scanForDevices(
        (device) => {
          setScanResults((current) => {
            // Merge by id, keep highest RSSI first.
            const next = current.filter((existing) => existing.id !== device.id);
            next.push(device);
            next.sort((a, b) => (b.rssi || -200) - (a.rssi || -200));
            return next;
          });
        },
        10_000,
      );
    } catch (errorValue: any) {
      setScanError(errorValue?.message || 'Scan failed.');
    } finally {
      setScanning(false);
    }
  }, []);

  const pickDevice = useCallback(
    async (device: BleDeviceInfo) => {
      try {
        stopScan();
        setScanning(false);
        await connectAndSubscribe(device.id, device.name);
        await savePanic({
          pairedDeviceName: device.name || 'Unknown device',
          pairedDeviceId: device.id,
        });
        setPickerOpen(false);
        Alert.alert(
          'Paired',
          `${device.name || 'Device'} is now linked to Smilers and will auto-reconnect on every launch.`,
        );
      } catch (errorValue: any) {
        Alert.alert('Could not pair', errorValue?.message || 'Try again.');
      }
    },
    [savePanic],
  );

  // iter-146: auto-reconnect to the previously paired BLE device on
  // every screen mount. Best-effort — silent on failure.
  useEffect(() => {
    void autoReconnect();
  }, []);

  const onPairDevice = useCallback(() => {
    if (panic.pairedDeviceId) {
      Alert.alert(
        'Paired device',
        `${panic.pairedDeviceName || 'Device'} is currently linked. Unpair it?`,
        [
          { text: 'Keep paired', style: 'cancel' },
          {
            text: 'Unpair',
            style: 'destructive',
            onPress: async () => {
              try {
                await unpair();
              } catch {}
              await savePanic({ pairedDeviceName: null, pairedDeviceId: null });
            },
          },
        ],
      );
      return;
    }
    setPickerOpen(true);
    void startScan();
  }, [panic.pairedDeviceId, panic.pairedDeviceName, savePanic, startScan]);

  // Route any panic press from the paired BLE device through the same
  // `triggerAlert` flow as the on-screen SOS button.
  useEffect(() => {
    setPanicPressListener(() => {
      void (async () => {
        try {
          let latitude = 0;
          let longitude = 0;
          try {
            const perm = await Location.requestForegroundPermissionsAsync();
            if (perm.granted) {
              const position = await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy.Balanced,
              });
              latitude = position.coords.latitude;
              longitude = position.coords.longitude;
            }
          } catch {}
          await triggerAlert({ latitude, longitude });
          await Promise.all([refetchActive(), refetchAlerts()]);
        } catch (errorValue: any) {
          console.warn('[ble] panic trigger failed:', errorValue?.message);
        }
      })();
    });
    return () => setPanicPressListener(null);
  }, [triggerAlert, refetchActive, refetchAlerts]);

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="emergency-screen">
      {/* Red header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="emergency-back">
          <Ionicons name="arrow-back" size={26} color={Colors.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Emergency</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* SOS button */}
        <View style={styles.sosWrap}>
          <TouchableOpacity
            style={[styles.sosBtn, activeAlert ? styles.sosBtnActive : null]}
            onPress={activeAlert ? onResolveSOS : onTriggerSOS}
            disabled={busy}
            activeOpacity={0.85}
            testID="emergency-sos-btn"
          >
            {busy ? (
              <ActivityIndicator size="large" color={Colors.white} />
            ) : activeAlert ? (
              <>
                <Feather name="check" size={48} color={Colors.white} />
                <Text style={styles.sosLabel}>I&apos;M SAFE</Text>
              </>
            ) : (
              <>
                <MaterialCommunityIcons name="alarm-light" size={56} color={Colors.white} />
                <Text style={styles.sosLabel}>SOS</Text>
              </>
            )}
          </TouchableOpacity>
          <Text style={styles.sosHint}>
            {activeAlert ? 'Tap to resolve the active alert' : 'Tap the button to send an emergency alert'}
          </Text>
          <Text style={styles.sosSubHint}>
            {trusteeCount > 0
              ? `${trusteeCount} trustee${trusteeCount === 1 ? '' : 's'} will be notified`
              : 'No trustees yet — add some in Settings'}
            {broadcast.enabled ? ' + nearby Smilers users' : ''}
          </Text>
        </View>

        {/* Panic Mode card */}
        <View style={styles.card} testID="emergency-panic-card">
          <View style={styles.cardHeaderRow}>
            <View style={[styles.cardIconWrap, { backgroundColor: '#FFE4E6' }]}>
              <MaterialCommunityIcons name="heart-pulse" size={22} color={Colors.danger} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Panic Mode</Text>
              <Text style={styles.cardSubtitle}>Auto-alert when heart rate spikes from panic or shock</Text>
            </View>
            <Switch
              value={!!panic.enabled}
              onValueChange={(v) => savePanic({ enabled: v })}
              trackColor={{ false: '#E5E7EB', true: Colors.primary }}
              thumbColor={Colors.white}
              testID="emergency-panic-toggle"
            />
          </View>

          {panic.enabled ? (
            <>
              {/* Pair device row */}
              <TouchableOpacity style={styles.pairRow} onPress={onPairDevice} testID="emergency-pair-btn">
                <View style={styles.pairLeft}>
                  <Feather
                    name="bluetooth"
                    size={18}
                    color={panic.pairedDeviceId ? Colors.primary : Colors.textMuted}
                  />
                  <Text style={styles.pairText} numberOfLines={1}>
                    {panic.pairedDeviceName || 'No device connected'}
                  </Text>
                </View>
                <View style={[styles.pairBtn, panic.pairedDeviceId ? styles.pairBtnConnected : null]}>
                  <Feather name="bluetooth" size={14} color={Colors.headerBg} />
                  <Text style={styles.pairBtnText}>{panic.pairedDeviceId ? 'Connected' : 'Pair Device'}</Text>
                </View>
              </TouchableOpacity>

              {/* Trigger Threshold */}
              <SettingSlider
                icon="flash"
                iconColor={Colors.danger}
                label="Trigger Threshold"
                value={`${panic.triggerBpm ?? 130} BPM`}
                valueColor={Colors.danger}
                min={TRIGGER_MIN}
                max={TRIGGER_MAX}
                step={5}
                current={panic.triggerBpm ?? 130}
                onChange={(v) => setPanic((p) => ({ ...p, triggerBpm: Math.round(v) }))}
                onCommit={(v) => savePanic({ triggerBpm: Math.round(v) })}
                minLabel={`${TRIGGER_MIN}`}
                maxLabel={`${TRIGGER_MAX}`}
                testID="emergency-trigger-slider"
              />

              {/* Sustained Duration */}
              <SettingSlider
                icon="time-outline"
                iconColor={Colors.primary}
                label="Sustained Duration"
                value={`${panic.sustainedSeconds ?? 10}s`}
                valueColor={Colors.primary}
                min={SUSTAINED_MIN}
                max={SUSTAINED_MAX}
                step={1}
                current={panic.sustainedSeconds ?? 10}
                onChange={(v) => setPanic((p) => ({ ...p, sustainedSeconds: Math.round(v) }))}
                onCommit={(v) => savePanic({ sustainedSeconds: Math.round(v) })}
                minLabel={`${SUSTAINED_MIN}s`}
                maxLabel={`${SUSTAINED_MAX}s`}
                testID="emergency-sustained-slider"
              />

              {/* Cooldown */}
              <SettingSlider
                icon="shield-checkmark-outline"
                iconColor={Colors.info}
                label="Cooldown Between Alerts"
                value={`${panic.cooldownMinutes ?? 20} min`}
                valueColor={Colors.info}
                min={COOLDOWN_MIN}
                max={COOLDOWN_MAX}
                step={1}
                current={panic.cooldownMinutes ?? 20}
                onChange={(v) => setPanic((p) => ({ ...p, cooldownMinutes: Math.round(v) }))}
                onCommit={(v) => savePanic({ cooldownMinutes: Math.round(v) })}
                minLabel={`${COOLDOWN_MIN} min`}
                maxLabel={`${COOLDOWN_MAX} min`}
                testID="emergency-cooldown-slider"
              />
            </>
          ) : null}
        </View>

        {/* How Panic Mode works */}
        {panic.enabled ? (
          <View style={styles.howCard} testID="emergency-how-card">
            <Text style={styles.howTitle}>How Panic Mode works</Text>
            <HowStep n={1} text="Pair your Bluetooth heart rate monitor (fitness band, smartwatch, chest strap)" />
            <HowStep
              n={2}
              text={`If your heart rate stays above ${panic.triggerBpm ?? 130} BPM for ${panic.sustainedSeconds ?? 10} seconds, an alert triggers`}
            />
            <HowStep n={3} text="Your trustees get an emergency notification with your live location" />
          </View>
        ) : null}

        {/* Emergency Broadcast card */}
        <View style={styles.card} testID="emergency-broadcast-card">
          <View style={styles.cardHeaderRow}>
            <View style={[styles.cardIconWrap, { backgroundColor: Colors.primaryLight }]}>
              <MaterialCommunityIcons name="access-point" size={22} color={Colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Emergency Broadcast</Text>
              <Text style={styles.cardSubtitle}>Alert nearby Smilers users when you trigger SOS</Text>
            </View>
            <Switch
              value={!!broadcast.enabled}
              onValueChange={(v) => saveBroadcast({ enabled: v })}
              trackColor={{ false: '#E5E7EB', true: Colors.primary }}
              thumbColor={Colors.white}
              testID="emergency-broadcast-toggle"
            />
          </View>

          {broadcast.enabled ? (
            <>
              <View style={styles.divider} />
              <SettingSlider
                label="Broadcast Radius"
                value={`${(broadcast.radiusKm ?? 10).toFixed(broadcast.radiusKm && broadcast.radiusKm < 1 ? 1 : 0)}km`}
                valueColor={Colors.primary}
                min={RADIUS_MIN}
                max={RADIUS_MAX}
                step={0.5}
                current={broadcast.radiusKm ?? 10}
                onChange={(v) => setBroadcast((b) => ({ ...b, radiusKm: Math.round(v * 2) / 2 }))}
                onCommit={(v) => saveBroadcast({ radiusKm: Math.round(v * 2) / 2 })}
                minLabel={`${RADIUS_MIN}km`}
                maxLabel={`${RADIUS_MAX}km`}
                testID="emergency-radius-slider"
              />

              <View style={styles.broadcastInfoBox}>
                <Text style={styles.broadcastInfoText}>
                  When enabled, triggering SOS will also notify Smilers users within {(broadcast.radiusKm ?? 10).toFixed(broadcast.radiusKm && broadcast.radiusKm < 1 ? 1 : 0)}km of your location.
                  Your location is shared periodically so nearby users can be found.
                </Text>
              </View>

              <View style={styles.broadcastFooterRow}>
                <Feather name="users" size={16} color={Colors.textSecondary} />
                <Text style={styles.broadcastFooterText}>
                  Other Smilers users with broadcast enabled will also see your alerts and can navigate to help you.
                </Text>
              </View>
            </>
          ) : null}
        </View>

        {/* Past alerts */}
        {pastAlerts.length > 0 ? (
          <View style={styles.pastWrap} testID="emergency-past-list">
            <Text style={styles.pastTitle}>PAST ALERTS</Text>
            {pastAlerts.map((a) => (
              <View key={a._id} style={styles.pastRow} testID={`emergency-past-${a._id}`}>
                <View style={styles.pastCheck}>
                  <Feather name="check" size={14} color={Colors.success} />
                </View>
                <Text style={styles.pastText} numberOfLines={1}>
                  {a.resolvedAt ? `Resolved ${timeAgo(a.resolvedAt)}` : `Triggered ${timeAgo(a._creationTime || a.triggeredAt)}`}
                </Text>
                <Ionicons name="location-sharp" size={18} color={Colors.primary} />
              </View>
            ))}
          </View>
        ) : null}

        <View style={{ height: 32 }} />
      </ScrollView>

      {/* iter-146: BLE device picker modal — opens when the user taps
          the Pair Device row. Scans for 10 seconds and lists discovered
          peripherals; tapping one connects + persists + subscribes. */}
      <Modal
        animationType="slide"
        transparent
        visible={pickerOpen}
        onRequestClose={() => {
          stopScan();
          setPickerOpen(false);
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Pair Bluetooth device</Text>
              <TouchableOpacity
                onPress={() => {
                  stopScan();
                  setPickerOpen(false);
                }}
                hitSlop={12}
                testID="ble-picker-close"
              >
                <Ionicons name="close" size={24} color={Colors.textPrimary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalHint}>
              Scanning nearby panic buttons and wearables. Tap a device to pair —
              it will auto-reconnect every launch.
            </Text>
            {scanError ? (
              <Text style={styles.modalError}>{scanError}</Text>
            ) : null}
            {scanning ? (
              <View style={styles.modalLoading}>
                <ActivityIndicator color={Colors.primary} />
                <Text style={styles.modalLoadingText}>Scanning…</Text>
              </View>
            ) : null}
            <FlatList
              data={scanResults}
              keyExtractor={(item) => item.id}
              ListEmptyComponent={
                !scanning && !scanError ? (
                  <Text style={styles.modalEmpty}>
                    No devices found yet. Make sure the device is on and in pairing mode.
                  </Text>
                ) : null
              }
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.modalRow}
                  onPress={() => pickDevice(item)}
                  testID={`ble-device-${item.id}`}
                >
                  <Feather name="bluetooth" size={20} color={Colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.modalRowTitle}>{item.name || 'Unknown device'}</Text>
                    <Text style={styles.modalRowSub}>
                      {item.id}
                      {typeof item.rssi === 'number' ? `  ·  RSSI ${item.rssi}` : ''}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={Colors.textMuted} />
                </TouchableOpacity>
              )}
            />
            <TouchableOpacity
              style={styles.modalRescanBtn}
              onPress={startScan}
              disabled={scanning}
              testID="ble-rescan"
            >
              <Text style={styles.modalRescanText}>
                {scanning ? 'Scanning…' : 'Scan again'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/* ───────── Sub-components ───────── */

function SettingSlider({
  icon,
  iconColor,
  label,
  value,
  valueColor,
  min,
  max,
  step,
  current,
  onChange,
  onCommit,
  minLabel,
  maxLabel,
  testID,
}: {
  icon?: any;
  iconColor?: string;
  label: string;
  value: string;
  valueColor: string;
  min: number;
  max: number;
  step: number;
  current: number;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
  minLabel: string;
  maxLabel: string;
  testID?: string;
}) {
  return (
    <View style={sliderStyles.wrap}>
      <View style={sliderStyles.headerRow}>
        <View style={sliderStyles.labelLeft}>
          {icon ? <Ionicons name={icon as any} size={16} color={iconColor || Colors.primary} /> : null}
          <Text style={sliderStyles.label}>{label}</Text>
        </View>
        <Text style={[sliderStyles.value, { color: valueColor }]}>{value}</Text>
      </View>
      <Slider
        style={sliderStyles.slider}
        minimumValue={min}
        maximumValue={max}
        step={step}
        value={current}
        minimumTrackTintColor={Colors.primary}
        maximumTrackTintColor="#E5E7EB"
        thumbTintColor={Colors.primary}
        onValueChange={onChange}
        onSlidingComplete={onCommit}
        testID={testID}
      />
      <View style={sliderStyles.endpointsRow}>
        <Text style={sliderStyles.endpointText}>{minLabel}</Text>
        <Text style={sliderStyles.endpointText}>{maxLabel}</Text>
      </View>
    </View>
  );
}

function HowStep({ n, text }: { n: number; text: string }) {
  return (
    <View style={howStyles.row}>
      <Text style={howStyles.num}>{n}.</Text>
      <Text style={howStyles.text}>{text}</Text>
    </View>
  );
}

/* ───────── Styles ───────── */

const styles = StyleSheet.create({
  // iter-146: BLE picker modal styles
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '75%',
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  modalTitle: { fontSize: 18, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  modalHint: { fontSize: 13, color: Colors.textSecondary, marginBottom: 16 },
  modalError: { fontSize: 13, color: Colors.danger, marginBottom: 12 },
  modalLoading: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  modalLoadingText: { color: Colors.textSecondary, fontSize: 13 },
  modalRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.borderLight },
  modalRowTitle: { fontSize: 15, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  modalRowSub: { fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  modalEmpty: { textAlign: 'center', color: Colors.textMuted, paddingVertical: 24 },
  modalRescanBtn: { marginTop: 16, paddingVertical: 12, borderRadius: 24, alignItems: 'center', backgroundColor: Colors.primaryLight },
  modalRescanText: { fontSize: 14, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  container: { flex: 1, backgroundColor: '#F8F4ED' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    minHeight: 72,
    backgroundColor: Colors.danger,
  },
  headerTitle: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: Colors.white },

  scroll: { paddingHorizontal: Spacing.base, paddingTop: Spacing.lg },

  /* SOS */
  sosWrap: { alignItems: 'center', marginBottom: Spacing.lg },
  sosBtn: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.lg,
    shadowColor: '#DC2626',
    shadowOpacity: 0.45,
  },
  sosBtnActive: { backgroundColor: Colors.success, shadowColor: '#10B981' },
  sosLabel: { color: Colors.white, fontSize: 28, fontWeight: FontWeight.bold, marginTop: 6, letterSpacing: 1 },
  sosHint: { color: Colors.textPrimary, fontSize: FontSize.base, marginTop: Spacing.lg, textAlign: 'center', paddingHorizontal: 40 },
  sosSubHint: { color: Colors.textMuted, fontSize: FontSize.sm, marginTop: 4, textAlign: 'center', paddingHorizontal: 30 },

  /* Cards */
  card: {
    backgroundColor: Colors.white,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    marginTop: Spacing.md,
    ...Shadow.sm,
  },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  cardIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  cardSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2, lineHeight: 18 },

  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginVertical: Spacing.md },

  /* Pair device */
  pairRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    backgroundColor: Colors.background,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    marginTop: Spacing.md,
  },
  pairLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  pairText: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.medium, flex: 1 },
  pairBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
  },
  pairBtnConnected: { backgroundColor: Colors.success },
  pairBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.headerBg },

  /* How card */
  howCard: {
    marginTop: Spacing.md,
    padding: Spacing.base,
    borderRadius: Radius.lg,
    backgroundColor: '#FEE2E2',
  },
  howTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: '#991B1B', marginBottom: Spacing.sm },

  /* Broadcast helper */
  broadcastInfoBox: {
    marginTop: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: '#FEF3C7',
  },
  broadcastInfoText: { fontSize: FontSize.sm, color: '#92400E', lineHeight: 20 },
  broadcastFooterRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: Spacing.md,
    paddingHorizontal: 4,
  },
  broadcastFooterText: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },

  /* Past alerts */
  pastWrap: { marginTop: Spacing.lg },
  pastTitle: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textMuted,
    letterSpacing: 1,
    marginBottom: Spacing.sm,
  },
  pastRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    backgroundColor: Colors.white,
    borderRadius: Radius.md,
    marginBottom: 8,
    ...Shadow.sm,
  },
  pastCheck: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: Colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pastText: { flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.medium },
});

const sliderStyles = StyleSheet.create({
  wrap: { marginTop: Spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  labelLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  label: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  value: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  slider: { width: '100%', height: 36, marginTop: 2 },
  endpointsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -4 },
  endpointText: { fontSize: FontSize.xs, color: Colors.textMuted },
});

const howStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8 },
  num: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: '#991B1B', minWidth: 16 },
  text: { flex: 1, fontSize: FontSize.sm, color: '#991B1B', lineHeight: 20 },
});
