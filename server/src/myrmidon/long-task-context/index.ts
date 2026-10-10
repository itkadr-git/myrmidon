// server/src/myrmidon/long-task-context/index.ts
//
// myrmidon(1.6.6 LONG-TASK-CONTEXT): the module's public surface.

export {
  COMPRESSION_TIMEOUT_ERROR_SIGNATURES,
  buildLongTaskContextResetNotice,
  isCompressionTimeoutError,
  issueThreadReference,
  planLongTaskContextReset,
  type LongTaskContextPlan,
} from "./domain.js";
export {
  LONG_TASK_CONTEXT_ENV_KEYS,
  readLongTaskContextSettings,
  resolveLongTaskContextSettings,
  writeLongTaskContextSettings,
  type LongTaskContextSettingSource,
  type LongTaskContextSettingsService,
} from "./settings.js";
export {
  evaluateLongTaskContextReset,
  loadTaskPromptRun,
  resolveLongTaskContextWindow,
  type LongTaskContextEvaluation,
  type TaskPromptRun,
} from "./pressure.js";