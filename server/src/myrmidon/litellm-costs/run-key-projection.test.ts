// server/src/myrmidon/litellm-costs/run-key-projection.test.ts
//
// myrmidon(OPE-12932 KEY-TTL): the run-scoped projection of an agent's managed
// gateway key. The compiled runtime env carries only the secret_ref reference,
// never the raw key value, and the projection is revoked (the secret deleted)
// when the run is finished, so a stale ref resolves as unavailable.
//
// These tests cover the pure wiring with fakes: the ref lookup (name derived,
// active secret required), the cleanup (managed names only, best effort), and
// the resolveExecutionRunAdapterConfig merge (ref lands in env + secretKeys,
// never overrides an existing binding).

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getByNameMock, removeMock, resolveSecretValueMock } = vi.hoisted(() => ({
  getByNameMock: vi.fn(),
  removeMock: vi.fn(),
  resolveSecretValueMock: vi.fn(),
}));

vi.mock("../../services/index.js", () => ({
  secretService: () => ({
    getByName: getByNameMock,
    remove: removeMock,
    resolveSecretValue: resolveSecretValueMock,
  }),
}));

import {
  findRunScopedGatewayKeyRef,
  removeRunScopedGatewayKeyRef,
  type GatewayBotCard,
} from "./bot-keys.js";
import { resolveExecutionRunAdapterConfig } from "../../services/heartbeat.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const SECRET_ID = "33333333-3333-4333-8333-333333333333";

const ENV_WITH_KEY_ENV = {
  MYRMIDON_BOT_LLM_API_KEY_ENV: "MYRMIDON_LLM_API_KEY",
};

const RUN_SCOPED_REF = {
  type: "secret_ref" as const,
  secretId: SECRET_ID,
  version: "latest" as const,
};

beforeEach(() => {
  // Call history and per-test implementations must not leak between tests:
  // the "not called at all" assertions below are order-sensitive otherwise.
  vi.resetAllMocks();
});

describe("myrmidon(OPE-12932) findRunScopedGatewayKeyRef", () => {
  it("returns the secret_ref reference of the agent's managed key, not a value", async () => {
    getByNameMock.mockResolvedValue({
      id: SECRET_ID,
      status: "active",
      scope: "company",
      expiresAt: new Date(Date.now() + 60_000),
      latestVersion: 2,
    });

    const ref = await findRunScopedGatewayKeyRef({} as never, COMPANY_ID, AGENT_ID, ENV_WITH_KEY_ENV);

    expect(getByNameMock).toHaveBeenCalledWith(COMPANY_ID, `llm-gateway-run-${AGENT_ID}`);
    expect(ref).toEqual({
      envKey: "MYRMIDON_LLM_API_KEY",
      secretRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
    });
  });

  it("returns null when the agent holds no managed key secret", async () => {
    getByNameMock.mockResolvedValue(null);
    expect(
      await findRunScopedGatewayKeyRef({} as never, COMPANY_ID, AGENT_ID, ENV_WITH_KEY_ENV),
    ).toBeNull();
  });

  it.each([null, new Date(0)])("rejects a binding without a future expiry", async (expiresAt) => {
    getByNameMock.mockResolvedValue({ id: SECRET_ID, status: "active", scope: "company", expiresAt });
    expect(await findRunScopedGatewayKeyRef({} as never, COMPANY_ID, RUN_ID, ENV_WITH_KEY_ENV)).toBeNull();
  });

  it("uses the lifecycle default env name when no override is configured", async () => {
    getByNameMock.mockResolvedValue({ id: SECRET_ID, status: "active", scope: "company", expiresAt: new Date(Date.now() + 60_000) });
    expect(await findRunScopedGatewayKeyRef({} as never, COMPANY_ID, RUN_ID, {})).toEqual({
      envKey: "MYRMIDON_LLM_API_KEY",
      secretRef: RUN_SCOPED_REF,
    });
  });

  it("skips an inactive or user-scoped secret", async () => {
    getByNameMock.mockResolvedValue({ id: SECRET_ID, status: "deleted", scope: "company" });
    expect(
      await findRunScopedGatewayKeyRef({} as never, COMPANY_ID, AGENT_ID, ENV_WITH_KEY_ENV),
    ).toBeNull();
    getByNameMock.mockResolvedValue({ id: SECRET_ID, status: "active", scope: "user" });
    expect(
      await findRunScopedGatewayKeyRef({} as never, COMPANY_ID, AGENT_ID, ENV_WITH_KEY_ENV),
    ).toBeNull();
  });
});

describe("myrmidon(OPE-12932) run ownership", () => {
  it("invalidates a finished run without affecting a concurrent or subsequent run", async () => {
    const otherRunId = "55555555-5555-4555-8555-555555555555";
    const nextRunId = "66666666-6666-4666-8666-666666666666";
    const secrets = new Map([
      [`llm-gateway-run-${RUN_ID}`, { id: SECRET_ID, status: "active", scope: "company", expiresAt: new Date(Date.now() + 60_000) }],
      [`llm-gateway-run-${otherRunId}`, { id: "other-secret", status: "active", scope: "company", expiresAt: new Date(Date.now() + 60_000) }],
      [`llm-gateway-run-${nextRunId}`, { id: "next-secret", status: "active", scope: "company", expiresAt: new Date(Date.now() + 60_000) }],
    ]);
    getByNameMock.mockImplementation(async (_companyId: string, name: string) => secrets.get(name) ?? null);
    removeMock.mockImplementation(async (id: string) => {
      for (const [name, secret] of secrets) if (secret.id === id) secrets.delete(name);
    });
    resolveSecretValueMock.mockImplementation(async (_companyId: string, id: string) => {
      if (![...secrets.values()].some((secret) => secret.id === id)) throw new Error("Secret not found");
      return `value-${id}`;
    });

    const first = await findRunScopedGatewayKeyRef({} as never, COMPANY_ID, RUN_ID, {});
    const concurrent = await findRunScopedGatewayKeyRef({} as never, COMPANY_ID, otherRunId, {});
    expect(first?.secretRef.secretId).toBe(SECRET_ID);
    expect(concurrent?.secretRef.secretId).toBe("other-secret");
    expect(await removeRunScopedGatewayKeyRef({} as never, COMPANY_ID, RUN_ID, {})).toBe(true);
    await expect(resolveSecretValueMock(COMPANY_ID, first!.secretRef.secretId)).rejects.toThrow("Secret not found");
    await expect(resolveSecretValueMock(COMPANY_ID, concurrent!.secretRef.secretId)).resolves.toBe("value-other-secret");
    expect(await findRunScopedGatewayKeyRef({} as never, COMPANY_ID, RUN_ID, {})).toBeNull();
    const next = await findRunScopedGatewayKeyRef({} as never, COMPANY_ID, nextRunId, {});
    expect(next?.secretRef.secretId).toBe("next-secret");
    expect(next?.secretRef.secretId).not.toBe(first?.secretRef.secretId);
  });

  it("looks up and removes only the current run's secret", async () => {
    getByNameMock.mockResolvedValue({ id: SECRET_ID, status: "active", scope: "company", expiresAt: new Date(Date.now() + 60_000) });
    removeMock.mockResolvedValue({ id: SECRET_ID });
    const ref = await findRunScopedGatewayKeyRef({} as never, COMPANY_ID, RUN_ID, ENV_WITH_KEY_ENV);
    expect(ref?.secretRef.secretId).toBe(SECRET_ID);
    expect(getByNameMock).toHaveBeenCalledWith(COMPANY_ID, `llm-gateway-run-${RUN_ID}`);
    await removeRunScopedGatewayKeyRef({} as never, COMPANY_ID, RUN_ID, ENV_WITH_KEY_ENV);
    expect(getByNameMock).toHaveBeenLastCalledWith(COMPANY_ID, `llm-gateway-run-${RUN_ID}`);
    expect(removeMock).toHaveBeenCalledWith(SECRET_ID);
  });
});

describe("myrmidon(OPE-12932) removeRunScopedGatewayKeyRef", () => {
  it("deletes the managed key secret and reports the removal", async () => {
    getByNameMock.mockResolvedValue({ id: SECRET_ID, status: "active", scope: "company", expiresAt: new Date(Date.now() + 60_000) });
    removeMock.mockResolvedValue({ id: SECRET_ID });

    expect(
      await removeRunScopedGatewayKeyRef({} as never, COMPANY_ID, AGENT_ID, ENV_WITH_KEY_ENV),
    ).toBe(true);
    expect(removeMock).toHaveBeenCalledWith(SECRET_ID);
  });

  it("treats an already-absent secret as success", async () => {
    getByNameMock.mockResolvedValue(null);
    expect(
      await removeRunScopedGatewayKeyRef({} as never, COMPANY_ID, AGENT_ID, ENV_WITH_KEY_ENV),
    ).toBe(false);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("does not delete the persistent agent key when cleaning up a run", async () => {
    getByNameMock.mockImplementation(async (_companyId: string, name: string) =>
      name === `llm-gateway-key-${AGENT_ID}`
        ? { id: SECRET_ID, status: "active", scope: "company", expiresAt: new Date(Date.now() + 60_000) }
        : null,
    );
    await removeRunScopedGatewayKeyRef({} as never, COMPANY_ID, AGENT_ID, ENV_WITH_KEY_ENV);
    expect(removeMock).not.toHaveBeenCalledWith(SECRET_ID);
  });
});

describe("myrmidon(OPE-12932) resolveExecutionRunAdapterConfig runScopedSecretEnv", () => {
  // Minimal RuntimeConfigSecretResolver (heartbeat.ts): the adapter-config
  // resolver passes the card config through untouched (secret values are
  // resolved by the real service only at dispatch), so the compiled config
  // below shows exactly what the merge itself produced. The collectMissing*
  // probes stay absent on purpose: resolveExecutionRunAdapterConfig guards
  // them with typeof checks.
  const baseInput = () => ({
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    adapterType: "hermes_gateway",
    executionRunConfig: { env: {} },
    projectEnv: null,
    secretsSvc: {
      collectMissingRuntimeBindings: undefined,
      collectMissingAdapterConfigRuntimeBindings: undefined,
      resolveAdapterConfigForRuntime: vi.fn(
        async (_companyId: string, config: Record<string, unknown>) => ({
          config,
          secretKeys: new Set<string>(),
          manifest: [],
        }),
      ),
      resolveEnvBindings: async (_companyId: string, bindings: Record<string, unknown>) => ({
        env: Object.fromEntries(Object.keys(bindings).map((key) => [key, "resolved-run-key"])),
        secretKeys: new Set(Object.keys(bindings)),
        manifest: [],
      }),
    },
  });

  it("keeps the reference separate from the ephemeral resolved dispatch config", async () => {
    const runScopedSecretEnv = { MYRMIDON_LLM_API_KEY: { ...RUN_SCOPED_REF } };
    const { resolvedConfig, secretKeys } = await resolveExecutionRunAdapterConfig({
      ...baseInput(),
      runScopedSecretEnv,
    } as never);

    expect(runScopedSecretEnv.MYRMIDON_LLM_API_KEY).toEqual(RUN_SCOPED_REF);
    expect(JSON.stringify(runScopedSecretEnv)).not.toContain("resolved-run-key");
    expect((resolvedConfig.env as Record<string, unknown>).MYRMIDON_LLM_API_KEY).toBe("resolved-run-key");
    expect(secretKeys.has("MYRMIDON_LLM_API_KEY")).toBe(true);
  });

  it("resolves a run reference before dispatch and marks the resulting value secret", async () => {
    const input = baseInput();
    const resolveEnvBindings = vi.fn(async (_companyId: string, bindings: unknown) => {
      expect(bindings).toEqual({ MYRMIDON_LLM_API_KEY: RUN_SCOPED_REF });
      return { env: { MYRMIDON_LLM_API_KEY: "run-key-canary" }, secretKeys: new Set(["MYRMIDON_LLM_API_KEY"]), manifest: [] };
    });
    const { resolvedConfig, secretKeys } = await resolveExecutionRunAdapterConfig({
      ...input,
      secretsSvc: { ...input.secretsSvc, resolveEnvBindings },
      runScopedSecretEnv: { MYRMIDON_LLM_API_KEY: RUN_SCOPED_REF },
    } as never);
    expect(resolveEnvBindings).toHaveBeenCalledOnce();
    expect((resolvedConfig.env as Record<string, unknown>).MYRMIDON_LLM_API_KEY).toBe("run-key-canary");
    expect(secretKeys.has("MYRMIDON_LLM_API_KEY")).toBe(true);
  });

  it("never overrides a binding that the card/environment already provided", async () => {
    const { resolvedConfig } = await resolveExecutionRunAdapterConfig({
      ...baseInput(),
      executionRunConfig: {
        env: { MYRMIDON_LLM_API_KEY: "own-binding-value" },
      },
      runScopedSecretEnv: {
        MYRMIDON_LLM_API_KEY: { ...RUN_SCOPED_REF },
      },
    } as never);

    const env = resolvedConfig.env as Record<string, unknown>;
    expect(env.MYRMIDON_LLM_API_KEY).toBe("own-binding-value");
  });

  it("resolves only the run reference when a plain binding coexists", async () => {
    const { resolvedConfig } = await resolveExecutionRunAdapterConfig({
      ...baseInput(),
      executionRunConfig: {
        env: { OTHER_KEY: "plain" },
      },
      runScopedSecretEnv: {
        MYRMIDON_LLM_API_KEY: { ...RUN_SCOPED_REF },
      },
    } as never);

    const env = resolvedConfig.env as Record<string, unknown>;
    expect(env.OTHER_KEY).toBe("plain");
    expect(env.MYRMIDON_LLM_API_KEY).toBe("resolved-run-key");
  });
});

// Keep the card type import referenced for future resolver-level tests.
export type { GatewayBotCard };
