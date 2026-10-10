// server/src/myrmidon/lesson-distill/domain.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-4): the pure domain of the lesson distiller —
// POST-TASK-REFLECT's landing step. Lessons the agents retained in hindsight
// over the window (default 24 h) are grouped by normalized text; a lesson
// seen `REGULATION_REPEAT_THRESHOLD` times or more becomes a
// `regulation_candidate` knowledge SUGGESTION — never a page written
// directly (§4.5: the curator cast polishes candidates). One lesson seen once
// stays in the bank: a single mention is not yet a rule. This file has no
// database and no I/O.

/** What a hindsight unit must say to count as a lesson (§6 L-4). */
export const LESSON_FACT_TYPE = "lesson";

/** `regulation_candidate` fires at >= 2 repeats inside the window (§6 L-4). */
export const REGULATION_REPEAT_THRESHOLD = 2;

/** One human package: at most 10 candidates per pass (mirrors K-5's cap). */
export const MAX_SUGGESTIONS_PER_PASS = 10;

/** Raw-material cap per pass — a runaway bank must not pin the sweep. */
export const MAX_LESSONS_PER_PASS = 500;

/** One hindsight lesson occurrence, already scoped to one company's agents. */
export interface LessonOccurrence {
  /** The hindsight bank the lesson lives in (which agent's memory). */
  bankId: string;
  /** The hindsight unit id — the candidate's evidence line. */
  memoryId: string;
  text: string;
  factType: string | null;
  /** When the unit happened / was retained, ISO — the window filter reads this. */
  at: string;
}

/** A grouped lesson: same normalized text seen one or more times. */
export interface LessonGroup {
  /** The normalized grouping key. */
  key: string;
  /** The most recent original text — the suggestion body's source. */
  representative: string;
  repeats: number;
  /** Newest first. */
  occurrences: Array<Pick<LessonOccurrence, "bankId" | "memoryId" | "at">>;
}

/** A grouped lesson that crossed the threshold, ready to become a suggestion. */
export interface RegulationCandidate {
  representative: string;
  repeats: number;
  /** The hindsight unit the suggestion cites as its primary source. */
  primaryMemoryId: string;
  /** Every backing unit, for the rationale's evidence line. */
  evidenceMemoryIds: string[];
}

/**
 * Is this hindsight unit a lesson? The fact type decides (`lesson`); a unit
 * without a fact type but tagged `lesson` counts too — the retain path tags
 * what it cannot type.
 */
export function isLessonUnit(unit: Pick<LessonOccurrence, "factType" | "text">, tags: readonly string[] = []): boolean {
  const fact = unit.factType?.trim().toLowerCase() ?? null;
  if (fact === LESSON_FACT_TYPE) return true;
  return fact === null && tags.some((tag) => tag.trim().toLowerCase() === LESSON_FACT_TYPE);
}

/**
 * The grouping key: lowercased, whitespace-collapsed, punctuation-stripped
 * text. Two agents phrasing the same rule slightly differently still meet.
 */
export function normalizeLessonText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/g, "");
}

/** The window: `[since, until)` ending at the pass. */
export interface LessonWindow {
  since: Date;
  until: Date;
}

export function lessonWindow(now: Date, windowMs: number): LessonWindow {
  return { since: new Date(now.getTime() - windowMs), until: now };
}

export function occurrenceInWindow(occurrence: LessonOccurrence, window: LessonWindow): boolean {
  const at = Date.parse(occurrence.at);
  if (!Number.isFinite(at)) return false;
  return at >= window.since.getTime() && at < window.until.getTime();
}

/**
 * Group occurrences by normalized text. Ties break toward more repeats, then
 * alphabetically, so a pass is reproducible.
 */
export function groupLessonOccurrences(occurrences: readonly LessonOccurrence[]): LessonGroup[] {
  const byKey = new Map<string, LessonGroup>();
  for (const occurrence of occurrences) {
    const key = normalizeLessonText(occurrence.text);
    if (!key) continue;
    const group = byKey.get(key) ?? {
      key,
      representative: occurrence.text,
      repeats: 0,
      occurrences: [],
    };
    group.repeats += 1;
    // The newest phrasing wins as the representative.
    if (Date.parse(occurrence.at) >= Date.parse(group.occurrences[0]?.at ?? occurrence.at)) {
      group.representative = occurrence.text;
    }
    group.occurrences.push({ bankId: occurrence.bankId, memoryId: occurrence.memoryId, at: occurrence.at });
    byKey.set(key, group);
  }
  return [...byKey.values()].sort((a, b) => b.repeats - a.repeats || (a.key < b.key ? -1 : 1));
}

/**
 * The threshold rule: a group with repeats >= threshold becomes one
 * `regulation_candidate` — the group, not each mention (§4.5: never one line
 * per occurrence; merge what proves the same claim).
 */
export function selectRegulationCandidates(
  groups: readonly LessonGroup[],
  threshold: number = REGULATION_REPEAT_THRESHOLD,
): RegulationCandidate[] {
  return groups
    .filter((group) => group.repeats >= Math.max(1, threshold))
    .map((group) => {
      const newestFirst = [...group.occurrences].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      return {
        representative: group.representative,
        repeats: group.repeats,
        primaryMemoryId: newestFirst[0]!.memoryId,
        evidenceMemoryIds: newestFirst.map((occurrence) => occurrence.memoryId),
      };
    });
}

/** Suggestion body marker: the curator filters the queue by it (K-5's pattern). */
export const LESSON_SUGGESTION_MARKER = "lesson-distill:regulation_candidate";

/** The single-line suggestion body for one candidate. */
export function candidateSuggestionBody(candidate: RegulationCandidate): string {
  const singleLine = candidate.representative.replace(/\s*\n\s*/g, " ").trim();
  return `[${LESSON_SUGGESTION_MARKER}] ${singleLine}`;
}

/** The single-line rationale: repeats + evidence ids. */
export function candidateSuggestionRationale(candidate: RegulationCandidate, window: LessonWindow): string {
  return [
    `repeats: ${candidate.repeats} within ${window.since.toISOString()} .. ${window.until.toISOString()}`,
    `evidence: ${candidate.evidenceMemoryIds.join(", ")}`,
  ].join(" — ");
}
