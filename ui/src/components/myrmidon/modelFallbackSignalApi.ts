// myrmidon(BOT-RUNTIME-TUNING D2): API client for the model-fallback signal —
// the settings and the live per-agent share shown on the agent card.
//
//   GET /api/myrmidon/model-fallback/settings                 (instance)
//   PATCH /api/myrmidon/model-fallback/settings               (instance admin)
//   GET /api/myrmidon/companies/:companyId/model-fallback/status
//        -> { enabled, thresholdPct, minCalls, windowSec, intervalSec,
//             evaluatedAt, rows: [{ agentId, total, fallbacks, sharePct,
//             servedModels, aboveThreshold }] }
//
// The status endpoint answers with the rows of the last sweep plus the numbers
// the sweep itself will obey, so the card never has to guess the threshold.
import { api } from "@/api/client";

/** One agent's live fallback share, as the last sweep counted it. */
export interface FallbackSignalStatusRow {
  agentId: string;
  /** Attributed gateway calls of the agent in the window. */
  total: number;
  /** Of those, calls served by a model outside the agent's card. */
  fallbacks: number;
  sharePct: number;
  servedModels: string[];
  /** The signal is up for this agent: at or above the threshold with enough calls. */
  aboveThreshold: boolean;
}

export interface FallbackSignalStatusView {
  companyId: string;
  enabled: boolean;
  thresholdPct: number;
  minCalls: number;
  windowSec: number;
  intervalSec: number;
  /** ISO timestamp of the last sweep, or null when this company was never swept. */
  evaluatedAt: string | null;
  rows: FallbackSignalStatusRow[];
}

export const fallbackSignalStatusQueryKey = (companyId: string) =>
  ["myrmidon", "model-fallback", "status", companyId] as const;

const statusPath = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/model-fallback/status`;

export const fallbackSignalApi = {
  getStatus: (companyId: string) => api.get<FallbackSignalStatusView>(statusPath(companyId)),
};