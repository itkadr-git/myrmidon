// server/src/myrmidon/lesson-distill/service.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-4): the pass. For one company: collect the
// lessons its agents' hindsight banks retained over the window (raw.ts),
// group them, and turn every group that crossed the repeat threshold into a
// `regulation_candidate` knowledge suggestion — pending, single-line,
// marked, with the evidence in the rationale. The pass never writes a page
// (§4.5: the curator decides; the distiller only proposes) and never inserts
// the same candidate twice in a row (an identical pending suggestion is
// refreshed in place instead).
//
// The pass also writes one journal event per company sweep
// (`knowledge.lesson_distill.pass`) so the K-9-style quality journal can show
// what the distiller saw.

import { and, eq } from "drizzle-orm";
import { knowledgeEvents, knowledgeSuggestions, type Db } from "@myrmidon/db";
import {
  createKnowledgeModule,
  type KnowledgeModule,
} from "../knowledge/service.js";
import {
  MAX_SUGGESTIONS_PER_PASS,
  REGULATION_REPEAT_THRESHOLD,
  candidateSuggestionBody,
  candidateSuggestionRationale,
  groupLessonOccurrences,
  lessonWindow,
  selectRegulationCandidates,
  type LessonWindow,
} from "./domain.js";
import { collectLessons, type LessonCollectorDeps } from "./raw.js";

const knowledgeSuggestionsTable = knowledgeSuggestions;

export interface LessonDistillDeps extends LessonCollectorDeps {
  /** The knowledge module factory, overridable in tests. */
  knowledge?: KnowledgeModule;
  now?: () => Date;
  /** Repeat threshold override (tests); default 2 (§6 L-4). */
  repeatThreshold?: number;
  /** Window length override, ms; default 24 h (§6 L-4, settings.windowHours). */
  windowMs?: number;
}

export interface LessonDistillPassResult {
  window: LessonWindow;
  lessonsSeen: number;
  groupsFormed: number;
  candidatesFound: number;
  suggestionsCreated: number;
  suggestionsRefreshed: number;
  /** Truncated to MAX_SUGGESTIONS_PER_PASS. */
  candidates: Array<{ body: string; repeats: number; primaryMemoryId: string }>;
}

export async function runLessonDistillPass(
  deps: LessonDistillDeps,
  companyId: string,
): Promise<LessonDistillPassResult> {
  const now = deps.now ?? (() => new Date());
  const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
  const window = lessonWindow(now(), deps.windowMs ?? DEFAULT_WINDOW_MS);
  const threshold = deps.repeatThreshold ?? REGULATION_REPEAT_THRESHOLD;
  const knowledge = deps.knowledge ?? createKnowledgeModule(deps.db, companyId);

  const lessons = await collectLessons(deps, companyId, window);
  const groups = groupLessonOccurrences(lessons);
  const candidates = selectRegulationCandidates(groups, threshold).slice(0, MAX_SUGGESTIONS_PER_PASS);

  const actor = { actorType: "system", actorId: null, kind: null } as const;
  let created = 0;
  let refreshed = 0;
  for (const candidate of candidates) {
    const body = candidateSuggestionBody(candidate);
    const rationale = candidateSuggestionRationale(candidate, window);
    // One lesson group == one pending suggestion. A still-pending twin from a
    // previous pass is refreshed (newer evidence), not duplicated; the
    // dedupe key is the marker + normalized text carried in the body.
    const existing = await findPendingDuplicate(deps.db, companyId, body);
    if (existing) {
      await deps.db
        .update(knowledgeSuggestionsTable)
        .set({ rationale })
        .where(eq(knowledgeSuggestionsTable.id, existing));
      refreshed += 1;
      continue;
    }
    await knowledge.suggest(actor, {
      body,
      rationale,
      sourceKind: "run",
      sourceRef: `hindsight:${candidate.primaryMemoryId}`,
    });
    created += 1;
  }

  await journalPass(deps.db, companyId, window, {
    lessonsSeen: lessons.length,
    groupsFormed: groups.length,
    candidatesFound: candidates.length,
    suggestionsCreated: created,
    suggestionsRefreshed: refreshed,
  });

  return {
    window,
    lessonsSeen: lessons.length,
    groupsFormed: groups.length,
    candidatesFound: candidates.length,
    suggestionsCreated: created,
    suggestionsRefreshed: refreshed,
    candidates: candidates.map((candidate) => ({
      body: candidateSuggestionBody(candidate),
      repeats: candidate.repeats,
      primaryMemoryId: candidate.primaryMemoryId,
    })),
  };
}

/** The still-pending suggestion with the same body, if any. */
async function findPendingDuplicate(db: Db, companyId: string, body: string): Promise<string | null> {
  const [row] = await db
    .select({ id: knowledgeSuggestionsTable.id })
    .from(knowledgeSuggestionsTable)
    .where(
      and(
        eq(knowledgeSuggestionsTable.companyId, companyId),
        eq(knowledgeSuggestionsTable.body, body),
        eq(knowledgeSuggestionsTable.status, "pending"),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

interface PassJournalPayload {
  lessonsSeen: number;
  groupsFormed: number;
  candidatesFound: number;
  suggestionsCreated: number;
  suggestionsRefreshed: number;
}

/** The quality-journal line (K-9's pattern): one event per company pass. */
async function journalPass(
  db: Db,
  companyId: string,
  window: LessonWindow,
  payload: PassJournalPayload,
): Promise<void> {
  await db.insert(knowledgeEvents).values({
    companyId,
    nestId: companyId,
    itemId: null,
    event: "knowledge.lesson_distill.pass",
    payload: { ...payload, windowSince: window.since.toISOString(), windowUntil: window.until.toISOString() },
    actorType: "system",
    actorId: null,
  });
}
