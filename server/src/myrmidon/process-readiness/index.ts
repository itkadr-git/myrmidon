// server/src/myrmidon/process-readiness/index.ts
//
// myrmidon(1.6.6 PROCS-1.5): wiring of the readiness module — the per-process
// `/internal/ready`, the aggregate `/healthz` the balancer polls, and the
// helper that keeps the bus check honest.

export {
  HEALTHZ_REASONS,
  NOT_READY_STATUS,
  READINESS_CHECK_IDS,
  READY_STATUS,
  SUPERVISOR_HEALTH_STATES,
  healthzVerdict,
  processReady,
  readinessBody,
  supervisorApiCounts,
} from "./domain.js";
export { myrmidonProcessReadinessRoutes } from "./routes.js";
export {
  READINESS_PROBE_TIMEOUT_MS,
  bindProcessBusReadiness,
  createProcessReadiness,
  processSupervisorForHealthz,
  registerProcessSupervisor,
} from "./service.js";
export type {
  HealthzApiCounts,
  HealthzBody,
  HealthzInput,
  HealthzReason,
  HealthzVerdict,
  ProcessReadinessSnapshot,
  ProcessSupervisorReadinessSource,
  ReadinessCheck,
  ReadinessCheckId,
  ReadinessCheckStatus,
  ReadinessHttpStatus,
  SupervisorChildView,
  SupervisorHealthState,
} from "./domain.js";
export type { BoardProcessRole } from "../process-registry/domain.js";
export type { ProcessReadinessRouteDeps } from "./routes.js";
export type {
  ProcessBusLike,
  ProcessBusReadinessState,
  ProcessReadiness,
  ProcessReadinessOptions,
} from "./service.js";