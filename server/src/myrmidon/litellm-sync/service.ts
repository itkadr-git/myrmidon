// server/src/myrmidon/litellm-sync/service.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): LiteLLM runtime synchronization.
//
// Synchronizes enabled models from the model_provider_models table with LiteLLM's
// active model registry. On enable/disable events, calls /model/new or /model/delete.
// At startup, reconciles the database state with LiteLLM's current registry.
// Handles credential rotation by updating all models of a provider.
// Updates agent key allowlists to include enabled models.
//
// Names: the registry's `litellmModelName` is the model GROUP clients call; the
// provider's own spelling (`modelName`) is what LiteLLM sends upstream, so the
// two can differ (`kimi/kimi-for-coding` -> `kimi-for-coding`). A registration
// never duplicates a deployment the gateway already holds under the same group
// name and api_base.
//
// Subscription pools (chatgpt-pool, antigravity-pool, google-ai-pool) are the
// exception: a pool lives on its own gateway deployments (the pool's router
// or proxy), so nothing in this module writes to the gateway for a pool
// provider - no register, update or delete on enable, disable, rotation,
// provider removal or the startup reconciliation. The board manages which pool
// models are visible, the fallback order and the agent key lists, never the
// pool's deployments.

import { and, eq } from "drizzle-orm";
import { modelProviderModels, modelProviders, type Db } from "@myrmidon/db";
import { isPoolModelProviderType } from "@myrmidon/shared";
import { LitellmSyncPort } from "./port.js";

export interface LitellmSyncServiceDeps {
  db: Db;
  litellm: LitellmSyncPort;
  /** Resolves a board secret name to its value before sending it to LiteLLM. */
  resolveCredential?: (companyId: string, secretName: string) => Promise<string | null>;
}

/** Trailing-slash and whitespace insensitive api_base comparison; absent and empty are equal. */
function sameBaseUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  const normalize = (value: string | null | undefined) => (value ?? "").trim().replace(/\/+$/, "");
  return normalize(a) === normalize(b);
}

export interface SyncTrigger {
  /** Called when a model is registered in LiteLLM */
  onModelRegistered?(litellmModelName: string): Promise<void> | void;
  /** Called when a model is unregistered from LiteLLM */
  onModelUnregistered?(litellmModelName: string): Promise<void> | void;
}

export function createLitellmSyncService(deps: LitellmSyncServiceDeps, trigger?: SyncTrigger) {
  /**
   * Registers a deployment unless the gateway already holds one under the same
   * group name and api_base (a repeated enable, a replay after a partial
   * failure, a deployment added by hand): `/model/new` always APPENDS, so a
   * blind second call would put two deployments behind one name.
   * Returns whether a deployment was created.
   */
  async function registerIfAbsent(
    input: Parameters<LitellmSyncPort["registerModel"]>[0],
  ): Promise<boolean> {
    const registered = await deps.litellm.listRegisteredModels();
    const present = registered.some(
      (registration) =>
        registration.litellmModelName === input.litellmModelName &&
        sameBaseUrl(registration.baseUrl, input.baseUrl),
    );
    if (present) return false;
    await deps.litellm.registerModel(input);
    return true;
  }

  /**
   * Synchronize a single model based on its enabled state.
   */
  async function syncModel(
    providerId: string,
    modelName: string,
    enabled: boolean,
    companyId?: string,
  ) {
    // Fetch the full model record to get the litellm model name
    const modelRecords = await deps.db
      .select()
      .from(modelProviderModels)
      .where(
        and(
          eq(modelProviderModels.providerId, providerId),
          eq(modelProviderModels.modelName, modelName)
        )
      )
      .limit(1);

    if (modelRecords.length === 0) {
      throw new Error(`Model ${modelName} not found for provider ${providerId}`);
    }

    const model = modelRecords[0];
    
    if (enabled) {
      // Fetch provider details to get credential information
      const providerRecords = await deps.db
        .select()
        .from(modelProviders)
        .where(eq(modelProviders.id, providerId))
        .limit(1);

      if (providerRecords.length === 0) {
        throw new Error(`Provider ${providerId} not found`);
      }

      const provider = providerRecords[0];
      if (isPoolModelProviderType(provider.type)) return;
      const providerCompanyId = companyId ?? provider.companyId;

      if (!provider.credentialSecretName) {
        throw new Error(`Provider ${providerId} has no credential secret name`);
      }
      // The secret NAME never travels to LiteLLM as a value: without a
      // resolver there is no way to obtain the value, so this is an error.
      const credentialValue = deps.resolveCredential
        ? await deps.resolveCredential(providerCompanyId, provider.credentialSecretName)
        : null;
      if (!credentialValue) {
        throw new Error(`Provider ${providerId} credential could not be resolved`);
      }

      await registerIfAbsent({
        litellmModelName: model.litellmModelName,
        ...(model.modelName ? { providerModel: model.modelName } : {}),
        providerType: provider.type,
        baseUrl: provider.baseUrl,
        credentialValue,
      });

      await trigger?.onModelRegistered?.(model.litellmModelName);
    } else {
      // Only the deployments of THIS provider's endpoint: a deployment the
      // board does not own under the same group name stays.
      const providerRecords = await deps.db
        .select()
        .from(modelProviders)
        .where(eq(modelProviders.id, providerId))
        .limit(1);
      const provider = providerRecords[0];
      if (provider && isPoolModelProviderType(provider.type)) return;
      if (provider) {
        await deps.litellm.unregisterModel(model.litellmModelName, { baseUrl: provider.baseUrl });
      } else {
        await deps.litellm.unregisterModel(model.litellmModelName);
      }
      await trigger?.onModelUnregistered?.(model.litellmModelName);
    }
  }

  /**
   * Synchronize all models for a given provider.
   */
  async function syncProviderModels(providerId: string) {
    const models = await deps.db
      .select()
      .from(modelProviderModels)
      .where(eq(modelProviderModels.providerId, providerId));

    for (const model of models) {
      await syncModel(providerId, model.modelName, model.enabled);
    }
  }

  /**
   * Handle model enable/disable event from the model providers API.
   */
  async function handleModelEnableDisable(
    companyId: string,
    providerId: string,
    modelName: string,
    enabled: boolean
  ) {
    // Verify the provider belongs to the company
    const providerRecords = await deps.db
      .select()
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.id, providerId),
          eq(modelProviders.companyId, companyId)
        )
      )
      .limit(1);

    if (providerRecords.length === 0) {
      throw new Error(`Provider ${providerId} not found in company ${companyId}`);
    }

    // A pool keeps its own deployments: enabling or disabling a pool model
    // changes what the board shows, not what the gateway holds.
    if (isPoolModelProviderType(providerRecords[0].type)) return;

    await syncModel(providerId, modelName, enabled, companyId);
  }

  /**
   * Reconcile one company's LiteLLM registrations with the database.
   *
   * Company-scoped on both sides of the diff:
   *  - register: models enabled in this company's provider rows and absent
   *    from the gateway;
   *  - unregister: gateway registrations that carry one of THIS company's
   *    credential secret names and are no longer enabled in the database.
   *
   * A registration whose credential is not a known company secret reference
   * (static gateway config, a hand-registered model, another tenant) is never
   * removed: the board only reclaims what it registered itself.
   */
  async function reconcileWithLitellm(companyId: string) {
    // Enabled models of this company, joined with their provider rows.
    const enabledModels = await deps.db
      .select({
        id: modelProviderModels.id,
        providerId: modelProviderModels.providerId,
        modelName: modelProviderModels.modelName,
        litellmModelName: modelProviderModels.litellmModelName,
        enabled: modelProviderModels.enabled,
        provider: {
          id: modelProviders.id,
          type: modelProviders.type,
          baseUrl: modelProviders.baseUrl,
          credentialSecretName: modelProviders.credentialSecretName,
          companyId: modelProviders.companyId,
        },
      })
      .from(modelProviderModels)
      .innerJoin(modelProviders, eq(modelProviderModels.providerId, modelProviders.id))
      .where(and(eq(modelProviderModels.enabled, true), eq(modelProviders.companyId, companyId)));

    // Credential names this company's providers own — the board's footprint
    // in the gateway registry. A pool's credential is not part of it: the
    // pool's deployments are not the board's to register or reclaim.
    const ownedSecretNames = await deps.db
      .select({ credentialSecretName: modelProviders.credentialSecretName, type: modelProviders.type })
      .from(modelProviders)
      .where(eq(modelProviders.companyId, companyId));
    const owned = new Set(
      ownedSecretNames
        .filter((row) => !isPoolModelProviderType(row.type))
        .map((row) => row.credentialSecretName)
        .filter((n): n is string => Boolean(n)),
    );

    // Get current registrations from LiteLLM
    const currentRegistrations = await deps.litellm.listRegisteredModels();

    // Pool models are skipped on both sides of the diff (see the header).
    const gatewayOwnedModels = enabledModels.filter((m) => !isPoolModelProviderType(m.provider.type));

    // Create sets for quick lookup
    const dbEnabledModelNames = new Set(gatewayOwnedModels.map(m => m.litellmModelName));
    const litellmRegisteredModelNames = new Set(currentRegistrations.map(r => r.litellmModelName));

    // Register models that are enabled in DB but not in LiteLLM
    for (const model of gatewayOwnedModels) {
      if (!litellmRegisteredModelNames.has(model.litellmModelName)) {
        if (model.provider.credentialSecretName) {
          const credentialValue = deps.resolveCredential
            ? await deps.resolveCredential(companyId, model.provider.credentialSecretName)
            : null;
          if (!credentialValue) {
            throw new Error(`Provider ${model.providerId} credential could not be resolved`);
          }
          await deps.litellm.registerModel({
            litellmModelName: model.litellmModelName,
            ...(model.modelName ? { providerModel: model.modelName } : {}),
            providerType: model.provider.type,
            baseUrl: model.provider.baseUrl,
            credentialValue,
          });
          await trigger?.onModelRegistered?.(model.litellmModelName);
        }
      }
    }

    // Unregister models that are in LiteLLM under this company's credentials
    // but no longer enabled in the DB. Registrations the board does not own
    // (credential is not one of this company's secret names) stay untouched.
    for (const registration of currentRegistrations) {
      if (!dbEnabledModelNames.has(registration.litellmModelName)) {
        if (registration.credentialSecretName && owned.has(registration.credentialSecretName)) {
          await deps.litellm.unregisterModel(registration.litellmModelName);
          await trigger?.onModelUnregistered?.(registration.litellmModelName);
        }
      }
    }
  }

  /**
   * Invalidates LiteLLM's in-process response/router cache after a credential
   * mutation. Deployments are updated in place above, but LiteLLM can retain a
   * resolved credential or routing snapshot until this endpoint is called.
   * Keep this optional so older gateway versions and test ports remain usable.
   */
  async function invalidateGatewayCache() {
    await deps.litellm.invalidateCache?.();
  }

  /**
   * Handle credential rotation for a provider.
   * Updates the credential for all models of the provider in LiteLLM.
   */
  async function handleProviderCredentialRotation(
    companyId: string,
    providerId: string
  ) {
    // Verify the provider belongs to the company
    const providerRecords = await deps.db
      .select()
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.id, providerId),
          eq(modelProviders.companyId, companyId)
        )
      )
      .limit(1);

    if (providerRecords.length === 0) {
      throw new Error(`Provider ${providerId} not found in company ${companyId}`);
    }

    const provider = providerRecords[0];

    // A pool's gateway deployments carry the pool router's own credential, not
    // the board key: rotating the board key changes nothing in the gateway.
    if (isPoolModelProviderType(provider.type)) return;

    if (!provider.credentialSecretName) {
      throw new Error(`Provider ${providerId} has no credential secret name`);
    }

    const credentialValue = deps.resolveCredential
      ? await deps.resolveCredential(companyId, provider.credentialSecretName)
      : null;
    if (!credentialValue) {
      throw new Error(`Provider ${providerId} credential could not be resolved`);
    }

    // Get all enabled models for this provider
    const models = await deps.db
      .select()
      .from(modelProviderModels)
      .where(
        and(
          eq(modelProviderModels.providerId, providerId),
          eq(modelProviderModels.enabled, true)
        )
      );

    // Update credentials for all enabled models, in place: an existing
    // deployment is updated by id (`/model/update`), never re-created with
    // `/model/new` (that adds a second deployment under the same name).
    const registered = await deps.litellm.listRegisteredModels();
    for (const model of models) {
      const input = {
        litellmModelName: model.litellmModelName,
        ...(model.modelName ? { providerModel: model.modelName } : {}),
        providerType: provider.type,
        baseUrl: provider.baseUrl,
        credentialValue,
      };
      // A group may hold several channels on different endpoints (that is what
      // an api_base is for): only this provider's own endpoint is rotated.
      // Without an exact match a single deployment under the name is taken as
      // the provider's own (its endpoint was edited since); several, none of
      // them ours, are other channels and stay untouched.
      const sameName = registered.filter(
        (r) => r.litellmModelName === model.litellmModelName && r.modelId,
      );
      const sameEndpoint = sameName.filter((r) => sameBaseUrl(r.baseUrl, provider.baseUrl));
      const deployments = sameEndpoint.length > 0 ? sameEndpoint : sameName.length === 1 ? sameName : [];
      if (deployments.length === 0) {
        // Not present in the gateway yet: nothing to update, register it.
        await deps.litellm.registerModel(input);
      } else {
        const [primary, ...duplicates] = deployments;
        await deps.litellm.updateDeployment({ ...input, modelId: primary.modelId! });
        // Leftover duplicates would keep serving the old credential.
        for (const duplicate of duplicates) await deps.litellm.deleteDeployment(duplicate.modelId!);
      }
      await trigger?.onModelRegistered?.(model.litellmModelName);
    }
    await invalidateGatewayCache();
  }

  /**
   * Unregister a set of model names from the gateway (used when a provider
   * is removed and its models would otherwise stay registered under a
   * credential the company no longer owns). Names not present in the registry
   * simply drop out; the call is safe to repeat.
   */
  async function unregisterModels(litellmModelNames: string[]) {
    for (const name of litellmModelNames) {
      await deps.litellm.unregisterModel(name);
      await trigger?.onModelUnregistered?.(name);
    }
  }

  /**
   * Removes the gateway deployments of ONE removed provider: those in the given
   * model groups that carry the provider's own `api_base` (the port deletes by
   * deployment id and never targets a deployment of the static gateway
   * config). Other deployments of the same group - another provider's, a
   * pool router's - stay; `unregisterModels` would take all of them with it.
   *
   * A pool provider is a no-op.
   */
  async function unregisterProviderModels(
    provider: { type: string; baseUrl: string | null },
    litellmModelNames: string[],
  ): Promise<void> {
    if (isPoolModelProviderType(provider.type)) return;
    for (const name of litellmModelNames) {
      await deps.litellm.unregisterModel(name, { baseUrl: provider.baseUrl });
      await trigger?.onModelUnregistered?.(name);
    }
  }

  /**
   * Fetches model groups and routed channels from LiteLLM.
   */
  async function listChannels() {
    return deps.litellm.listChannels();
  }

  return {
    registerPluginModel: async (input: {
      /** The company that owns the credential secret; required to resolve its value. */
      companyId?: string;
      modelName: string;
      providerType: string;
      baseUrl: string;
      credentialSecretName: string;
      additionalConfig?: Record<string, unknown>;
    }) => {
      // The gateway cannot resolve a secret NAME: with a resolver the value is
      // read on the board and sent; an unresolved credential is an error, not
      // an empty key.
      let credentialValue: string | null = null;
      if (deps.resolveCredential && input.companyId) {
        credentialValue = await deps.resolveCredential(input.companyId, input.credentialSecretName);
        if (!credentialValue) {
          throw new Error(`Plugin model ${input.modelName} credential could not be resolved`);
        }
      }
      await registerIfAbsent({
        litellmModelName: input.modelName,
        providerType: input.providerType,
        baseUrl: input.baseUrl,
        credentialSecretName: input.credentialSecretName,
        ...(credentialValue ? { credentialValue } : {}),
        additionalConfig: input.additionalConfig,
      });
    },
    unregisterModel: (modelName: string, match?: { baseUrl?: string | null }) =>
      match ? deps.litellm.unregisterModel(modelName, match) : deps.litellm.unregisterModel(modelName),
    syncModel,
    syncProviderModels,
    handleModelEnableDisable,
    reconcileWithLitellm,
    handleProviderCredentialRotation,
    unregisterModels,
    unregisterProviderModels,
    listChannels,
  };
}

export type LitellmSyncService = ReturnType<typeof createLitellmSyncService>;