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
import { useCallback, useState } from 'react';
import { useAction, useMutation } from 'convex/react';
import { api } from '../../convexApi';
import { useSafeConvexQuery } from '../../hooks/useSafeConvexQuery';
import { useAuth } from '../../providers/AuthProvider';

/** My rooms + create/join. */
export function useMyRooms() {
  const { isAuthenticated } = useAuth();
  const { data: rooms, loading } = useSafeConvexQuery<any[]>(
    (api as any).study?.rooms?.listMyRooms,
    {},
    [],
    isAuthenticated,
  );
  const createRoom = useMutation((api as any).study.rooms.createRoom);
  const joinRoom = useMutation((api as any).study.rooms.joinRoom);
  const previewRoomByCode = useAction((api as any).study.rooms.previewRoomByCode);
  return { rooms: rooms || [], loading, createRoom, joinRoom, previewRoomByCode };
}

/** A single room (null for non-members) + membership/admin mutations. */
export function useRoom(roomId: string | null) {
  const { data: room, loading } = useSafeConvexQuery<any>(
    (api as any).study?.rooms?.getRoom,
    roomId ? { roomId } : undefined,
    null,
    !!roomId,
  );
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
  const submitRoomQuizAttempt = useAction((api as any).study.rooms.submitRoomQuizAttempt);
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
