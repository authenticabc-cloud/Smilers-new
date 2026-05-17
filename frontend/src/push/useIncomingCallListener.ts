import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';

/**
 * Real-time incoming-call listener — when foregrounded, Convex's reactive
 * query pushes us the new call instantly via WebSocket. We then deep-link
 * the user to the active call screen so they can answer/decline in-app
 * (push notifications cover the backgrounded/locked case).
 */
export function useIncomingCallListener() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const incomingCall = useQuery(
    api.calls.getIncomingCall,
    isAuthenticated ? {} : 'skip'
  );
  const handledCallId = useRef<string | null>(null);

  useEffect(() => {
    if (!incomingCall || !incomingCall._id) return;
    if (incomingCall.status !== 'ringing') return;
    if (handledCallId.current === incomingCall._id) return;
    handledCallId.current = incomingCall._id;

    const conversationId = incomingCall.conversationId;
    const displayName = String(
      incomingCall?.callerName ||
      incomingCall?.caller?.displayName ||
      incomingCall?.caller?.name ||
      incomingCall?.caller?.fullName ||
      ''
    ).trim();
    if (conversationId) {
      router.push(
        displayName
          ? (`/call/${conversationId}?displayName=${encodeURIComponent(displayName)}` as any)
          : (`/call/${conversationId}` as any)
      );
    }
  }, [incomingCall, router]);
}
