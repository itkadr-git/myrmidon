// server/src/modules/issues/index.ts
//
// myrmidon(1.7 POST-TASK-REFLECT, OPE-12095): public interface for the issues module.
// Exports domain types, application use cases, and adapters.

export {
  computeReflectJobDedupKey,
  shouldEnqueueReflectJob,
  REFLECT_JOB_STATUSES,
  type ReflectJobStatus,
  REFLECT_JOB_TYPES,
  type ReflectJobType,
  type ReflectJob,
  type NewReflectJobInput,
} from "./domain/reflect-job.js";

export {
  handleIssueStatusChange,
  createOnIssueStatusChangeHook,
  type QueueReflectJobDeps,
} from "./application/queue-reflect-job.js";

export type {
  ReflectJobWriter,
  ReflectJobReader,
  ReflectJobRepository,
  EnqueueReflectJobResult,
  IssueStatusChangeEvent,
  StatusChangeHookResult,
  ModuleLogger,
} from "./application/ports.js";

export {
  createPostgresReflectJobRepository,
  mapRowToReflectJob,
} from "./adapters/postgres.js";

export { InMemoryReflectJobRepository } from "./adapters/in-memory.js";
