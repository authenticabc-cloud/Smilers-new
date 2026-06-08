/**
 * useEngagementTracker — iter-137 alignment helper.
 *
 * Central place that fires the Convex tracking mutations whenever the
 * user performs a rewarded action. The Smilers backend does NOT
 * auto-track: every qualifying message, voice note, call, location
 * share, and referral signup must explicitly call the matching
 * `api.earnings.track*` mutation from the client.
 *
 * The web app fires these inline at the point of each action. We do
 * the same on mobile via a single hook so we can:
 *   - Centralize the qualification rules (3+ words, 8+ letters, 5+ sec…)
 *   - Catch & swallow errors so a stale auth token never tanks a chat
 *     send / voice note / call end (the tracker is best-effort by design)
 *   - Keep the wiring discoverable when we tune thresholds later.
 *
 * All methods are no-ops when the user isn't authenticated.
 */

import { useCallback, useMemo } from 'react';
import { useMutation } from 'convex/react';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';

// Web-side qualification rules (mirrored exactly per the canonical contract):
//   trackMessage     → text counts only if it has 3+ words AND 8+ letters
//   trackVoiceNote   → duration must be >= 5 seconds
//   trackCall        → caller's duration in minutes (rounded up to nearest min)
//   trackLocationShare → fires once per share (no thresholds)
//   trackReferral    → fires once when a referral code is consumed
export function isQualifyingMessage(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  const letters = trimmed.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '').length;
  return words.length >= 3 && letters >= 8;
}

export function useEngagementTracker() {
  const { isAuthenticated } = useAuth();
  const trackMessage = useMutation((api as any).earnings?.trackMessage);
  const trackVoiceNote = useMutation((api as any).earnings?.trackVoiceNote);
  const trackCall = useMutation((api as any).earnings?.trackCall);
  const trackLocationShare = useMutation((api as any).earnings?.trackLocationShare);
  const trackReferral = useMutation((api as any).earnings?.trackReferral);

  const safeCall = useCallback(
    async (
      label: string,
      fn: any,
      args: Record<string, unknown>,
    ): Promise<void> => {
      if (!isAuthenticated) return;
      if (typeof fn !== 'function') return;
      try {
        await fn(args);
      } catch (errorValue: any) {
        // Best-effort: never block the calling UI for a tracking failure.
        // Convex `function not found` (a deploy lag) and rate-limit errors
        // are both expected outliers — keep them out of the user's face.
        // eslint-disable-next-line no-console
        console.warn(
          `[engagement] ${label} failed: ${String(errorValue?.message || errorValue).slice(0, 160)}`,
        );
      }
    },
    [isAuthenticated],
  );

  return useMemo(
    () => ({
      /** Call on EVERY outgoing text. We gate by qualification here so
       *  callers don't have to think about it. */
      message: async (text: string, opts: { isReceived?: boolean } = {}) => {
        if (!isQualifyingMessage(text)) return;
        await safeCall('trackMessage', trackMessage, {
          text,
          isReceived: Boolean(opts.isReceived),
        });
      },
      /** Call after a voice note finishes sending. `durationSeconds`
       *  comes from the recorder. We gate on >= 5 seconds. */
      voiceNote: async (
        durationSeconds: number,
        opts: { isReceived?: boolean } = {},
      ) => {
        if (!Number.isFinite(durationSeconds) || durationSeconds < 5) return;
        await safeCall('trackVoiceNote', trackVoiceNote, {
          durationSeconds: Math.round(durationSeconds),
          isReceived: Boolean(opts.isReceived),
        });
      },
      /** Call when a call ENDS (after duration is finalised). */
      call: async (durationMinutes: number, isVideo: boolean) => {
        if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return;
        await safeCall('trackCall', trackCall, {
          durationMinutes: Math.max(1, Math.round(durationMinutes)),
          isVideo: Boolean(isVideo),
        });
      },
      /** Call once per location share. */
      locationShare: async () => {
        await safeCall('trackLocationShare', trackLocationShare, {});
      },
      /** Fire once at first launch if a referral code is stored locally. */
      referral: async (referralCode: string) => {
        const code = (referralCode || '').trim();
        if (!code) return;
        await safeCall('trackReferral', trackReferral, { referralCode: code });
      },
    }),
    [safeCall, trackMessage, trackVoiceNote, trackCall, trackLocationShare, trackReferral],
  );
}
