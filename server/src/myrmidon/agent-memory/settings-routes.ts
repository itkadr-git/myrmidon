// GET/PATCH /api/myrmidon/agent-memory (myrmidon MEMORY-UI).
//
// The instance-level setting behind the agent card Memory tab: the memory
// service address, the optional key secret name, agent access policies,
// and the on/off switch, stored in `instance_settings.general.agentMemory`.
// The card re-reads it on every request, so a change applies without a restart.
// GET is open to board members; PATCH is instance-admin only.

import { Router } from "express";
import {
  applyAgentMemoryPatch,
  normalizeAgentMemorySettings,
  patchAgentMemorySettingsSchema,
  type AgentMemoryAccessMode,
  type AgentMemorySettings,
  type HindsightBankConfig,
  type HindsightBankSummary,
  type HindsightRecallProbeResult,
  type HindsightWorkloadMetrics,
  type PatchAgentMemorySettings,
} from "@myrmidon/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../../routes/authz.js";
import { createMemoryHindsightClient, type FetchLike } from "./hindsight-client.js";
import { readMemoryUiSettings, type MemoryUrlSource } from "./settings.js";

export interface AgentMemorySettingsView {
  /** What is stored in the instance setting (empty fields = not set). */
  settings: AgentMemorySettings;
  /** What is in force now after the precedence setting > env > bot env. */
  effective: {
    enabled: boolean;
    apiUrl: string | null;
    urlSource: MemoryUrlSource | null;
    keySecretName: string | null;
    accessMode: AgentMemoryAccessMode;
    enabledRoles: string[];
    enabledAgentIds: string[];
  };
}

export interface AgentMemorySettingsServiceDeps {
  getGeneral(): Promise<{ agentMemory?: unknown }>;
  updateGeneral(patch: { agentMemory: AgentMemorySettings }): Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

export function agentMemorySettingsService(deps: AgentMemorySettingsServiceDeps) {
  const env = deps.env ?? process.env;

  let lastProbeDurationMs: number | null = null;
  const recentProbeDurations: number[] = [];

  function recordProbe(durationMs: number) {
    lastProbeDurationMs = durationMs;
    recentProbeDurations.push(durationMs);
    if (recentProbeDurations.length > 20) recentProbeDurations.shift();
  }

  const view = (settings: AgentMemorySettings): AgentMemorySettingsView => {
    const effective = readMemoryUiSettings(env, settings);
    return {
      settings,
      effective: {
        enabled: effective.enabled,
        apiUrl: effective.baseUrl,
        urlSource: effective.urlSource,
        keySecretName: effective.keySecret,
        accessMode: effective.accessMode,
        enabledRoles: effective.enabledRoles,
        enabledAgentIds: effective.enabledAgentIds,
      },
    };
  };

  return {
    async read(): Promise<AgentMemorySettingsView> {
      const general = await deps.getGeneral();
      return view(normalizeAgentMemorySettings(general.agentMemory));
    },
    async update(patch: PatchAgentMemorySettings): Promise<AgentMemorySettingsView> {
      const general = await deps.getGeneral();
      const next = applyAgentMemoryPatch(normalizeAgentMemorySettings(general.agentMemory), patch);
      await deps.updateGeneral({ agentMemory: next });
      return view(next);
    },
    async listBanks(): Promise<HindsightBankSummary[]> {
      const general = await deps.getGeneral();
      const viewResult = view(normalizeAgentMemorySettings(general.agentMemory));
      if (!viewResult.effective.apiUrl) return [];
      const client = createMemoryHindsightClient(viewResult.effective.apiUrl, undefined, {
        fetchImpl: deps.fetchImpl,
      });
      return client.listBanks();
    },
    async getBankConfig(bankId: string): Promise<HindsightBankConfig> {
      const general = await deps.getGeneral();
      const viewResult = view(normalizeAgentMemorySettings(general.agentMemory));
      if (!viewResult.effective.apiUrl) throw new Error("Memory service is not configured");
      const client = createMemoryHindsightClient(viewResult.effective.apiUrl, undefined, {
        fetchImpl: deps.fetchImpl,
      });
      return client.getBankConfig(bankId);
    },
    async updateBankConfig(bankId: string, patch: Record<string, unknown>): Promise<HindsightBankConfig> {
      const general = await deps.getGeneral();
      const viewResult = view(normalizeAgentMemorySettings(general.agentMemory));
      if (!viewResult.effective.apiUrl) throw new Error("Memory service is not configured");
      const client = createMemoryHindsightClient(viewResult.effective.apiUrl, undefined, {
        fetchImpl: deps.fetchImpl,
      });
      return client.updateBankConfig(bankId, patch);
    },
    async getWorkload(bankId?: string): Promise<HindsightWorkloadMetrics> {
      const general = await deps.getGeneral();
      const viewResult = view(normalizeAgentMemorySettings(general.agentMemory));
      if (!viewResult.effective.apiUrl) {
        return {
          lastRecallDurationMs: null,
          avgRecallDurationMs: null,
          totalRecalls: 0,
          consolidationQueue: { pending: 0, processing: 0, failed: 0, total: 0, recentOperations: [] },
        };
      }
      const client = createMemoryHindsightClient(viewResult.effective.apiUrl, undefined, {
        fetchImpl: deps.fetchImpl,
      });
      const targetBank = bankId ?? "default";
      const [stats, ops] = await Promise.all([
        client.getBankStats(targetBank),
        client.getOperations(targetBank, { limit: 20 }),
      ]);
      const pending = stats.pendingConsolidations || ops.filter((o) => o.status === "pending").length;
      const processing = ops.filter((o) => o.status === "processing").length;
      const failed = stats.failedConsolidations || ops.filter((o) => o.status === "failed").length;
      const avg =
        recentProbeDurations.length > 0
          ? Math.round(recentProbeDurations.reduce((a, b) => a + b, 0) / recentProbeDurations.length)
          : null;
      return {
        lastRecallDurationMs: lastProbeDurationMs,
        avgRecallDurationMs: avg,
        totalRecalls: recentProbeDurations.length,
        consolidationQueue: {
          pending,
          processing,
          failed,
          total: pending + processing + failed,
          recentOperations: ops,
        },
      };
    },
    async retryOperation(bankId: string, operationId: string) {
      const general = await deps.getGeneral();
      const viewResult = view(normalizeAgentMemorySettings(general.agentMemory));
      if (!viewResult.effective.apiUrl) throw new Error("Memory service is not configured");
      const client = createMemoryHindsightClient(viewResult.effective.apiUrl, undefined, {
        fetchImpl: deps.fetchImpl,
      });
      return client.retryOperation(bankId, operationId);
    },
    async probeRecall(query: string, bankId = "default"): Promise<HindsightRecallProbeResult> {
      const general = await deps.getGeneral();
      const viewResult = view(normalizeAgentMemorySettings(general.agentMemory));
      if (!viewResult.effective.apiUrl) throw new Error("Memory service is not configured");
      const client = createMemoryHindsightClient(viewResult.effective.apiUrl, undefined, {
        fetchImpl: deps.fetchImpl,
      });
      try {
        const res = await client.recall(bankId, query);
        recordProbe(res.durationMs);
        return {
          success: true,
          durationMs: res.durationMs,
          resultsCount: res.results.length,
          results: res.results,
        };
      } catch (err) {
        return {
          success: false,
          durationMs: 0,
          resultsCount: 0,
          results: [],
          error: String(err),
        };
      }
    },
  };
}

export function agentMemorySettingsRoutes(service: ReturnType<typeof agentMemorySettingsService>) {
  const router = Router();

  router.get("/myrmidon/agent-memory", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/agent-memory", validate(patchAgentMemorySettingsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(req.body as PatchAgentMemorySettings));
  });

  router.get("/myrmidon/agent-memory/banks", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.listBanks());
  });

  router.get("/myrmidon/agent-memory/banks/:bankId/config", async (req, res) => {
    assertBoardOrgAccess(req);
    const bankId = req.params.bankId;
    if (!bankId) {
      res.status(400).json({ error: "Missing bankId" });
      return;
    }
    res.json(await service.getBankConfig(bankId));
  });

  router.patch("/myrmidon/agent-memory/banks/:bankId/config", async (req, res) => {
    assertInstanceAdmin(req);
    const bankId = req.params.bankId;
    if (!bankId) {
      res.status(400).json({ error: "Missing bankId" });
      return;
    }
    res.json(await service.updateBankConfig(bankId, (req.body ?? {}) as Record<string, unknown>));
  });

  router.get("/myrmidon/agent-memory/workload", async (req, res) => {
    assertBoardOrgAccess(req);
    const bankId = typeof req.query.bankId === "string" ? req.query.bankId : undefined;
    res.json(await service.getWorkload(bankId));
  });

  router.post("/myrmidon/agent-memory/banks/:bankId/operations/:operationId/retry", async (req, res) => {
    assertInstanceAdmin(req);
    const { bankId, operationId } = req.params;
    if (!bankId || !operationId) {
      res.status(400).json({ error: "Missing bankId or operationId" });
      return;
    }
    res.json(await service.retryOperation(bankId, operationId));
  });

  router.post("/myrmidon/agent-memory/probe", async (req, res) => {
    assertBoardOrgAccess(req);
    const { query, bankId } = (req.body ?? {}) as { query?: string; bankId?: string };
    if (!query || typeof query !== "string") {
      res.status(400).json({ error: "Missing required query string" });
      return;
    }
    res.json(await service.probeRecall(query, bankId || "default"));
  });

  return router;
}