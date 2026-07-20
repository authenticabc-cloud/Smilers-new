/**
 * EmergencyMediaCapture
 *
 * While the current user has an ACTIVE emergency alert, this hidden component
 * captures and uploads media from the alerter's device so trustees/nearby
 * viewers see & hear what's happening:
 *
 *   loop while active:
 *     1. record a ~12s VIDEO clip (camera + mic) → emergencyCaptures (type video)
 *     2. record a ~10s AUDIO clip (mic only)     → emergencyRecordings
 *
 * The two use the SAME microphone, so they are SEQUENCED (never simultaneous) —
 * running a standalone audio recorder alongside camera video recording fought
 * over the mic and broke both. The viewer renders each as it arrives.
 *
 * Foreground-only (camera can't run in the background). Degrades gracefully:
 * if camera/mic permission is denied, it simply captures nothing — the SOS
 * (and live location) is never blocked. Needs a native build to test.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { useAudioRecorder, setAudioModeAsync } from 'expo-audio';
import { useConvex, useMutation } from 'convex/react';

import { api } from '../convexApi';
import { uploadFile } from '../lib/uploadFile';
import { VOICE_RECORDING_OPTIONS } from '../lib/audioRecording';

const VIDEO_CLIP_SEC = 12;
const AUDIO_CLIP_MS = 10_000;

interface Props {
  alertId?: string;
  active: boolean;
}

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

export default function EmergencyMediaCapture({ alertId, active }: Props) {
  const convex = useConvex();
  const cameraRef = useRef<CameraView | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const readyRef = useRef(false);
  readyRef.current = cameraReady;

  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const saveCapture = useMutation((api as any).emergencyCaptures.saveCapture);
  const saveRecording = useMutation((api as any).emergencyRecordings.saveRecording);

  const shouldRun = Platform.OS !== 'web' && active && !!alertId;

  // Request camera + mic permissions when an alert becomes active. The user has
  // already triggered an SOS, so this is a clearly-intentional moment to ask.
  useEffect(() => {
    if (!shouldRun) return;
    (async () => {
      try {
        if (!camPerm?.granted) await requestCamPerm();
      } catch {}
      try {
        if (!micPerm?.granted) await requestMicPerm();
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldRun]);

  // Sequential capture loop.
  useEffect(() => {
    if (!shouldRun) return;
    let cancelled = false;
    const isCancelled = () => cancelled;

    const run = async () => {
      // Give the CameraView a moment to become ready (up to ~8s).
      for (let i = 0; i < 20 && !readyRef.current && !cancelled; i++) {
        await sleep(400, isCancelled);
      }

      while (!cancelled) {
        // ── 1) VIDEO clip (camera + audio) ──
        if (readyRef.current && cameraRef.current && camPerm?.granted) {
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
                await saveCapture({
                  alertId,
                  storageId,
                  type: 'video',
                  durationSeconds,
                }).catch((e: any) =>
                  console.warn('[emergency-capture] saveCapture failed:', e?.message),
                );
              }
            }
          } catch (e: any) {
            console.warn('[emergency-capture] video clip failed:', e?.message);
            await sleep(1500, isCancelled);
          }
        }
        if (cancelled) break;

        // ── 2) AUDIO clip (mic only — camera is idle now) ──
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
                console.warn('[emergency-capture] saveRecording failed:', e?.message),
              );
            }
          }
        } catch (e: any) {
          console.warn('[emergency-capture] audio clip failed:', e?.message);
          await sleep(1500, isCancelled);
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
    // camera/recorder/convex refs are stable; re-run only on alert change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldRun, camPerm?.granted]);

  if (!shouldRun || !camPerm?.granted) return null;

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
  // Rendered off-screen at 1x1 so the camera hardware is active (required to
  // capture) but nothing is visible to the user.
  hidden: { position: 'absolute', top: -20, left: -20, width: 1, height: 1, opacity: 0 },
  cam: { width: 1, height: 1 },
});
