// server/src/myrmidon/hindsight/reflection/index.ts
//
// myrmidon(1.7 POST-TASK-REFLECT): public surface of the reflection domain.

export {
  FAILURE_KINDS,
  type FailureKind,
  DEFAULT_LESSON_TTL_DAYS,
  type LessonRecord,
  type CreateLessonRecordInput,
  type HindsightRetainMetadata,
  type HindsightRetainItem,
  type HindsightRetainPayload,
  type FailureCategorizationInput,
  type HindsightRetainClientLike,
  type ReflectionServiceDeps,
} from "./types.js";
export * from "./schema.js";
export * from "./lesson-formatter.js";
export {
  categorizeFailure,
  categorizeFailureOrNull,
  computeExpiresAt,
  createLessonRecord,
  createReflectionService,
  type CreateLessonOptions,
  type ReflectionService,
} from "./service.js";
