/**
 * useRevision — Smilers Study AI (Phase 3: Revision Studio) client bindings.
 *
 * All logic runs on Convex (web team's `native-study-ai-revision-contract`).
 * Generation actions are Premium-gated (throw ConvexError PREMIUM_REQUIRED);
 * everything else is ungated queries/mutations. Grading is server-side —
 * we submit answers and render the returned `graded[]`, never grade locally.
 * New material starts `isSaved=false` (prompt to save). LaTeX fields
 * (`promptLatex` / `finalAnswerLatex`) render via <LatexView/> WITHOUT `$`.
 */
import { useCallback, useMemo, useState } from 'react';
import { useAction, useMutation } from 'convex/react';
import { api } from '../../convexApi';
import { useSafeConvexQuery } from '../../hooks/useSafeConvexQuery';
import { useAuth } from '../../providers/AuthProvider';

export type FlashcardRating = 'again' | 'good' | 'easy';

export interface GenerateArgs {
  sourceSessionId?: string;
  sourceText?: string;
  subject?: string;
  topic?: string;
}

/** Premium-gated generation actions. Each returns the new item id. */
export function useRevisionGenerate() {
  const generateQuiz = useAction((api as any).study.revisionAi.generateQuiz);
  const generateFlashcards = useAction((api as any).study.revisionAi.generateFlashcards);
  const generateSummary = useAction((api as any).study.revisionAi.generateSummary);
  const generateStudyPlan = useAction((api as any).study.revisionAi.generateStudyPlan);
  const [generating, setGenerating] = useState(false);

  const run = useCallback(
    async (
      kind: 'quiz' | 'flashcards' | 'summary' | 'study_plan',
      args: GenerateArgs,
    ): Promise<any> => {
      setGenerating(true);
      try {
        const payload = {
          sourceSessionId: args.sourceSessionId,
          sourceText: args.sourceText,
          subject: args.subject,
          topic: args.topic,
        } as any;
        if (kind === 'quiz') return await generateQuiz(payload);
        if (kind === 'flashcards') return await generateFlashcards(payload);
        if (kind === 'summary') return await generateSummary(payload);
        return await generateStudyPlan(payload);
      } finally {
        setGenerating(false);
      }
    },
    [generateQuiz, generateFlashcards, generateSummary, generateStudyPlan],
  );

  return { run, generating };
}

/** Quizzes list + management. */
export function useQuizzes() {
  const { isAuthenticated } = useAuth();
  const { data: quizzes, loading } = useSafeConvexQuery<any[]>(
    (api as any).study?.revision?.listQuizzes,
    {},
    [],
    isAuthenticated,
  );
  const setQuizSaved = useMutation((api as any).study.revision.setQuizSaved);
  const deleteQuiz = useMutation((api as any).study.revision.deleteQuiz);
  return { quizzes: quizzes || [], loading, setQuizSaved, deleteQuiz };
}

export function useQuiz(quizId: string | null) {
  const { data, loading } = useSafeConvexQuery<any>(
    (api as any).study?.revision?.getQuiz,
    quizId ? { quizId } : undefined,
    null,
    !!quizId,
  );
  const submitQuizAttempt = useAction((api as any).study.revision.submitQuizAttempt);
  const setQuizSaved = useMutation((api as any).study.revision.setQuizSaved);
  return { quiz: data, loading, submitQuizAttempt, setQuizSaved };
}

/** Flashcard decks list + management. */
export function useDecks() {
  const { isAuthenticated } = useAuth();
  const { data: decks, loading } = useSafeConvexQuery<any[]>(
    (api as any).study?.revision?.listDecks,
    {},
    [],
    isAuthenticated,
  );
  const setDeckSaved = useMutation((api as any).study.revision.setDeckSaved);
  const deleteDeck = useMutation((api as any).study.revision.deleteDeck);
  return { decks: decks || [], loading, setDeckSaved, deleteDeck };
}

export function useDeck(deckId: string | null) {
  const { data: deck, loading } = useSafeConvexQuery<any>(
    (api as any).study?.revision?.getDeck,
    deckId ? { deckId } : undefined,
    null,
    !!deckId,
  );
  const { data: dueCards } = useSafeConvexQuery<any[]>(
    (api as any).study?.revision?.getDueCards,
    deckId ? { deckId } : undefined,
    [],
    !!deckId,
  );
  const reviewFlashcard = useMutation((api as any).study.revision.reviewFlashcard);
  const setDeckSaved = useMutation((api as any).study.revision.setDeckSaved);
  return { deck, dueCards: dueCards || [], loading, reviewFlashcard, setDeckSaved };
}

/** Notes = AI summaries + study plans (kind: 'summary' | 'study_plan'). */
export function useNotes() {
  const { isAuthenticated } = useAuth();
  const { data: notes, loading } = useSafeConvexQuery<any[]>(
    (api as any).study?.revision?.listNotes,
    {},
    [],
    isAuthenticated,
  );
  const setNoteSaved = useMutation((api as any).study.revision.setNoteSaved);
  const deleteNote = useMutation((api as any).study.revision.deleteNote);
  return { notes: notes || [], loading, setNoteSaved, deleteNote };
}

export function useNote(noteId: string | null) {
  const { data, loading } = useSafeConvexQuery<any>(
    (api as any).study?.revision?.getNote,
    noteId ? { noteId } : undefined,
    null,
    !!noteId,
  );
  const setNoteSaved = useMutation((api as any).study.revision.setNoteSaved);
  return { note: data, loading, setNoteSaved };
}

/** Progress + streaks (auto-logged by attempts/reviews; lessons manual). */
export function useStudyProgress() {
  const { isAuthenticated } = useAuth();
  const { data: progress } = useSafeConvexQuery<any>(
    (api as any).study?.progress?.getProgress,
    {},
    null,
    isAuthenticated,
  );
  const { data: recentActivity } = useSafeConvexQuery<any[]>(
    (api as any).study?.progress?.getRecentActivity,
    {},
    [],
    isAuthenticated,
  );
  const logLessonStudied = useMutation((api as any).study.progress.logLessonStudied);
  return useMemo(
    () => ({ progress, recentActivity: recentActivity || [], logLessonStudied }),
    [progress, recentActivity, logLessonStudied],
  );
}
