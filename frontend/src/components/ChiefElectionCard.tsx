/**
 * ChiefElectionCard — safety-net "Chief Admin election" for a chief-less group
 * or sub group. Renders inside Group Info (app/group/[id].tsx).
 *
 * Backed by the web team's live Convex `chiefElections.*` contract
 * (/app/native-chief-election-contract.json):
 *   • getActiveElection (reactive query) drives the whole card.
 *   • startElection      — start + auto-nominate yourself.
 *   • proposeSelf        — nominate yourself into an open election.
 *   • withdrawCandidacy  — pull your own candidacy.
 *   • castVote           — one changeable vote per member; winner installed at majority.
 *   • cancelElection     — starter or any admin may cancel.
 *
 * The card renders NOTHING while the group has an effective Chief Admin (the
 * common case). It only appears for legacy chief-less groups, so it never
 * clashes with the automatic chief-succession flow. On a win, the backend emits
 * the usual silent `chiefTransferred` system message + the reactive admin info
 * updates, so no extra local plumbing is needed.
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { api } from '../convexApi';
import { useSafeConvexQuery } from '../hooks/useSafeConvexQuery';
import { Colors } from '../theme';

type Candidate = { userId: string; votes: number; proposedAt?: string };

type ElectionState = {
  election: { _id: string; status: string; startedBy?: string; startedAt?: string } | null;
  candidates?: Candidate[];
  myVote?: string | null;
  iAmCandidate?: boolean;
  isMember?: boolean;
  hasChief?: boolean;
  canStart?: boolean;
  memberCount?: number;
  majorityThreshold?: number;
};

export default function ChiefElectionCard({
  conversationId,
  isSubGroup,
  resolveName,
  isAdmin,
  myId,
}: {
  conversationId: string;
  isSubGroup: boolean;
  resolveName: (userId: string) => string;
  isAdmin: boolean;
  myId: string | null;
}) {
  const { data: state } = useSafeConvexQuery<ElectionState | null>(
    (api as any).chiefElections?.getActiveElection,
    conversationId ? { conversationId } : {},
    null,
    !!conversationId,
  );

  const startElectionM = useMutation((api as any).chiefElections?.startElection);
  const proposeSelfM = useMutation((api as any).chiefElections?.proposeSelf);
  const withdrawM = useMutation((api as any).chiefElections?.withdrawCandidacy);
  const castVoteM = useMutation((api as any).chiefElections?.castVote);
  const cancelM = useMutation((api as any).chiefElections?.cancelElection);

  const [busy, setBusy] = useState<string | null>(null);
  const groupWord = isSubGroup ? 'sub group' : 'group';

  const run = useCallback(
    async (key: string, fn: () => Promise<any>, onOk?: (r: any) => void) => {
      if (busy) return;
      setBusy(key);
      try {
        const r = await fn();
        onOk?.(r);
      } catch (err: any) {
        const msg = String(err?.message || err || '');
        if (msg.includes('CONFLICT')) {
          Alert.alert('Chief Admin', `This ${groupWord} already has a Chief Admin now.`);
        } else {
          Alert.alert('Something went wrong', msg || 'Please try again.');
        }
      } finally {
        setBusy(null);
      }
    },
    [busy, groupWord],
  );

  // Nothing to show unless the backend says this group is chief-less (an open
  // election, or the ability to start one). While a chief exists → render null.
  if (!state) return null;
  const election = state.election;
  if (!election && !state.canStart && state.hasChief !== false) return null;
  if (!election && state.hasChief) return null;

  const memberCount = state.memberCount ?? 0;
  const majority = state.majorityThreshold ?? Math.floor(memberCount / 2) + 1;

  // ── No open election yet — invite members to start one ──────────────────────
  if (!election) {
    return (
      <View style={styles.card} testID="chief-election-card">
        <View style={styles.headerRow}>
          <Ionicons name="ribbon-outline" size={18} color={Colors.primary} />
          <Text style={styles.headerText}>No Chief Admin</Text>
        </View>
        <Text style={styles.body}>
          This {groupWord} has no Chief Admin. Any member can start an election and propose
          themselves. A candidate needs a majority ({majority} of {memberCount}) to be elected.
        </Text>
        {state.canStart ? (
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() =>
              run('start', () => startElectionM({ conversationId }))
            }
            disabled={busy === 'start'}
            testID="chief-election-start"
          >
            {busy === 'start' ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <>
                <Ionicons name="megaphone-outline" size={16} color={Colors.white} />
                <Text style={styles.primaryBtnText}>Propose myself as Chief Admin</Text>
              </>
            )}
          </TouchableOpacity>
        ) : (
          <Text style={styles.hint}>Only members of this {groupWord} can start an election.</Text>
        )}
      </View>
    );
  }

  // ── Live election ───────────────────────────────────────────────────────────
  const candidates = state.candidates || [];
  const myVote = state.myVote || null;
  const iAmCandidate = !!state.iAmCandidate;
  const canCancel = isAdmin || (!!myId && election.startedBy === myId);

  return (
    <View style={styles.card} testID="chief-election-card">
      <View style={styles.headerRow}>
        <Ionicons name="ribbon" size={18} color={Colors.primary} />
        <Text style={styles.headerText}>Chief Admin election</Text>
      </View>
      <Text style={styles.body}>
        Majority to win: {majority} of {memberCount} members. Tap a candidate to vote — you can
        change your vote any time.
      </Text>

      {candidates.length === 0 ? (
        <Text style={styles.hint}>No candidates yet. Propose yourself below.</Text>
      ) : (
        candidates.map((c) => {
          const isMine = myVote === c.userId;
          const pct = memberCount > 0 ? Math.min(100, Math.round((c.votes / memberCount) * 100)) : 0;
          return (
            <TouchableOpacity
              key={c.userId}
              style={[styles.candidateRow, isMine ? styles.candidateRowActive : null]}
              onPress={() =>
                run(`vote-${c.userId}`, () => castVoteM({ conversationId, candidateId: c.userId }), (r) => {
                  if (r?.winnerId) {
                    Alert.alert('Chief Admin elected', `${resolveName(String(r.winnerId))} is now the Chief Admin.`);
                  }
                })
              }
              disabled={!!busy}
              testID={`chief-election-vote-${c.userId}`}
            >
              <View style={styles.candidateBarBg}>
                <View style={[styles.candidateBarFill, { width: `${pct}%` }]} />
              </View>
              <View style={styles.candidateContent}>
                <View style={styles.candidateNameWrap}>
                  {isMine ? (
                    <Ionicons name="checkmark-circle" size={16} color={Colors.primary} style={{ marginRight: 6 }} />
                  ) : (
                    <Ionicons name="ellipse-outline" size={16} color={Colors.textSecondary} style={{ marginRight: 6 }} />
                  )}
                  <Text style={styles.candidateName} numberOfLines={1}>
                    {resolveName(c.userId)}
                  </Text>
                </View>
                <Text style={styles.candidateVotes}>{c.votes}</Text>
              </View>
            </TouchableOpacity>
          );
        })
      )}

      <View style={styles.footerRow}>
        {iAmCandidate ? (
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => run('withdraw', () => withdrawM({ conversationId }))}
            disabled={busy === 'withdraw'}
            testID="chief-election-withdraw"
          >
            {busy === 'withdraw' ? (
              <ActivityIndicator size="small" color={Colors.textPrimary} />
            ) : (
              <Text style={styles.secondaryBtnText}>Withdraw</Text>
            )}
          </TouchableOpacity>
        ) : state.isMember ? (
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => run('propose', () => proposeSelfM({ conversationId }))}
            disabled={busy === 'propose'}
            testID="chief-election-propose"
          >
            {busy === 'propose' ? (
              <ActivityIndicator size="small" color={Colors.textPrimary} />
            ) : (
              <Text style={styles.secondaryBtnText}>Propose myself</Text>
            )}
          </TouchableOpacity>
        ) : null}
        {canCancel ? (
          <TouchableOpacity
            style={[styles.secondaryBtn, styles.cancelBtn]}
            onPress={() =>
              Alert.alert('Cancel election?', 'This ends the current vote for everyone.', [
                { text: 'Keep', style: 'cancel' },
                { text: 'Cancel election', style: 'destructive', onPress: () => run('cancel', () => cancelM({ conversationId })) },
              ])
            }
            disabled={busy === 'cancel'}
            testID="chief-election-cancel"
          >
            {busy === 'cancel' ? (
              <ActivityIndicator size="small" color="#c0392b" />
            ) : (
              <Text style={[styles.secondaryBtnText, { color: '#c0392b' }]}>Cancel</Text>
            )}
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 16,
    padding: 16,
    borderRadius: 16,
    backgroundColor: 'rgba(233,181,59,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(233,181,59,0.35)',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  headerText: { fontSize: 15, fontWeight: '800', color: Colors.textPrimary },
  body: { fontSize: 13, lineHeight: 19, color: Colors.textSecondary, marginBottom: 12 },
  hint: { fontSize: 12, color: Colors.textSecondary, fontStyle: 'italic', marginTop: 4 },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    paddingVertical: 12,
    borderRadius: 12,
    minHeight: 48,
  },
  primaryBtnText: { color: Colors.white, fontSize: 15, fontWeight: '700' },
  candidateRow: {
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.04)',
    marginBottom: 8,
    minHeight: 48,
    justifyContent: 'center',
  },
  candidateRowActive: { borderWidth: 1.5, borderColor: Colors.primary },
  candidateBarBg: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent' },
  candidateBarFill: { height: '100%', backgroundColor: 'rgba(233,181,59,0.22)' },
  candidateContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  candidateNameWrap: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  candidateName: { fontSize: 15, fontWeight: '600', color: Colors.textPrimary, flexShrink: 1 },
  candidateVotes: { fontSize: 15, fontWeight: '800', color: Colors.primary, marginLeft: 10 },
  footerRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  secondaryBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.05)',
    minHeight: 44,
  },
  secondaryBtnText: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  cancelBtn: { backgroundColor: 'rgba(192,57,43,0.08)' },
});
