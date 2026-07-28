/**
 * useRooms — Smilers Study AI (Phase 4: Study Rooms) client bindings.
 *
 * Standalone social layer (NOT tied to Smilers group chat; the assistant
 * never reads chat messages). Rooms are joined via a 6-char uppercase code.
 * Everything is ungated EXCEPT `roomsAi.generateRoomQuiz` (Premium). Quiz
 * grading is server-side; leaderboards keep each member's best attempt.
 * `aiCanReadRoomContent` defaults OFF — generating with useRoomContent=true
 * while it's off throws FORBIDDEN.
 */
import { useCallback, useMemo, useState } from 'react';
import { useAction, useConvex, useMutation } from 'convex/react';
import { api } from '../../convexApi';
import { useSafeConvexQuery } from '../../hooks/useSafeConvexQuery';
import { useAuth } from '../../providers/AuthProvider';

// iter-399: the deployed backend returns a WRAPPED shape — `getRoom` →
// `{ room, myRole, members }` and `listMyRooms` → `[{ room, role, joinedAt }]`.
// The screens expect a FLAT room (they read `r._id`, `r.name`, `r.joinCode`,
// `r.role`/`myRole`, `r.members`). Flatten here so the id used for navigation
// is the real `room._id` (the old code read the wrapper's missing `_id`,
// navigating to `/study/rooms/undefined` → getRoom(null) → "not a member").
function flattenRoomListItem(item: any): any {
  if (item && typeof item === 'object' && item.room && typeof item.room === 'object') {
    return { ...item.room, role: item.role, myRole: item.role, joinedAt: item.joinedAt };
  }
  return item;
}
function flattenRoomDetail(raw: any): any {
  if (raw && typeof raw === 'object' && raw.room && typeof raw.room === 'object') {
    return {
      ...raw.room,
      myRole: raw.myRole,
      role: raw.myRole,
      members: Array.isArray(raw.members) ? raw.members : [],
    };
  }
  return raw;
}

/** My rooms + create/join. */
export function useMyRooms() {
  const { isAuthenticated } = useAuth();
  const { data: rooms, loading } = useSafeConvexQuery<any[]>(
    (api as any).study?.rooms?.listMyRooms,
    {},
    [],
    isAuthenticated,
  );
  const flatRooms = useMemo(
    () => (Array.isArray(rooms) ? rooms.map(flattenRoomListItem) : []),
    [rooms],
  );
  const createRoom = useMutation((api as any).study.rooms.createRoom);
  const joinRoom = useMutation((api as any).study.rooms.joinRoom);
  // iter-fork: `previewRoomByCode` is a read-only QUERY on the backend, but was
  // historically invoked as an action (`useAction`) — Convex rejects a
  // query-run-as-action at the routing layer BEFORE the handler runs, which
  // surfaced as "[CONVEX A(study/rooms:previewRoomByCode)] Server Error" while
  // the backend logs showed no handler failure. Invoke it as an imperative
  // query instead (it's called on-demand with a dynamic code, not reactively).
  // `previewRoomByCode` is a read-only QUERY (confirmed by the Convex team). It
  // was previously bound as `useAction`, which Convex rejects at routing before
  // the handler runs → "[CONVEX A(...)] Server Error" with no backend failure
  // logged. Invoke it as an on-demand query (dynamic code, not reactive).
  const convex = useConvex();
  const previewRoomByCode = useCallback(
    (args: { code: string }) => convex.query((api as any).study.rooms.previewRoomByCode, args),
    [convex],
  );
  return { rooms: flatRooms, loading, createRoom, joinRoom, previewRoomByCode };
}

/** A single room (null for non-members) + membership/admin mutations. */
export function useRoom(roomId: string | null) {
  const { data: raw, loading } = useSafeConvexQuery<any>(
    (api as any).study?.rooms?.getRoom,
    roomId ? { roomId } : undefined,
    null,
    !!roomId,
  );
  const room = useMemo(() => flattenRoomDetail(raw), [raw]);
  const leaveRoom = useMutation((api as any).study.rooms.leaveRoom);
  const updateRoom = useMutation((api as any).study.rooms.updateRoom);
  const regenerateJoinCode = useMutation((api as any).study.rooms.regenerateJoinCode);
  const setMemberRole = useMutation((api as any).study.rooms.setMemberRole);
  const removeMember = useMutation((api as any).study.rooms.removeMember);
  const deleteRoom = useMutation((api as any).study.rooms.deleteRoom);
  return {
    room,
    loading,
    leaveRoom,
    updateRoom,
    regenerateJoinCode,
    setMemberRole,
    removeMember,
    deleteRoom,
  };
}

/** Room quizzes (list/share/generate). */
export function useRoomQuizzes(roomId: string | null) {
  const { data: quizzes, loading } = useSafeConvexQuery<any[]>(
    (api as any).study?.rooms?.listRoomQuizzes,
    roomId ? { roomId } : undefined,
    [],
    !!roomId,
  );
  const shareQuizToRoom = useMutation((api as any).study.rooms.shareQuizToRoom);
  const deleteRoomQuiz = useMutation((api as any).study.rooms.deleteRoomQuiz);
  const generateRoomQuiz = useAction((api as any).study.roomsAi.generateRoomQuiz);
  const [generating, setGenerating] = useState(false);

  const generate = useCallback(
    async (args: {
      roomId: string;
      topic?: string;
      subject?: string;
      sourceText?: string;
      useRoomContent?: boolean;
    }) => {
      setGenerating(true);
      try {
        return await generateRoomQuiz(args as any);
      } finally {
        setGenerating(false);
      }
    },
    [generateRoomQuiz],
  );

  return { quizzes: quizzes || [], loading, shareQuizToRoom, deleteRoomQuiz, generate, generating };
}

/** A single room quiz + its leaderboard; server-side grading. */
export function useRoomQuiz(roomQuizId: string | null) {
  const { data, loading } = useSafeConvexQuery<any>(
    (api as any).study?.rooms?.getRoomQuiz,
    roomQuizId ? { roomQuizId } : undefined,
    null,
    !!roomQuizId,
  );
  // `submitRoomQuizAttempt` is a MUTATION (confirmed by the Convex team) — it
  // writes the attempt + leaderboard row. Was wrongly bound as `useAction`
  // → "[CONVEX A(...)] Server Error" with no backend failure logged.
  const submitRoomQuizAttempt = useMutation((api as any).study.rooms.submitRoomQuizAttempt);
  return { data, loading, submitRoomQuizAttempt };
}

/** Collaborative flashcard decks (any member can add cards). */
export function useRoomDecks(roomId: string | null) {
  const { data: decks, loading } = useSafeConvexQuery<any[]>(
    (api as any).study?.rooms?.listRoomDecks,
    roomId ? { roomId } : undefined,
    [],
    !!roomId,
  );
  const createRoomDeck = useMutation((api as any).study.rooms.createRoomDeck);
  const deleteRoomDeck = useMutation((api as any).study.rooms.deleteRoomDeck);
  return { decks: decks || [], loading, createRoomDeck, deleteRoomDeck };
}

export function useRoomDeck(roomDeckId: string | null) {
  const { data: deck, loading } = useSafeConvexQuery<any>(
    (api as any).study?.rooms?.getRoomDeck,
    roomDeckId ? { roomDeckId } : undefined,
    null,
    !!roomDeckId,
  );
  const addRoomCard = useMutation((api as any).study.rooms.addRoomCard);
  const deleteRoomCard = useMutation((api as any).study.rooms.deleteRoomCard);
  return { deck, loading, addRoomCard, deleteRoomCard };
}
