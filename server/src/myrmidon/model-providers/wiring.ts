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
import { and, eq } from "drizzle-orm";
import { pluginConfig, plugins, type Db } from "@paperclipai/db";
import {
  readGatewayKeySettings,
  type PluginRecord,
  type PluginProviderModelDeclaration,
} from "@paperclipai/shared";
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

/** Builds the production ModelProviderService backed by Db, secrets and default catalog port. */
export function createDefaultModelProviderService(db: Db): ReturnType<typeof createModelProviderService> {
  const secrets = secretService(db);
  return createModelProviderService({
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
            provider: "local_encrypted",
          } as never,
          { userId: null, agentId: null },
        )) as { id: string };
        return { id: created.id };
      },
      rotateSecret: async (secretId, value) => {
        await secrets.rotate(secretId, { value }, { userId: null, agentId: null });
      },
      deleteSecret: async (secretId) => {
        await secrets.remove(secretId);
      },
    },
    catalog: createModelProviderCatalogPort(),
  });
}

export function myrmidonModelProviderRoutes(db: Db, env: NodeJS.ProcessEnv = process.env): Router {
  const secrets = secretService(db);
  const modelProviderService = createDefaultModelProviderService(db);

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
      updateAgentAllowlistsForCompany(db, defaultAgentGatewayKeyDeps(db, env), companyId, [], [], true),
    recordActivity: (entry) => recordModelProviderActivity(db, entry),
  };

  return modelProviderRoutesWithSync(deps);
}

/** Bridge plugin lifecycle declarations to the company-scoped LiteLLM client. */
export function createPluginProviderModelSync(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): {
  sync(companyId: string, plugin: PluginRecord): Promise<void>;
  remove(companyId: string, plugin: PluginRecord): Promise<void>;
} {
  const secrets = secretService(db);
  const settings = readGatewayKeySettings(env);
  async function getSync(companyId: string) {
    if (!settings.canManageKeys || !settings.baseUrl || !settings.adminKeySecret) return null;
    const row = await secrets.getByName(companyId, settings.adminKeySecret);
    const key = row ? await secrets.resolveSecretValue(companyId, row.id, "latest") : null;
    if (!key) return null;
    return createLitellmSyncService({
      db,
      litellm: createLitellmSyncClient({ litellmBaseUrl: settings.baseUrl, litellmAdminKey: key }),
    });
  }
  const declaration = (plugin: PluginRecord): PluginProviderModelDeclaration | null =>
    (plugin.manifestJson as { providerModels?: PluginProviderModelDeclaration } | null)?.providerModels ?? null;

  return {
    async sync(companyId, plugin) {
      const provider = declaration(plugin);
      const gateway = await getSync(companyId);
      if (!provider || !gateway) return;

      // A manifest credential is only usable when the company owns that secret.
      // Never register a plugin model against an inferred or cross-tenant key.
      const credential = await secrets.getByName(companyId, provider.credentialSecretName);
      if (!credential) {
        throw new Error(
          `Provider plugin ${plugin.pluginKey} requires company secret "${provider.credentialSecretName}"`,
        );
      }

      const modelNames = provider.models.map((model: PluginProviderModelDeclaration["models"][number]) => `${provider.provider}/${model.id}`);
      for (const modelName of modelNames) {
        await gateway.registerPluginModel({
          modelName,
          providerType: provider.provider,
          baseUrl: provider.baseUrl,
          credentialSecretName: provider.credentialSecretName,
        });
      }
      // Lifecycle models are separate from provider-table models; add only these
      // names while retaining all other models in each company key allowlist.
      await updateAgentAllowlistsForCompany(db, defaultAgentGatewayKeyDeps(db, env), companyId, modelNames);
    },
    async remove(companyId, plugin) {
      const provider = declaration(plugin);
      const gateway = await getSync(companyId);
      if (!provider || !gateway) return;

      const modelNames = provider.models.map((model: PluginProviderModelDeclaration["models"][number]) => `${provider.provider}/${model.id}`);
      const otherReadyPlugins: Array<{
        id: string;
        pluginKey: string;
        manifestJson: unknown;
        status: string;
      }> = await db.select({ id: plugins.id, pluginKey: plugins.pluginKey, manifestJson: plugins.manifestJson, status: plugins.status })
        .from(plugins)
        .innerJoin(pluginConfig, eq(pluginConfig.pluginId, plugins.id))
        .where(and(eq(pluginConfig.companyId, companyId), eq(plugins.status, "ready")));
      const stillOwnedNames = new Set(otherReadyPlugins
        .filter((owner) => owner.id !== plugin.id)
        .flatMap((owner) => {
          const other = declaration(owner as unknown as PluginRecord);
          return other?.models.map((model: PluginProviderModelDeclaration["models"][number]) => `${other.provider}/${model.id}`) ?? [];
        }));
      for (const modelName of modelNames) {
        if (!stillOwnedNames.has(modelName)) await gateway.unregisterModel(modelName);
      }
      const removableModelNames = modelNames.filter((modelName) => !stillOwnedNames.has(modelName));
      await updateAgentAllowlistsForCompany(
        db,
        defaultAgentGatewayKeyDeps(db, env),
        companyId,
        [],
        removableModelNames,
        true,
      );
    },
  };
}
