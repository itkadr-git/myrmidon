// server/src/myrmidon/evals/index.ts
//
// myrmidon(1.6-EVALS): the entry point of the reference-task evaluation
// path. The domain (types, threshold, SKILL-LIFECYCLE seam), the judge
// (gateway LLM), the seed corpus, the run service and the board REST routes
// are re-exported from here so the rest of the server imports one module.
//
// The judge contour mirrors the OCR contour: MYRMIDON_EVALS_BASE_URL,
// MYRMIDON_EVALS_KEY_SECRET (company secret *name*, never the value),
// MYRMIDON_EVALS_MODEL (default: a free DashScope model) and the Langfuse
// export flag. Unset means off, with a stable "not configured" error.

export {
  EVAL_VERDICTS,
  isEvalVerdict,
  EVAL_TASK_KINDS,
  isEvalTaskKind,
  EVAL_SUBJECT_KINDS,
  isEvalSubjectKind,
  isEvalRubric,
  DEFAULT_EVAL_REGRESSION_DROP,
  aggregateEvalScores,
  checkEvalRegressionThreshold,
  decideEvalVerdictForLifecycle,
  isEvalVerdictForLifecycle,
  type EvalVerdict,
  type EvalTaskKind,
  type EvalSubjectKind,
  type EvalRubric,
  type EvalRubricCriterion,
  type EvalTaskScore,
  type EvalRunScores,
  type EvalRunOutcome,
  type EvalThresholdDecision,
  type EvalVerdictForLifecycle,
  type EvalSkillLifecyclePort,
} from "./domain.js";
export {
  EVALS_BASE_URL_ENV,
  EVALS_KEY_SECRET_ENV,
  EVALS_MODEL_ENV,
  EVALS_TIMEOUT_SEC_ENV,
  EVALS_LANGFUSE_FLAG_ENV,
  DEFAULT_EVALS_MODEL,
  readEvalsSettings,
  evalsSettingsProblem,
  createJudge,
  createHeuristicJudge,
  parseJudgeResponse,
  EvalJudgeError,
  type EvalsSettings,
  type JudgePort,
  type JudgeTaskResult,
  type JudgeDeps,
  DEFAULT_EVALS_JUDGE_PRIORITY_MODELS,
  parseJudgePriorityModels,
  EVALS_JUDGE_PRIORITY_MODELS_ENV,
} from "./judge.js";
// myrmidon(1.6.5 EVALS-JUDGE-FAMILY): family detection, the verified served
// model list and the candidate order.
export {
  SERVED_FREE_GATEWAY_MODELS,
  DEFAULT_JUDGE_PRIORITY_MODELS,
  getModelFamily,
  isSameJudgeFamily,
  judgeCandidateOrder,
} from "./model-family.js";
export {
  createLangfuseScoreExporter,
  noopScoreExporter,
  readLangfuseExportSettings,
  type EvalsScoreExporter,
  type LangfuseExportSettings,
} from "./langfuse.js";
export {
  ENGINEER_REFERENCE_TASKS,
  EVALS_PILOT_ROLE,
  seedReferenceTasks,
  validateSeedCorpus,
  type SeedReferenceTask,
  type SeedResult,
} from "./seed.js";
export {
  createEvalsService,
  EvalsServiceError,
  type EvalsService,
  type EvalsServiceDeps,
  type EvalRunInput,
  type EvalRunRecord,
  type EvalTaskRow,
  type EvalRunStatus,
  type RunOutcome,
} from "./service.js";
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-9): the evals gate of knowledge — the
// lifecycle hook, its decision, and the knowledge sink.
export {
  KNOWLEDGE_GATE_TRIGGERS,
  isKnowledgeGateTrigger,
  subjectKindForTrigger,
  KNOWLEDGE_GATE_VERDICTS,
  HALLUCINATION_CRITERION_PATTERN,
  KNOWLEDGE_GATE_ACTOR_ID,
  KnowledgeGateError,
  hallucinationFromScores,
  decideKnowledgeGateVerdict,
  createKnowledgeGate,
  createKnowledgeGateSink,
  type KnowledgeGateTrigger,
  type KnowledgeGateVerdict,
  type KnowledgeGateActor,
  type KnowledgeGateInput,
  type KnowledgeGateOutcome,
  type KnowledgeGateDeps,
  type KnowledgeGate,
  type KnowledgeGateSink,
  type KnowledgeGateModulePort,
  type KnowledgeGateSinkOptions,
  type KnowledgeGateJournalEntry,
  type KnowledgeGateOwnerNotice,
  type KnowledgeGateRollbackRequest,
} from "./knowledge-gate.js";
export { myrmidonEvalsRoutes, EVALS_ACTOR_ID, type EvalsRoutesDeps } from "./routes.js";
