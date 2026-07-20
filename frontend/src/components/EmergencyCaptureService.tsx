/**
 * EmergencyCaptureService — GLOBAL, always-on emergency capture.
 *
 * Mounted once at the app root (app/_layout.tsx). It watches the current user's
 * active emergency alert and, while one is active, broadcasts from this device
 * regardless of which screen is open:
 *
 *   • LIVE LOCATION  → api.emergencyAlerts.updateAlertLocation
 *   • AUDIO clips    → api.emergencyRecordings.saveRecording   (mic)
 *   • VIDEO clips    → api.emergencyCaptures.saveCapture        (camera + mic)
 *
 * A notifee FOREGROUND SERVICE (microphone|location types) keeps the JS process
 * alive, so AUDIO + LOCATION keep broadcasting even when the app is backgrounded
 * or the screen is locked. VIDEO only runs while the app is FOREGROUNDED — the
 * Android camera cannot be accessed in the background (an OS restriction).
 *
 * Audio and video share the microphone, so they are SEQUENCED (video clip →
 * audio clip → repeat), never simultaneous. Everything degrades gracefully: a
 * denied permission just drops that stream; the SOS is never blocked.
 * Foreground-only pieces + the FGS require a native build to validate.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import * as Location from 'expo-location';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { useAudioRecorder, setAudioModeAsync } from 'expo-audio';
import { useConvex, useMutation, useQuery } from 'convex/react';

import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';
import { uploadFile } from '../lib/uploadFile';
import { VOICE_RECORDING_OPTIONS } from '../lib/audioRecording';
import {
  startEmergencyForegroundService,
  stopEmergencyForegroundService,
} from '../lib/emergency/emergencyForegroundService';

const VIDEO_CLIP_SEC = 12;
const AUDIO_CLIP_MS = 10_000;
const LOCATION_MIN_INTERVAL_MS = 12_000;

function sleep(ms: number, isCancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (isCancelled() || Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, 400);
    };
    tick();
  });
}

export default function EmergencyCaptureService() {
  const { isAuthenticated } = useAuth();
  const alert = useQuery(
    (api as any).emergencyAlerts.getActiveAlert,
    isAuthenticated ? {} : ('skip' as any),
  ) as { _id?: string; status?: string } | null | undefined;

  const alertId = alert?._id;
  const active = !!alertId && alert?.status !== 'resolved';
  const shouldRun = Platform.OS !== 'web' && active;

  const convex = useConvex();
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();
  const updateAlertLocation = useMutation((api as any).emergencyAlerts.updateAlertLocation);
  const saveCapture = useMutation((api as any).emergencyCaptures.saveCapture);
  const saveRecording = useMutation((api as any).emergencyRecordings.saveRecording);

  const cameraRef = useRef<CameraView | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [locGranted, setLocGranted] = useState(false);

  // Live refs the long-running capture loop reads (closures capture stale state).
  const readyRef = useRef(false);
  const appActiveRef = useRef(appActive);
  const camGrantedRef = useRef(false);
  const micGrantedRef = useRef(false);
  readyRef.current = cameraReady;
  appActiveRef.current = appActive;
  camGrantedRef.current = !!camPerm?.granted;
  micGrantedRef.current = !!micPerm?.granted;

  // Track foreground/background. Reset camera-ready when backgrounded (the
  // hidden CameraView unmounts, so it must re-signal readiness on return).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      const isActive = s === 'active';
      setAppActive(isActive);
      if (!isActive) setCameraReady(false);
    });
    return () => sub.remove();
  }, []);

  // On active alert: request permissions and start the foreground service with
  // whatever types are granted (never with an undeclared/ungranted type).
  useEffect(() => {
    if (!shouldRun) return;
    let cancelled = false;
    (async () => {
      let loc = false;
      try {
        const p = await Location.getForegroundPermissionsAsync();
        loc = p.granted || (await Location.requestForegroundPermissionsAsync()).granted;
      } catch {}
      if (cancelled) return;
      setLocGranted(loc);

      let mic = !!micPerm?.granted;
      if (!mic) {
        try {
          mic = !!(await requestMicPerm())?.granted;
        } catch {}
      }
      if (!camPerm?.granted) {
        try {
          await requestCamPerm();
        } catch {}
      }
      if (cancelled) return;
      await startEmergencyForegroundService({ mic, location: loc });
    })();
    return () => {
      cancelled = true;
      void stopEmergencyForegroundService();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldRun]);

  // Live location watcher (kept alive by the foreground service in background).
  useEffect(() => {
    if (!shouldRun || !locGranted) return;
    let cancelled = false;
    let sub: Location.LocationSubscription | null = null;
    let last = 0;
    (async () => {
      try {
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: LOCATION_MIN_INTERVAL_MS, distanceInterval: 10 },
          (pos) => {
            if (cancelled) return;
            const now = Date.now();
            if (now - last < LOCATION_MIN_INTERVAL_MS) return;
            last = now;
            updateAlertLocation({
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
            }).catch(() => {});
          },
        );
      } catch {}
    })();
    return () => {
      cancelled = true;
      try {
        sub?.remove();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldRun, locGranted]);

  // Sequential media capture loop: VIDEO (foreground only) → AUDIO → repeat.
  useEffect(() => {
    if (!shouldRun) return;
    let cancelled = false;
    const isCancelled = () => cancelled;

    const run = async () => {
      while (!cancelled) {
        // ── VIDEO clip (only while foregrounded — camera can't run in bg) ──
        if (appActiveRef.current && camGrantedRef.current) {
          for (let i = 0; i < 15 && !readyRef.current && !cancelled && appActiveRef.current; i++) {
            await sleep(400, isCancelled);
          }
          if (readyRef.current && cameraRef.current && appActiveRef.current) {
            const startedAt = Date.now();
            try {
              const video = await cameraRef.current.recordAsync({ maxDuration: VIDEO_CLIP_SEC });
              const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
              if (video?.uri && !cancelled) {
                const storageId = await uploadFile(
                  convex as any,
                  video.uri,
                  'video/mp4',
                  (api as any).emergencyCaptures.generateUploadUrl,
                );
                if (!cancelled) {
                  await saveCapture({ alertId, storageId, type: 'video', durationSeconds }).catch(
                    (e: any) => console.warn('[emergency] saveCapture:', e?.message),
                  );
                }
              }
            } catch (e: any) {
              console.warn('[emergency] video clip:', e?.message);
              await sleep(1200, isCancelled);
            }
          }
        }
        if (cancelled) break;

        // ── AUDIO clip (mic only — runs foreground AND background) ──
        if (micGrantedRef.current) {
          try {
            await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }).catch(() => {});
            const startedAt = Date.now();
            await recorder.prepareToRecordAsync();
            recorder.record();
            await sleep(AUDIO_CLIP_MS, isCancelled);
            await recorder.stop();
            const uri = recorder.uri;
            const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
            if (uri && !cancelled) {
              const storageId = await uploadFile(
                convex as any,
                uri,
                'audio/m4a',
                (api as any).emergencyRecordings.generateUploadUrl,
              );
              if (!cancelled) {
                await saveRecording({ alertId, storageId, durationSeconds }).catch((e: any) =>
                  console.warn('[emergency] saveRecording:', e?.message),
                );
              }
            }
          } catch (e: any) {
            console.warn('[emergency] audio clip:', e?.message);
            await sleep(1200, isCancelled);
          }
        } else {
          await sleep(1000, isCancelled);
        }
      }
      try {
        await recorder.stop();
      } catch {}
    };

    run();
    return () => {
      cancelled = true;
      try {
        cameraRef.current?.stopRecording();
      } catch {}
      try {
        recorder.stop();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldRun, alertId]);

  // The hidden CameraView is only mounted while foregrounded + permitted.
  if (!shouldRun || !appActive || !camPerm?.granted) return null;

  return (
    <View style={styles.hidden} pointerEvents="none" collapsable={false}>
      <CameraView
        ref={cameraRef}
        style={styles.cam}
        facing="back"
        mode="video"
        onCameraReady={() => setCameraReady(true)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', top: -20, left: -20, width: 1, height: 1, opacity: 0 },
  cam: { width: 1, height: 1 },
});
