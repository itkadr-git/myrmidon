// server/src/myrmidon/model-providers/wiring.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS A+B): binds the model-provider routes to the
// database, the secret store and the company activity log. Kept apart from
// routes.ts so the routes stay testable with plain fakes; this file is the
// only one that knows about `Db` and the secrets service.
//
// Part B adds the LiteLLM synchronization: on the mutations that change the
// company's model set (enable/disable, key rotation) the board re-registers
// the affected models in the gateway and re-applies the agents' virtual-key
// model allowlists. Configuration is the single pair the gateway surface
// already documents (M2-A/M2-B in docs/myrmidon/SETTINGS.md):
// MYRMIDON_LITELLM_BASE_URL and MYRMIDON_LITELLM_ADMIN_KEY_SECRET — the latter
// is the NAME of a company secret; the VALUE is resolved per company through
// the secret store and is what the LiteLLM client authenticates with. Either
// setting unset (the default): sync is off, the routes behave as in part A.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { readGatewayKeySettings } from "@paperclipai/shared";
import { secretService } from "../../services/index.js";
import { logActivity } from "../../services/index.js";
import {
  createModelProviderCatalogPort,
  createModelProviderService,
  type ModelProviderActivityEntry,
} from "./service.js";
import { modelProviderRoutesWithSync, type ModelProviderRoutesWithSyncDeps } from "./routes-with-sync.js";
import { createLitellmSyncService, type LitellmSyncService } from "../litellm-sync/service.js";
import { createLitellmSyncClient } from "../litellm-sync/client.js";
import { defaultAgentGatewayKeyDeps } from "../litellm-keys/agent-keys.js";
import { updateAgentAllowlistsForCompany } from "../litellm-sync/agent-allowlist-handler.js";

/** The activity row of one model-provider mutation (add / rotate / remove). */
export async function recordModelProviderActivity(
  db: Db,
  entry: ModelProviderActivityEntry,
): Promise<void> {
  await logActivity(db, {
    companyId: entry.companyId,
    actorType: "user",
    actorId: "board",
    action: entry.action,
    entityType: "model_provider",
    entityId: entry.providerId,
    details: entry.details,
  });
}

export function myrmidonModelProviderRoutes(db: Db, env: NodeJS.ProcessEnv = process.env): Router {
  const secrets = secretService(db);

  // Create the basic model provider service
  const modelProviderService = createModelProviderService({
    db,
    secrets: {
      readSecretValue: (companyId, secretName) =>
        secrets
          .getByName(companyId, secretName)
          .then((row) => (row ? secrets.resolveSecretValue(companyId, row.id, "latest") : null)),
      findSecretId: (companyId, secretName) =>
        secrets.getByName(companyId, secretName).then((row) => row?.id ?? null),
      createSecret: async (input) => {
        const created = (await secrets.create(
          input.companyId,
          {
            name: input.name,
            key: input.name,
            value: input.value,
            description: input.description,
          } as never,
          { userId: null, agentId: null },
        )) as { id: string };
        return { id: created.id };
      },
      rotateSecret: async (secretId, value) => {
        await secrets.rotate(secretId, { value }, { userId: null, agentId: null });
      },
      deleteSecret: async (secretId) => {
        await secrets.update(secretId, { status: "deleted" });
      },
    },
    catalog: createModelProviderCatalogPort(),
  });

  // Part B: the gateway pair is instance configuration; the admin key is a
  // company secret NAME whose VALUE is resolved per company. A company that
  // has no value under that name gets no sync client — the secret name is
  // never sent to the gateway as if it were the key.
  const gatewaySettings = readGatewayKeySettings(env);

  async function syncForCompany(companyId: string): Promise<LitellmSyncService | null> {
    if (!gatewaySettings.canManageKeys || !gatewaySettings.baseUrl || !gatewaySettings.adminKeySecret) {
      return null;
    }
    const row = await secrets.getByName(companyId, gatewaySettings.adminKeySecret);
    const adminKey = row ? await secrets.resolveSecretValue(companyId, row.id, "latest") : null;
    if (!adminKey) return null;
    const client = createLitellmSyncClient({
      litellmBaseUrl: gatewaySettings.baseUrl,
      litellmAdminKey: adminKey,
    });
    return createLitellmSyncService({ db, litellm: client });
  }

  const deps: ModelProviderRoutesWithSyncDeps = {
    service: modelProviderService,
    getLitellmSync: syncForCompany,
    refreshAgentAllowlists: (companyId) =>
      updateAgentAllowlistsForCompany(db, defaultAgentGatewayKeyDeps(db, env), companyId),
    recordActivity: (entry) => recordModelProviderActivity(db, entry),
  };

  return modelProviderRoutesWithSync(deps);
}
