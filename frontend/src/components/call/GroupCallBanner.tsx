/**
 * GroupCallBanner — floating "Ongoing group call · <name>" strip shown to a
 * member who MISSED or DECLINED a group-call ring, giving them a second chance
 * to join while the call is still live. "Can't join" dismisses it permanently
 * for that specific call.
 *
 * SERVER-DRIVEN (reliable): polls GET /api/calls/active-group-calls, which
 * returns live group calls this user was rung into but hasn't joined — so it
 * works whether or not the ring push was recorded on-device, and for both
 * parent groups and sub groups. The "Can't join" dismiss is persisted per-call.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from 'convex/react';
import { api } from '../../convexApi';
import { useAuth } from '../../providers/AuthProvider';
import { fetchActiveGroupCalls } from '../../lib/twilio/twilioApi';
import {
  loadOngoingGroupCalls,
  dismissGroupCall,
  getDismissedCallIds,
} from '../../lib/call/ongoingGroupCallStore';

const POLL_MS = 7000;

type ActiveCall = {
  callId: string;
  room: string;
  conversationId: string;
  groupName: string;
  isVideo: boolean;
};

export default function GroupCallBanner() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const me = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip');
  const insets = useSafeAreaInsets();
  const myId = me && (me as any)._id ? String((me as any)._id) : '';

  const [call, setCall] = useState<ActiveCall | null>(null);
  const [busy, setBusy] = useState(false);
  const dismissedRef = useRef<Set<string>>(new Set());

  // Prime the persisted "Can't join" dismiss set (honour across launches).
  useEffect(() => {
    void loadOngoingGroupCalls().then(() => {
      getDismissedCallIds().forEach((id) => dismissedRef.current.add(id));
    });
  }, []);

  const poll = useCallback(async () => {
    if (!myId) {
      setCall(null);
      return;
    }
    const calls = await fetchActiveGroupCalls(myId);
    const dismissed = dismissedRef.current;
    const next = calls.find((c) => !dismissed.has(c.callId)) || null;
    setCall(next);
  }, [myId]);

  useEffect(() => {
    if (!myId) return;
    void poll();
    const t = setInterval(poll, POLL_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void poll();
    });
    return () => {
      clearInterval(t);
      sub.remove();
    };
  }, [myId, poll]);

  const join = useCallback(() => {
    if (!call || busy) return;
    setBusy(true);
    const type = call.isVideo ? 'video' : 'voice';
    setCall(null);
    try {
      router.push(
        `/call/${call.conversationId}?streamRoom=${encodeURIComponent(call.room)}&answer=1&type=${type}&group=1&displayName=${encodeURIComponent(call.groupName || '')}` as any,
      );
    } catch {}
    setTimeout(() => setBusy(false), 1200);
  }, [call, busy, router]);

  const cantJoin = useCallback(() => {
    if (!call) return;
    dismissedRef.current.add(call.callId);
    dismissGroupCall(call.callId); // persist across launches
    setCall(null);
  }, [call]);

  if (!call) return null;

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + 6 }]}>
      <View style={styles.card}>
        <TouchableOpacity style={styles.main} activeOpacity={0.85} onPress={join} disabled={busy} testID="group-call-banner-join">
          <View style={styles.iconWrap}>
            {busy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name={call.isVideo ? 'videocam' : 'call'} size={18} color="#fff" />
            )}
          </View>
          <View style={styles.textWrap}>
            <Text style={styles.title} numberOfLines={1}>
              Ongoing group call{call.groupName ? ` · ${call.groupName}` : ''}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              Tap to join
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={styles.cantBtn} onPress={cantJoin} testID="group-call-banner-cant-join">
          <Text style={styles.cantText}>Can’t join</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12, zIndex: 1000, elevation: 20 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1f9d57',
    borderRadius: 14,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 8,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } },
      android: {},
    }),
  },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  textWrap: { flex: 1 },
  title: { color: '#fff', fontSize: 14, fontWeight: '800' },
  subtitle: { color: 'rgba(255,255,255,0.9)', fontSize: 12, marginTop: 1 },
  cantBtn: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.18)',
    marginLeft: 8,
    minHeight: 40,
    justifyContent: 'center',
  },
  cantText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
