// server/src/myrmidon/lesson-distill/index.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-4): the module's public surface.

export {
  LESSON_FACT_TYPE,
  LESSON_SUGGESTION_MARKER,
  MAX_LESSONS_PER_PASS,
  MAX_SUGGESTIONS_PER_PASS,
  REGULATION_REPEAT_THRESHOLD,
  candidateSuggestionBody,
  candidateSuggestionRationale,
  groupLessonOccurrences,
  isLessonUnit,
  lessonWindow,
  normalizeLessonText,
  occurrenceInWindow,
  selectRegulationCandidates,
} from "./domain.js";
export type { LessonGroup, LessonOccurrence, LessonWindow, RegulationCandidate } from "./domain.js";
export { collectLessons, listCompanyAgentIds, listCompanyIds, MAX_LESSONS_PER_BANK } from "./raw.js";
export { runLessonDistillPass } from "./service.js";
export type { LessonDistillPassResult } from "./service.js";
export { resolveLessonDistillSettings, DEFAULT_LESSON_DISTILL_SETTINGS } from "./settings.js";
export type { LessonDistillSettings } from "./settings.js";
export { startLessonDistillSweep, stopLessonDistillSweep } from "./startup.js";
