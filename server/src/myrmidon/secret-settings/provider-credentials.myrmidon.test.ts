// myrmidon(SETTINGS-UI E2.2): the instance-scoped provider credential (OpenAI key used by the
// Codex model discovery) as a secret-ref setting. The store is an in-memory fake; the resolver,
// the registry and the real codex-models consumer are the production code.

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../errors.js";
import { INSTANCE_SECRET_SETTINGS, InstanceSecretSettingRegistry } from "./registry.js";
import {
  CODEX_MODEL_DISCOVERY_CONSUMER,
  OPENAI_DISCOVERY_SETTING,
} from "./provider-settings.js";
import {
  createInstanceSecretSettingResolver,
  type InstanceSecretBinding,
  type InstanceSecretSettingStore,
} from "./resolver.js";
import { resolveOptionalInstanceSecret, installInstanceSecretResolver } from "./runtime.js";
import { listCodexModels, resetCodexModelsCacheForTests } from "../../adapters/codex-models.js";

const REF_KEY = "sk-ref-discovery-key-value";
const ENV_KEY = "sk-env-emergency-key-value";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const SECRET_OK = "22222222-2222-4222-8222-222222222222";
const SECRET_OFF = "33333333-3333-4333-8333-333333333333";

function makeResolver(env: NodeJS.ProcessEnv, consumers?: string[]) {
  const registry = new InstanceSecretSettingRegistry(
    INSTANCE_SECRET_SETTINGS.map((entry) =>
      consumers ? { ...entry, consumers } : entry,
    ),
  );
  const bindings = new Map<string, InstanceSecretBinding>();
  const secrets = new Map<string, { name: string; status: string; value: string }>([
    [SECRET_OK, { name: "openai-discovery", status: "active", value: REF_KEY }],
    [SECRET_OFF, { name: "openai-old", status: "disabled", value: "sk-old" }],
  ]);
  const store: InstanceSecretSettingStore = {
    async getBinding(name) {
      return bindings.get(name) ?? null;
    },
    async resolveValue(input) {
      const secret = secrets.get(input.secretId);
      if (!secret) throw new HttpError(404, "Secret not found", { code: "secret_missing" });
      if (secret.status !== "active") {
        throw new HttpError(422, "Secret is not active", { code: "secret_inactive" });
      }
      return secret.value;
    },
    async describeSecret(id) {
      const secret = secrets.get(id);
      return secret ? { name: secret.name, status: secret.status, companyId: COMPANY } : null;
    },
    async setBinding(name, secretId) {
      const binding = { companyId: COMPANY, secretId };
      bindings.set(name, binding);
      return binding;
    },
    async clearBinding(name) {
      return bindings.delete(name);
    },
    async createSecret() {
      throw new Error("not used in this suite");
    },
  };
  const redacted: string[] = [];
  const resolver = createInstanceSecretSettingResolver({
    registry,
    store,
    env,
    registerForRedaction: (value) => redacted.push(value),
  });
  return { resolver, secrets, redacted };
}

function mockModelsFetch() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ id: "gpt-ref-only" }] }),
  } as Response);
}

function authorizationOf(spy: ReturnType<typeof mockModelsFetch>): string | null {
  const init = spy.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.Authorization ?? null;
}

describe("provider credential registration", () => {
  it("registers the OpenAI discovery key with OPENAI_API_KEY as the emergency override", () => {
    const entry = INSTANCE_SECRET_SETTINGS.find((e) => e.name === OPENAI_DISCOVERY_SETTING);
    expect(entry?.envOverride).toBe("OPENAI_API_KEY");
    expect(entry?.consumers).toEqual([CODEX_MODEL_DISCOVERY_CONSUMER]);
  });

  it("registers no per-agent adapter credential and no bootstrap name as an instance setting", () => {
    const overrides = INSTANCE_SECRET_SETTINGS.map((e) => e.envOverride);
    for (const perAgent of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CODEX_API_KEY",
      "CURSOR_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "KIMI_MODEL_API_KEY",
      "OPENCLAW_TOKEN",
      "XAI_API_KEY",
    ]) {
      expect(overrides).not.toContain(perAgent);
    }
  });
});

describe("Codex model discovery key resolution", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    resetCodexModelsCacheForTests();
  });
  afterEach(() => {
    installInstanceSecretResolver(null);
    delete process.env.OPENAI_API_KEY;
    vi.restoreAllMocks();
  });

  it("uses the bound reference when no emergency env is set", async () => {
    const { resolver } = makeResolver({});
    await resolver.setRef(OPENAI_DISCOVERY_SETTING, SECRET_OK);
    installInstanceSecretResolver(resolver);
    const fetchSpy = mockModelsFetch();
    const models = await listCodexModels();
    expect(authorizationOf(fetchSpy)).toBe(`Bearer ${REF_KEY}`);
    expect(models.some((m) => m.id === "gpt-ref-only")).toBe(true);
  });

  it("lets the emergency OPENAI_API_KEY win over the bound reference", async () => {
    process.env.OPENAI_API_KEY = ENV_KEY;
    const { resolver } = makeResolver({ OPENAI_API_KEY: ENV_KEY });
    await resolver.setRef(OPENAI_DISCOVERY_SETTING, SECRET_OK);
    installInstanceSecretResolver(resolver);
    const fetchSpy = mockModelsFetch();
    await listCodexModels();
    expect(authorizationOf(fetchSpy)).toBe(`Bearer ${ENV_KEY}`);
  });

  it("does not read a plaintext llm.apiKey from the config file any more", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../adapters/codex-models.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/readConfigFile|config-file|llm\??\.apiKey/);
  });

  it("falls back to the static list, without a request, when no reference is bound", async () => {
    const { resolver } = makeResolver({});
    installInstanceSecretResolver(resolver);
    const fetchSpy = mockModelsFetch();
    const models = await listCodexModels();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(models.length).toBeGreaterThan(0);
  });

  it("stops using the key after the reference is cleared (revoke)", async () => {
    const { resolver } = makeResolver({});
    await resolver.setRef(OPENAI_DISCOVERY_SETTING, SECRET_OK);
    installInstanceSecretResolver(resolver);
    const fetchSpy = mockModelsFetch();
    await listCodexModels();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await resolver.clearRef(OPENAI_DISCOVERY_SETTING);
    resetCodexModelsCacheForTests();
    fetchSpy.mockClear();
    await listCodexModels();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("switches to the new key when the reference is replaced", async () => {
    const { resolver, secrets } = makeResolver({});
    secrets.set("44444444-4444-4444-8444-444444444444", {
      name: "openai-new",
      status: "active",
      value: "sk-replacement-key",
    });
    await resolver.setRef(OPENAI_DISCOVERY_SETTING, SECRET_OK);
    installInstanceSecretResolver(resolver);
    const fetchSpy = mockModelsFetch();
    await listCodexModels();
    await resolver.setRef(OPENAI_DISCOVERY_SETTING, "44444444-4444-4444-8444-444444444444");
    fetchSpy.mockClear();
    await listCodexModels();
    expect(authorizationOf(fetchSpy)).toBe("Bearer sk-replacement-key");
  });

  it("treats a disabled secret as no key and does not call out", async () => {
    const { resolver, secrets } = makeResolver({});
    await resolver.setRef(OPENAI_DISCOVERY_SETTING, SECRET_OK);
    secrets.get(SECRET_OK)!.status = "disabled";
    installInstanceSecretResolver(resolver);
    const fetchSpy = mockModelsFetch();
    await listCodexModels();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("denied consumer, missing ref and masking", () => {
  afterEach(() => installInstanceSecretResolver(null));

  it("denies any consumer that is not registered for the setting", async () => {
    const { resolver } = makeResolver({});
    await resolver.setRef(OPENAI_DISCOVERY_SETTING, SECRET_OK);
    await expect(
      resolver.resolve(OPENAI_DISCOVERY_SETTING, { consumerId: "some-other-consumer" }),
    ).rejects.toMatchObject({ status: 403, details: { code: "setting_consumer_denied" } });
  });

  it("returns null for a consumer that is denied by the registry (scope not widened by the helper)", async () => {
    const { resolver } = makeResolver({}, ["not-the-discovery-consumer"]);
    await resolver.setRef(OPENAI_DISCOVERY_SETTING, SECRET_OK);
    installInstanceSecretResolver(resolver);
    expect(
      await resolveOptionalInstanceSecret(OPENAI_DISCOVERY_SETTING, CODEX_MODEL_DISCOVERY_CONSUMER),
    ).toBeNull();
  });

  it("reports a missing reference with a typed code and no value", async () => {
    const { resolver } = makeResolver({});
    const err = await resolver
      .resolve(OPENAI_DISCOVERY_SETTING, { consumerId: CODEX_MODEL_DISCOVERY_CONSUMER })
      .catch((e) => e);
    expect(err).toMatchObject({ status: 422, details: { code: "setting_ref_missing" } });
    expect(JSON.stringify(err.details)).not.toContain(REF_KEY);
  });

  it("registers the resolved value for log masking and never puts it in a status or plan", async () => {
    const { resolver, redacted } = makeResolver({});
    await resolver.setRef(OPENAI_DISCOVERY_SETTING, SECRET_OK);
    await resolver.resolve(OPENAI_DISCOVERY_SETTING, { consumerId: CODEX_MODEL_DISCOVERY_CONSUMER });
    expect(redacted).toContain(REF_KEY);
    const view = JSON.stringify([await resolver.list(), await resolver.migrationPlan()]);
    expect(view).not.toContain(REF_KEY);
  });

  it("returns null when no resolver is installed", async () => {
    installInstanceSecretResolver(null);
    expect(
      await resolveOptionalInstanceSecret(OPENAI_DISCOVERY_SETTING, CODEX_MODEL_DISCOVERY_CONSUMER),
    ).toBeNull();
  });
});
