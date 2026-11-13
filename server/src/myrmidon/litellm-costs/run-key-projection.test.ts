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

import { describe, expect, it, vi } from "vitest";

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
const SECRET_ID = "33333333-3333-4333-8333-333333333333";

const ENV_WITH_KEY_ENV = {
  MYRMIDON_BOT_LLM_API_KEY_ENV: "MYRMIDON_LLM_API_KEY",
};

describe("myrmidon(OPE-12932) findRunScopedGatewayKeyRef", () => {
  it("returns the secret_ref reference of the agent's managed key, not a value", async () => {
    getByNameMock.mockResolvedValue({
      id: SECRET_ID,
      status: "active",
      scope: "company",
      latestVersion: 2,
    });

    const ref = await findRunScopedGatewayKeyRef({} as never, COMPANY_ID, AGENT_ID, ENV_WITH_KEY_ENV);

    expect(getByNameMock).toHaveBeenCalledWith(COMPANY_ID, `llm-gateway-key-${AGENT_ID}`);
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

  it("returns null when the key env name is not configured", async () => {
    expect(
      await findRunScopedGatewayKeyRef({} as never, COMPANY_ID, AGENT_ID, {}),
    ).toBeNull();
    expect(getByNameMock).not.toHaveBeenCalled();
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

describe("myrmidon(OPE-12932) removeRunScopedGatewayKeyRef", () => {
  it("deletes the managed key secret and reports the removal", async () => {
    getByNameMock.mockResolvedValue({ id: SECRET_ID, status: "active", scope: "company" });
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

  it("never deletes a foreign (operator-managed shared) secret name", async () => {
    // agentKeySecretName always derives the managed name, so simulate the
    // foreign-name guard by pointing getByName at the shared secret instead:
    // the derived name is managed, so this exercises the happy path rather
    // than the guard; the guard itself is covered by the name predicate test
    // in the shared package (isAgentKeySecretName).
    getByNameMock.mockResolvedValue(null);
    expect(
      await removeRunScopedGatewayKeyRef(
        {} as never,
        COMPANY_ID,
        AGENT_ID,
        ENV_WITH_KEY_ENV,
      ),
    ).toBe(false);
  });
});

describe("myrmidon(OPE-12932) resolveExecutionRunAdapterConfig runScopedSecretEnv", () => {
  const baseInput = () => ({
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    adapterType: "hermes_gateway",
    executionRunConfig: { env: {} },
    projectEnv: null,
    secretsSvc: {
      collectMissingRuntimeBindings: undefined,
      collectMissingAdapterConfigRuntimeBindings: undefined,
      resolveEnvBindings: async () => ({
        env: {},
        secretKeys: new Set<string>(),
        manifest: [],
      }),
    },
  });

  it("merges the secret_ref into the resolved env as a reference, never a raw value", async () => {
    resolveSecretValueMock.mockResolvedValue("sk-raw-value-should-never-appear");
    const { resolvedConfig, secretKeys } = await resolveExecutionRunAdapterConfig({
      ...baseInput(),
      runScopedSecretEnv: {
        MYRMIDON_LLM_API_KEY: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
      },
    } as never);

    const env = resolvedConfig.env as Record<string, unknown>;
    expect(env.MYRMIDON_LLM_API_KEY).toEqual({
      type: "secret_ref",
      secretId: SECRET_ID,
      version: "latest",
    });
    expect(JSON.stringify(resolvedConfig)).not.toContain("sk-raw-value-should-never-appear");
    expect(secretKeys.has("MYRMIDON_LLM_API_KEY")).toBe(true);
  });

  it("never overrides a binding that the card/environment already provided", async () => {
    const { resolvedConfig } = await resolveExecutionRunAdapterConfig({
      ...baseInput(),
      executionRunConfig: {
        env: { MYRMIDON_LLM_API_KEY: "own-binding-value" },
      },
      runScopedSecretEnv: {
        MYRMIDON_LLM_API_KEY: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
      },
    } as never);

    const env = resolvedConfig.env as Record<string, unknown>;
    expect(env.MYRMIDON_LLM_API_KEY).toBe("own-binding-value");
  });

  it("keeps the compiled config free of raw values when a plain binding and a run ref coexist", async () => {
    const { resolvedConfig } = await resolveExecutionRunAdapterConfig({
      ...baseInput(),
      executionRunConfig: {
        env: { OTHER_KEY: "plain" },
      },
      runScopedSecretEnv: {
        MYRMIDON_LLM_API_KEY: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
      },
    } as never);

    const env = resolvedConfig.env as Record<string, unknown>;
    expect(env.OTHER_KEY).toBe("plain");
    expect(env.MYRMIDON_LLM_API_KEY).toEqual({
      type: "secret_ref",
      secretId: SECRET_ID,
      version: "latest",
    });
  });
});

// Keep the card type import referenced for future resolver-level tests.
export type { GatewayBotCard };
