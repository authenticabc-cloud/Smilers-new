/**
 * useEmergencyBroadcaster
 *
 * While the current user has an ACTIVE emergency alert, this hook automatically
 * broadcasts, from the alerter's own device, so trustees/nearby viewers get a
 * live picture without the alerter doing anything:
 *
 *   1. LIVE LOCATION — a foreground GPS watcher pushes coordinates to
 *      `api.emergencyAlerts.updateAlertLocation({ latitude, longitude })`.
 *      The viewer screen (`/emergency/<alertId>`) reads these reactively, so
 *      its map pin glides to the alerter's new position.
 *
 *   2. AUDIO CHUNKS — records ~30s audio clips in a loop, uploads each via the
 *      canonical Convex upload flow, then registers it with
 *      `api.emergencyRecordings.saveRecording({ alertId, storageId, durationSeconds })`.
 *
 * Design notes:
 *   - Everything is wrapped in try/catch and degrades gracefully. If the mic
 *     permission is denied, location still broadcasts (never dead-ends the SOS).
 *   - `updateAlertLocation` may not be published on the backend yet — a failing
 *     call is swallowed, so the rest keeps working.
 *   - Foreground only (MVP). The loop stops when the alert resolves or the
 *     screen unmounts.
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Location from 'expo-location';
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { useConvex, useMutation } from 'convex/react';

import { api } from '../../convexApi';
import { uploadFile } from '../uploadFile';
import { VOICE_RECORDING_OPTIONS } from '../audioRecording';

const AUDIO_CHUNK_MS = 30_000;
const LOCATION_MIN_INTERVAL_MS = 12_000;

interface ActiveAlertLike {
  _id?: string;
  status?: string;
}

function interruptibleSleep(ms: number, isCancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (isCancelled() || Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, 1000);
    };
    tick();
  });
}

export function useEmergencyBroadcaster(activeAlert: ActiveAlertLike | null | undefined) {
  const convex = useConvex();
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const updateAlertLocation = useMutation((api as any).emergencyAlerts.updateAlertLocation);
  const saveRecording = useMutation((api as any).emergencyRecordings.saveRecording);

  const lastLocationSentRef = useRef(0);

  const alertId = activeAlert?._id;
  const isActive = !!alertId && activeAlert?.status !== 'resolved';

  useEffect(() => {
    if (Platform.OS === 'web' || !isActive || !alertId) {
      return;
    }

    let cancelled = false;
    let locationSub: Location.LocationSubscription | null = null;

    // 1) Live location watcher → updateAlertLocation (throttled).
    (async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (!perm.granted) return;
        locationSub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: LOCATION_MIN_INTERVAL_MS,
            distanceInterval: 10,
          },
          (position) => {
            if (cancelled) return;
            const now = Date.now();
            if (now - lastLocationSentRef.current < LOCATION_MIN_INTERVAL_MS) return;
            lastLocationSentRef.current = now;
            updateAlertLocation({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
            }).catch(() => {
              /* updateAlertLocation may be unpublished — ignore */
            });
          },
        );
      } catch {
        /* location unavailable — audio still broadcasts */
      }
    })();

    // 2) Rolling 30s audio-chunk recorder → upload → saveRecording.
    (async () => {
      let micGranted = false;
      try {
        const perm = await requestRecordingPermissionsAsync();
        micGranted = !!perm.granted;
      } catch {
        micGranted = false;
      }
      if (!micGranted || cancelled) return;

      try {
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      } catch {
        /* best-effort */
      }

      while (!cancelled) {
        const startedAt = Date.now();
        try {
          await recorder.prepareToRecordAsync();
          recorder.record();
          await interruptibleSleep(AUDIO_CHUNK_MS, () => cancelled);
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
              await saveRecording({ alertId, storageId, durationSeconds }).catch(() => {});
            }
          }
        } catch {
          // brief backoff so a transient failure doesn't hot-loop
          await interruptibleSleep(2000, () => cancelled);
        }
      }

      try {
        await recorder.stop();
      } catch {
        /* already stopped */
      }
      try {
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      } catch {
        /* best-effort */
      }
    })();

    return () => {
      cancelled = true;
      try {
        locationSub?.remove();
      } catch {
        /* ignore */
      }
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    };
    // recorder / convex / mutation refs are stable; re-run only when the
    // active alert identity or its resolved state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertId, isActive]);
}
