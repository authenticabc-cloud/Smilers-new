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

// iter-fork: some `study.rooms.*` entry points were historically invoked with
// the WRONG Convex function type from the client (e.g. a read-only query bound
// via `useAction`). Convex rejects a type-mismatched invocation at the routing
// layer — BEFORE the handler runs — so it surfaces as a generic
// "[CONVEX A(...)] Server Error" on the client while the backend logs show NO
// handler failure. Because this repo only ships stubbed generated types (we
// can't see whether a given fn is a query or mutation), call these on-demand
// endpoints type-agnostically: try the expected type, then fall back to the
// other ONLY on a function-TYPE mismatch (never on a genuine handler error).
async function callFlexible(
  convex: any,
  ref: any,
  args: any,
  preferMutation: boolean,
): Promise<any> {
  const order: ('mutation' | 'query')[] = preferMutation
    ? ['mutation', 'query']
    : ['query', 'mutation'];
  let lastError: any;
  for (const kind of order) {
    try {
      return kind === 'mutation'
        ? await convex.mutation(ref, args)
        : await convex.query(ref, args);
    } catch (errorValue: any) {
      lastError = errorValue;
      const msg = String(errorValue?.message || errorValue || '');
      // Retry the other type ONLY when Convex reports a type mismatch, e.g.
      // "...as Query, but it is defined as Mutation". A real handler error
      // ("Server Error") does NOT match, so it propagates unchanged.
      const isTypeMismatch =
        /as Query|as Mutation|as Action|is defined as|not a (query|mutation|action)/i.test(msg);
      if (!isTypeMismatch) throw errorValue;
    }
  }
  throw lastError;
}

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
  const convex = useConvex();
  const previewRoomByCode = useCallback(
    (args: { code: string }) => callFlexible(convex, (api as any).study.rooms.previewRoomByCode, args, false),
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
  // iter-fork: `submitRoomQuizAttempt` WRITES the attempt + leaderboard row, so
  // it's a mutation. It was wrongly bound as `useAction` → "[CONVEX A(...)]
  // Server Error" with no backend failure logged. Invoke type-agnostically
  // (prefer mutation) so it works regardless of the backend's exact registration.
  const convex = useConvex();
  const submitRoomQuizAttempt = useCallback(
    (args: { roomQuizId: string; answers: any[] }) =>
      callFlexible(convex, (api as any).study.rooms.submitRoomQuizAttempt, args, true),
    [convex],
  );
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
