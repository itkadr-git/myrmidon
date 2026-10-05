// GET/PATCH /api/myrmidon/agent-memory (myrmidon MEMORY-UI).
//
// The instance-level setting behind the agent card Memory tab: the memory
// service address, the optional key secret name and the on/off switch, stored
// in `instance_settings.general.agentMemory`. The card re-reads it on every
// request, so a change applies without a restart. GET is open to board
// members; PATCH is instance-admin only, like the rest of the instance settings.

import { Router } from "express";
import {
  applyAgentMemoryPatch,
  normalizeAgentMemorySettings,
  patchAgentMemorySettingsSchema,
  type AgentMemorySettings,
  type PatchAgentMemorySettings,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../../routes/authz.js";
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
  };
}

export interface AgentMemorySettingsServiceDeps {
  getGeneral(): Promise<{ agentMemory?: unknown }>;
  updateGeneral(patch: { agentMemory: AgentMemorySettings }): Promise<unknown>;
  env?: NodeJS.ProcessEnv;
}

export function agentMemorySettingsService(deps: AgentMemorySettingsServiceDeps) {
  const env = deps.env ?? process.env;
  const view = (settings: AgentMemorySettings): AgentMemorySettingsView => {
    const effective = readMemoryUiSettings(env, settings);
    return {
      settings,
      effective: {
        enabled: effective.enabled,
        apiUrl: effective.baseUrl,
        urlSource: effective.urlSource,
        keySecretName: effective.keySecret,
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

  return router;
}
