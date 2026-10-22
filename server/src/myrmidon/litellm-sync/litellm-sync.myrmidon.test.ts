// server/src/myrmidon/litellm-sync/litellm-sync.myrmidon.test.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): tests for LiteLLM synchronization.
//
// Tests the core functionality:
// - enable → calls /model/new
// - disable → calls /model/delete
// - startup → reconcile differences, company-scoped: only registrations that
//   carry one of the company's credential names are ever unregistered
// - credential rotation updates all provider models
// - unregisterModels clears a removed provider's models
// - secret values are not exposed in logs/payloads

import { describe, it, expect, beforeEach, vi, type Mocked } from "vitest";
import { createLitellmSyncService } from "./service.js";
import type { LitellmSyncPort } from "./port.js";
import type { Db } from "@paperclipai/db";

/**
 * A scripted fake of the drizzle query builder: every `select()` call takes the
 * next prepared result off the queue, and every builder step (`from`, `where`,
 * `innerJoin`, `limit`) returns the same awaitable chain, so the service's real
 * query shapes (with or without `limit`) resolve to the prepared rows.
 */
function scriptedDb(results: unknown[][]): Db {
  const queue = [...results];
  return {
    select: () => {
      const rows = queue.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const step of ["from", "where", "innerJoin", "limit"]) {
        chain[step] = () => chain;
      }
      chain.then = (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject);
      return chain;
    },
  } as unknown as Db;
}

const OPENAI_PROVIDER = {
  id: "prov-123",
  type: "openai",
  baseUrl: "https://api.openai.com/v1",
  credentialSecretName: "secret-name-123",
};

const COMPANY_ID = "comp-789";

describe("LitellmSyncService", () => {
  let port: Mocked<LitellmSyncPort>;

  beforeEach(() => {
    port = {
      registerModel: vi.fn().mockResolvedValue(undefined),
      unregisterModel: vi.fn().mockResolvedValue(undefined),
      listRegisteredModels: vi.fn().mockResolvedValue([]),
    };
  });

  it("registers model when enabled", async () => {
    // select order in syncModel: the model row, then its provider
    const service = createLitellmSyncService({
      db: scriptedDb([[{ litellmModelName: "openai/gpt-4o" }], [OPENAI_PROVIDER]]),
      litellm: port,
    });

    await service.syncModel("prov-123", "gpt-4o", true);

    expect(port.registerModel).toHaveBeenCalledWith({
      litellmModelName: "openai/gpt-4o",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      credentialSecretName: "secret-name-123",
    });
    expect(port.unregisterModel).not.toHaveBeenCalled();
  });

  it("unregisters model when disabled", async () => {
    const service = createLitellmSyncService({
      db: scriptedDb([[{ litellmModelName: "openai/gpt-4o" }]]),
      litellm: port,
    });

    await service.syncModel("prov-123", "gpt-4o", false);

    expect(port.unregisterModel).toHaveBeenCalledWith("openai/gpt-4o");
    expect(port.registerModel).not.toHaveBeenCalled();
  });

  it("reconciles a company's models at startup", async () => {
    // select order in reconcileWithLitellm: the enabled models joined with
    // their provider, then the company's owned credential names.
    const service = createLitellmSyncService({
      db: scriptedDb([
        [
          {
            litellmModelName: "openai/gpt-4o",
            provider: {
              type: "openai",
              baseUrl: "https://api.openai.com/v1",
              credentialSecretName: "secret-name-123",
            },
          },
        ],
        [{ credentialSecretName: "secret-name-123" }],
      ]),
      litellm: port,
    });
    port.listRegisteredModels.mockResolvedValue([
      {
        litellmModelName: "openai/stale-model",
        providerType: "openai",
        baseUrl: null,
        credentialSecretName: "secret-name-123",
      },
    ]);

    await service.reconcileWithLitellm(COMPANY_ID);

    // Enabled in the database but absent from LiteLLM: registered.
    expect(port.registerModel).toHaveBeenCalledWith({
      litellmModelName: "openai/gpt-4o",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      credentialSecretName: "secret-name-123",
    });
    // Registered in LiteLLM under this company's credential and not enabled
    // in the database: removed.
    expect(port.unregisterModel).toHaveBeenCalledWith("openai/stale-model");
  });

  it("startup reconcile never unregisters registrations the company does not own", async () => {
    const service = createLitellmSyncService({
      db: scriptedDb([
        [], // no enabled models for this company
        [{ credentialSecretName: "secret-name-123" }], // the company's own credentials
      ]),
      litellm: port,
    });
    port.listRegisteredModels.mockResolvedValue([
      {
        litellmModelName: "openai/stale-model",
        providerType: "openai",
        baseUrl: null,
        credentialSecretName: "secret-name-123", // ours → reclaimable
      },
      {
        litellmModelName: "anthropic/claude-static",
        providerType: "anthropic",
        baseUrl: null,
        credentialSecretName: "", // static gateway config → never touched
      },
      {
        litellmModelName: "openai/other-tenant",
        providerType: "openai",
        baseUrl: null,
        credentialSecretName: "secret-name-other-company",
      },
    ]);

    await service.reconcileWithLitellm(COMPANY_ID);

    expect(port.unregisterModel).toHaveBeenCalledTimes(1);
    expect(port.unregisterModel).toHaveBeenCalledWith("openai/stale-model");
  });

  it("handles credential rotation for all provider models", async () => {
    // select order: the provider (company check), then its enabled models
    const service = createLitellmSyncService({
      db: scriptedDb([
        [{ ...OPENAI_PROVIDER, credentialSecretName: "new-secret-name-456", companyId: COMPANY_ID }],
        [{ litellmModelName: "openai/gpt-4o" }, { litellmModelName: "openai/gpt-4-turbo" }],
      ]),
      litellm: port,
    });

    await service.handleProviderCredentialRotation(COMPANY_ID, "prov-123");

    expect(port.unregisterModel).toHaveBeenCalledTimes(2);
    expect(port.registerModel).toHaveBeenCalledTimes(2);
    expect(port.registerModel).toHaveBeenCalledWith({
      litellmModelName: "openai/gpt-4o",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      credentialSecretName: "new-secret-name-456",
    });
    expect(port.registerModel).toHaveBeenCalledWith({
      litellmModelName: "openai/gpt-4-turbo",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      credentialSecretName: "new-secret-name-456",
    });
  });

  it("unregisterModels clears a removed provider's gateway registrations", async () => {
    const service = createLitellmSyncService({
      db: scriptedDb([]),
      litellm: port,
    });

    await service.unregisterModels(["openai/gpt-4o", "openai/gpt-4-turbo"]);

    expect(port.unregisterModel).toHaveBeenCalledTimes(2);
    expect(port.unregisterModel).toHaveBeenCalledWith("openai/gpt-4o");
    expect(port.unregisterModel).toHaveBeenCalledWith("openai/gpt-4-turbo");
  });

  it("does not expose secret values in registerModel calls", async () => {
    const service = createLitellmSyncService({
      db: scriptedDb([[{ litellmModelName: "openai/gpt-4o" }], [OPENAI_PROVIDER]]),
      litellm: port,
    });

    await service.syncModel("prov-123", "gpt-4o", true);

    const callArgs = port.registerModel.mock.calls[0]![0];
    // Only the secret NAME reference goes to LiteLLM, never a value.
    expect(callArgs.credentialSecretName).toBe("secret-name-123");
    expect(callArgs).not.toHaveProperty("credentialValue");
  });
});
