// server/src/myrmidon/litellm-audit/wiring.ts
//
// myrmidon(OPE-9857): production wiring for LiteLLM audit routes in app.ts.

import type { Router } from "express";
import type { Db } from "@myrmidon/db";
import { createModelProviderService } from "../model-providers/service.js";
import { litellmAuditRoutes } from "./routes.js";
import { createLiteLlmAuditService, type LiteLlmRollbackHandlers } from "./service.js";

export function myrmidonLitellmAuditRoutes(db: Db): Router {
  const auditService = createLiteLlmAuditService(db);
  const modelProviderService = createModelProviderService(db);

  const handlers: LiteLlmRollbackHandlers = {
    async restoreModels(companyId: string, providerId: string, models: unknown) {
      if (Array.isArray(models)) {
        await modelProviderService.setModels({
          companyId,
          providerId,
          models: models as Array<{ modelName: string; enabled?: boolean; free?: boolean }>,
        });
      }
    },

    async restoreProvider(companyId: string, providerId: string, state: unknown) {
      if (state && typeof state === "object") {
        const patchData: Record<string, unknown> = {};
        const s = state as Record<string, unknown>;
        if (typeof s.name === "string") patchData.name = s.name;
        if (s.baseUrl === null || typeof s.baseUrl === "string") patchData.baseUrl = s.baseUrl;
        if (typeof s.free === "boolean") patchData.free = s.free;
        if (typeof s.rpmLimit === "number" || s.rpmLimit === null) patchData.rpmLimit = s.rpmLimit;

        await modelProviderService.patchProvider({
          companyId,
          providerId,
          body: patchData,
        });
      }
    },
  };

  return litellmAuditRoutes({
    service: auditService,
    handlers,
  });
}
