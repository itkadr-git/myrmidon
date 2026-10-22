// server/src/myrmidon/litellm-sync/service.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): LiteLLM runtime synchronization.
//
// Synchronizes enabled models from the model_provider_models table with LiteLLM's
// active model registry. On enable/disable events, calls /model/new or /model/delete.
// At startup, reconciles the database state with LiteLLM's current registry.
// Handles credential rotation by updating all models of a provider.
// Updates agent key allowlists to include enabled models.

import { and, eq } from "drizzle-orm";
import { modelProviderModels, modelProviders, type Db } from "@paperclipai/db";
import { LitellmSyncPort } from "./port.js";

export interface LitellmSyncServiceDeps {
  db: Db;
  litellm: LitellmSyncPort;
}

export interface SyncTrigger {
  /** Called when a model is registered in LiteLLM */
  onModelRegistered?(litellmModelName: string): Promise<void> | void;
  /** Called when a model is unregistered from LiteLLM */
  onModelUnregistered?(litellmModelName: string): Promise<void> | void;
}

export function createLitellmSyncService(deps: LitellmSyncServiceDeps, trigger?: SyncTrigger) {
  /**
   * Synchronize a single model based on its enabled state.
   */
  async function syncModel(providerId: string, modelName: string, enabled: boolean) {
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

      if (!provider.credentialSecretName) {
        throw new Error(`Provider ${providerId} has no credential secret name`);
      }

      await deps.litellm.registerModel({
        litellmModelName: model.litellmModelName,
        providerType: provider.type,
        baseUrl: provider.baseUrl,
        credentialSecretName: provider.credentialSecretName,
      });

      await trigger?.onModelRegistered?.(model.litellmModelName);
    } else {
      await deps.litellm.unregisterModel(model.litellmModelName);
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

    await syncModel(providerId, modelName, enabled);
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
    // in the gateway registry.
    const ownedSecretNames = await deps.db
      .select({ credentialSecretName: modelProviders.credentialSecretName })
      .from(modelProviders)
      .where(eq(modelProviders.companyId, companyId));
    const owned = new Set(
      ownedSecretNames.map((row) => row.credentialSecretName).filter((n): n is string => Boolean(n)),
    );

    // Get current registrations from LiteLLM
    const currentRegistrations = await deps.litellm.listRegisteredModels();

    // Create sets for quick lookup
    const dbEnabledModelNames = new Set(enabledModels.map(m => m.litellmModelName));
    const litellmRegisteredModelNames = new Set(currentRegistrations.map(r => r.litellmModelName));

    // Register models that are enabled in DB but not in LiteLLM
    for (const model of enabledModels) {
      if (!litellmRegisteredModelNames.has(model.litellmModelName)) {
        if (model.provider.credentialSecretName) {
          await deps.litellm.registerModel({
            litellmModelName: model.litellmModelName,
            providerType: model.provider.type,
            baseUrl: model.provider.baseUrl,
            credentialSecretName: model.provider.credentialSecretName,
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

    if (!provider.credentialSecretName) {
      throw new Error(`Provider ${providerId} has no credential secret name`);
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

    // Update credentials for all enabled models
    for (const model of models) {
      // Unregister and re-register with new credentials
      await deps.litellm.unregisterModel(model.litellmModelName);
      await deps.litellm.registerModel({
        litellmModelName: model.litellmModelName,
        providerType: provider.type,
        baseUrl: provider.baseUrl,
        credentialSecretName: provider.credentialSecretName,
      });
      await trigger?.onModelUnregistered?.(model.litellmModelName);
      await trigger?.onModelRegistered?.(model.litellmModelName);
    }
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

  return {
    syncModel,
    syncProviderModels,
    handleModelEnableDisable,
    reconcileWithLitellm,
    handleProviderCredentialRotation,
    unregisterModels,
  };
}

export type LitellmSyncService = ReturnType<typeof createLitellmSyncService>;