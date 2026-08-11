/**
 * GroupCallBanner — floating "Ongoing group call · <name>" strip shown to a
 * member who MISSED or DECLINED a group-call ring, giving them a second chance
 * to join while the call is still live. "Can't join" dismisses it permanently
 * for that specific call.
 *
 * Data: ongoingGroupCallStore (recorded at push-receipt). We poll the live
 * FastAPI roster to (a) only show while someone is actually in the call and
 * (b) auto-clear once the call ends or this user has joined.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from 'convex/react';
import { api } from '../../convexApi';
import { useAuth } from '../../providers/AuthProvider';
import { fetchCallParticipants } from '../../lib/twilio/twilioApi';
import {
  getOngoingGroupCalls,
  loadOngoingGroupCalls,
  removeGroupCall,
  dismissGroupCall,
  subscribeOngoingGroupCalls,
  type OngoingGroupCall,
} from '../../lib/call/ongoingGroupCallStore';

const POLL_MS = 6000;

export default function GroupCallBanner() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const me = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip');
  const insets = useSafeAreaInsets();
  const myId = me && (me as any)._id ? String((me as any)._id) : '';

  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);

  // Load persisted state + subscribe; reload when the app comes to foreground
  // (records may have been written by the background/killed JS context).
  useEffect(() => {
    void loadOngoingGroupCalls();
    const unsub = subscribeOngoingGroupCalls(rerender);
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void loadOngoingGroupCalls(true);
    });
    return () => {
      unsub();
      appSub.remove();
    };
  }, [rerender]);

  // Newest not-dismissed candidate (recomputed on every store change / rerender).
  const candidates = getOngoingGroupCalls();
  const candidate: OngoingGroupCall | null = candidates.length ? candidates[0] : null;
  const candidateKey = candidate ? candidate.callId : '';
  const candidateRoom = candidate ? candidate.streamRoom : '';

  const [ongoing, setOngoing] = useState(false);
  const [busy, setBusy] = useState(false);

  // Poll the live roster: show only while someone is joined AND I'm not; clear
  // when the call ends or I've joined.
  useEffect(() => {
    if (!candidateKey || !candidateRoom || !myId) {
      setOngoing(false);
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const roster = await fetchCallParticipants(candidateRoom, myId);
        if (cancelled) return;
        const anyoneIn = roster.some((r) => r.status === 'joined');
        const iJoined = roster.some((r) => r.identity === myId && r.status === 'joined');
        if (iJoined) {
          removeGroupCall(candidateKey);
          setOngoing(false);
          return;
        }
        // If the roster is fully known and NOBODY is in the call, it ended.
        if (roster.length > 0 && !anyoneIn) {
          removeGroupCall(candidateKey);
          setOngoing(false);
          return;
        }
        setOngoing(anyoneIn);
      } catch {
        // keep last state on transient errors
      }
    };
    void check();
    const t = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [candidateKey, candidateRoom, myId]);

  const join = useCallback(() => {
    if (!candidate || busy) return;
    setBusy(true);
    const type = candidate.isVideo ? 'video' : 'voice';
    removeGroupCall(candidate.callId);
    try {
      router.push(
        `/call/${candidate.conversationId}?streamRoom=${encodeURIComponent(candidate.streamRoom)}&answer=1&type=${type}&group=1&displayName=${encodeURIComponent(candidate.groupName || '')}` as any,
      );
    } catch {}
    setTimeout(() => setBusy(false), 1200);
  }, [candidate, busy, router]);

  const cantJoin = useCallback(() => {
    if (!candidate) return;
    dismissGroupCall(candidate.callId);
  }, [candidate]);

  if (!candidate || !ongoing) return null;

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + 6 }]}>
      <View style={styles.card}>
        <TouchableOpacity style={styles.main} activeOpacity={0.85} onPress={join} disabled={busy} testID="group-call-banner-join">
          <View style={styles.iconWrap}>
            {busy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name={candidate.isVideo ? 'videocam' : 'call'} size={18} color="#fff" />
            )}
          </View>
          <View style={styles.textWrap}>
            <Text style={styles.title} numberOfLines={1}>
              Ongoing group call{candidate.groupName ? ` · ${candidate.groupName}` : ''}
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
