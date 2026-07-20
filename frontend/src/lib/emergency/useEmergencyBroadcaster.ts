/**
 * useEmergencyBroadcaster — LIVE LOCATION broadcaster.
 *
 * While the current user has an ACTIVE emergency alert, a foreground GPS
 * watcher pushes coordinates to `api.emergencyAlerts.updateAlertLocation`, so
 * the viewer screen's map pin glides to the alerter's live position.
 *
 * Audio + video capture is handled separately by <EmergencyMediaCapture/>
 * (they share the microphone, so they must be sequenced in one place — running
 * a standalone audio recorder here at the same time as camera video recording
 * fought over the mic and broke both).
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Location from 'expo-location';
import { useMutation } from 'convex/react';

import { api } from '../../convexApi';

const LOCATION_MIN_INTERVAL_MS = 12_000;

interface ActiveAlertLike {
  _id?: string;
  status?: string;
}

export function useEmergencyBroadcaster(activeAlert: ActiveAlertLike | null | undefined) {
  const updateAlertLocation = useMutation((api as any).emergencyAlerts.updateAlertLocation);
  const lastLocationSentRef = useRef(0);

  const alertId = activeAlert?._id;
  const isActive = !!alertId && activeAlert?.status !== 'resolved';

  useEffect(() => {
    if (Platform.OS === 'web' || !isActive || !alertId) {
      return;
    }

    let cancelled = false;
    let locationSub: Location.LocationSubscription | null = null;

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
        /* location unavailable */
      }
    })();

    return () => {
      cancelled = true;
      try {
        locationSub?.remove();
      } catch {
        /* ignore */
      }
    };
    // updateAlertLocation ref is stable; re-run only on alert identity/state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertId, isActive]);
}
