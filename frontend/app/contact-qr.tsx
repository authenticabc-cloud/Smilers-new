import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather, Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import QRCode from 'react-native-qrcode-svg';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../src/theme';

type Mode = 'show' | 'scan';

export default function ContactQrScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: Mode }>();
  const [mode, setMode] = useState<Mode>(params.mode === 'scan' ? 'scan' : 'show');
  const { isAuthenticated } = useAuth();
  const me = useQuery(api.users.getCurrentUser);
  const sendRequest = useMutation(api.contacts.sendRequest);
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (mode === 'scan' && permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [mode, permission, requestPermission]);

  const myPayload = me?._id ? JSON.stringify({ kind: 'smilers-contact', userId: me._id, name: me.name }) : '';

  const onScanned = useCallback(
    async ({ data }: { data: string }) => {
      if (scanned || sending) return;
      setScanned(true);

      let userId: string | null = null;
      try {
        const parsed = JSON.parse(data);
        if (parsed?.kind === 'smilers-contact' && parsed.userId) userId = parsed.userId;
      } catch {
        if (/^[A-Za-z0-9_-]{6,}$/.test(data.trim())) userId = data.trim();
      }

      if (!userId) {
        Alert.alert('Not a Smilers QR', 'This code is not a Smilers contact code.');
        setTimeout(() => setScanned(false), 1500);
        return;
      }

      if (userId === me?._id) {
        Alert.alert("That's you", "You can't add yourself as a contact.");
        setTimeout(() => setScanned(false), 1500);
        return;
      }

      setSending(true);
      try {
        await sendRequest({ contactId: userId });
        Alert.alert('Request sent', 'Contact request was sent.');
        router.back();
      } catch (errorValue: any) {
        Alert.alert('Failed', errorValue?.message || 'Could not send request.');
        setTimeout(() => setScanned(false), 1500);
      } finally {
        setSending(false);
      }
    },
    [scanned, sending, me, sendRequest, router]
  );

  if (!isAuthenticated) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="contact-qr-signed-out">
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="contact-qr-close">
            <Feather name="x" size={26} color={Colors.white} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Contact card</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.permWrap}>
          <Ionicons name="person-circle-outline" size={52} color="#FFFFFF" />
          <Text style={styles.permTitle}>Sign in required</Text>
          <Text style={styles.permSub}>Sign in to show or scan Smilers contact QR codes.</Text>
          <TouchableOpacity style={styles.permBtn} onPress={() => router.replace('/')} testID="contact-qr-sign-in">
            <Text style={styles.permBtnText}>Back to sign in</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="contact-qr-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="contact-qr-close">
          <Feather name="x" size={26} color={Colors.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Contact card</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.tabsRow}>
        <TouchableOpacity
          style={[styles.tab, mode === 'show' ? styles.tabActive : null]}
          onPress={() => setMode('show')}
          testID="qr-show-tab"
        >
          <Text style={[styles.tabText, mode === 'show' ? styles.tabTextActive : null]}>My QR</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, mode === 'scan' ? styles.tabActive : null]}
          onPress={() => setMode('scan')}
          testID="qr-scan-tab"
        >
          <Text style={[styles.tabText, mode === 'scan' ? styles.tabTextActive : null]}>Scan QR</Text>
        </TouchableOpacity>
      </View>

      {mode === 'show' ? (
        <View style={styles.showBody}>
          {myPayload ? (
            <>
              <View style={styles.qrCard} testID="my-qr-card">
                <QRCode value={myPayload} size={220} color="#3A2608" backgroundColor="#FFFFFF" />
              </View>
              <Text style={styles.name}>{me?.name || 'You'}</Text>
              <Text style={styles.hint}>Have a friend scan this code to add you as a contact.</Text>
            </>
          ) : (
            <ActivityIndicator color={Colors.white} size="large" />
          )}
        </View>
      ) : (
        <View style={styles.scanBody}>
          {!permission ? (
            <ActivityIndicator color={Colors.white} size="large" />
          ) : !permission.granted ? (
            <View style={styles.permWrap} testID="qr-permission-state">
              <Ionicons name="camera-outline" size={48} color="#FFFFFF" />
              <Text style={styles.permTitle}>Camera access needed</Text>
              <Text style={styles.permSub}>Allow camera access to scan a Smilers QR code.</Text>
              <TouchableOpacity style={styles.permBtn} onPress={requestPermission} testID="qr-grant-perm">
                <Text style={styles.permBtnText}>Allow camera</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={scanned ? undefined : onScanned}
            />
          )}
          {permission?.granted ? (
            <View style={styles.scanOverlay}>
              <View style={styles.viewfinder} />
              <Text style={styles.scanHint}>{sending ? 'Sending request…' : 'Align the QR inside the frame'}</Text>
            </View>
          ) : null}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#3A2608' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
  },
  headerTitle: { color: Colors.white, fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  headerSpacer: { width: 26 },
  tabsRow: {
    flexDirection: 'row',
    marginHorizontal: Spacing.base,
    marginBottom: Spacing.md,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: Radius.pill,
    padding: 4,
  },
  tab: { flex: 1, paddingVertical: 10, borderRadius: Radius.pill, alignItems: 'center' },
  tabActive: { backgroundColor: Colors.primary },
  tabText: { color: 'rgba(255,255,255,0.7)', fontWeight: FontWeight.semibold },
  tabTextActive: { color: '#3A2608' },
  showBody: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, gap: Spacing.md },
  qrCard: { padding: Spacing.lg, backgroundColor: Colors.white, borderRadius: 24, ...Shadow.lg },
  name: { color: Colors.white, fontSize: FontSize.xl, fontWeight: FontWeight.bold, marginTop: Spacing.lg },
  hint: { color: 'rgba(255,255,255,0.7)', fontSize: FontSize.sm, textAlign: 'center', paddingHorizontal: Spacing.lg },
  scanBody: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  scanOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  viewfinder: { width: 240, height: 240, borderRadius: 24, borderWidth: 4, borderColor: 'rgba(255,255,255,0.85)' },
  scanHint: {
    color: Colors.white,
    marginTop: Spacing.lg,
    fontSize: FontSize.base,
    fontWeight: FontWeight.medium,
    paddingHorizontal: Spacing.lg,
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingVertical: 8,
    borderRadius: Radius.pill,
  },
  permWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: Spacing.lg },
  permTitle: { color: Colors.white, fontSize: FontSize.lg, fontWeight: FontWeight.bold, marginTop: Spacing.md },
  permSub: { color: 'rgba(255,255,255,0.7)', fontSize: FontSize.sm, textAlign: 'center' },
  permBtn: { backgroundColor: Colors.primary, paddingHorizontal: 20, paddingVertical: 12, borderRadius: Radius.pill, marginTop: Spacing.lg },
  permBtnText: { color: '#3A2608', fontWeight: FontWeight.bold },
});