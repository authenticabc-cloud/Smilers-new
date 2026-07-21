/**
 * StreamCallProvider + RingingOverlay — mounts the Stream client at the app
 * root and renders the native-style incoming/outgoing ringing UI.
 *
 * STAGED (Phase 1b): not yet imported by app/_layout.tsx. Wiring happens during
 * the destructive swap pass. See /app/memory/STREAM_MIGRATION.md.
 */
import React from 'react';

/**
 * Phase 1 (Hybrid): Stream ringing is DISABLED.
 *
 * Incoming-call ringing, the lock-screen wake-up UI, the custom ringtone and the
 * Answer/Decline buttons are handled ENTIRELY by the native
 * SmilersCallNotificationService (the FCM pipeline Ashwini built). Stream is used
 * only for the media/connection layer, which is mounted inside the call screen
 * (Phase 2) — NOT here.
 *
 * This provider is now a passthrough so Stream neither sends a ringing push nor
 * shows any ringing/in-call overlay that could conflict with the native
 * notification (which was the Phase-1b regression the user reported).
 */
export default function StreamCallProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
