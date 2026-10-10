// server/src/myrmidon/project-token-quota/index.ts
//
// myrmidon(1.6.6 QUOTA-V2): the wiring point of the project token quota.
// app.ts mounts `projectTokenQuotaRoutes` from here; the enqueue check the
// heartbeat performs and the cost-event usage hook live in `service.ts`.

export { projectTokenQuotaRoutes } from "./routes.js";
export {
  currentUtcDayWindow,
  currentIsoWeekWindow,
  tokensOfCostEvent,
  readProjectTokenQuota,
  readProjectTokenQuotaStatus,
  upsertProjectTokenQuota,
  getProjectTokenQuotaBlock,
  recordProjectTokenUsage,
  PROJECT_TOKEN_QUOTA_SKIP_REASON,
  type ProjectTokenQuotaRow,
  type ProjectTokenQuotaStatus,
} from "./service.js";
