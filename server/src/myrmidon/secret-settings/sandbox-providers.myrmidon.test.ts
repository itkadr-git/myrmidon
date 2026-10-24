// myrmidon(SETTINGS-UI E2.8): sandbox provider credentials through the instance secret-ref
// resolver. Pure: in-memory store, no database.

import { describe, expect, it } from "vitest";
import { HttpError } from "../../errors.js";
import { buildPluginWorkerEnv } from "../../services/plugin-loader.js";
import { InstanceSecretSettingRegistry, INSTANCE_SECRET_SETTINGS } from "./registry.js";
import {
  createInstanceSecretSettingResolver,
  type InstanceSecretBinding,
  type InstanceSecretSettingStore,
} from "./resolver.js";
import {
  SANDBOX_PROVIDER_REGISTRY_ENTRIES,
  SANDBOX_PROVIDER_SECRET_SETTINGS,
  resolveSandboxProviderSecret,
} from "./sandbox-providers.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const SECRET = "22222222-2222-4222-8222-222222222222";
const REF_VALUE = "ref-held-sandbox-key-must-not-leak";
const ENV_VALUE = "env-break-glass-sandbox-key";

function make(env: NodeJS.ProcessEnv = {}) {
  const bindings = new Map<string, InstanceSecretBinding>();
  const secret = { name: "daytona", status: "active", companyId: COMPANY, value: REF_VALUE };
  const redacted: string[] = [];
  const store: InstanceSecretSettingStore = {
    async getBinding(name) {
      return bindings.get(name) ?? null;
    },
    async resolveValue() {
      if (secret.status !== "active") {
        throw new HttpError(422, "Secret is not active", { code: "secret_inactive" });
      }
      return secret.value;
    },
    async describeSecret() {
      return { name: secret.name, status: secret.status, companyId: COMPANY };
    },
    async setBinding(name, secretId) {
      const b = { companyId: COMPANY, secretId };
      bindings.set(name, b);
      return b;
    },
    async clearBinding(name) {
      return bindings.delete(name);
    },
  };
  const resolver = createInstanceSecretSettingResolver({
    registry: new InstanceSecretSettingRegistry(SANDBOX_PROVIDER_REGISTRY_ENTRIES),
    store,
    env,
    registerForRedaction: (v) => redacted.push(v),
  });
  const warnings: Array<Record<string, unknown>> = [];
  const log = { warn: (obj: Record<string, unknown>) => void warnings.push(obj) };
  return { resolver, secret, redacted, warnings, log };
}

const DAYTONA = SANDBOX_PROVIDER_SECRET_SETTINGS[0]!;

describe("sandbox provider secret settings", () => {
  it("registers exactly the four provider keys with their documented env override", () => {
    const rows = INSTANCE_SECRET_SETTINGS.filter((e) => e.name.startsWith("sandbox."));
    expect(rows.map((r) => [r.name, r.envOverride, r.consumers])).toEqual([
      ["sandbox.daytona.api_key", "DAYTONA_API_KEY", ["plugin-worker:daytona"]],
      ["sandbox.e2b.api_key", "E2B_API_KEY", ["plugin-worker:e2b"]],
      ["sandbox.exe-dev.api_key", "EXE_API_KEY", ["plugin-worker:exe-dev"]],
      ["sandbox.novita.api_key", "NOVITA_API_KEY", ["plugin-worker:novita"]],
    ]);
  });

  it("returns null for an unbound ref (missing) without logging a failure", async () => {
    const t = make();
    expect(await resolveSandboxProviderSecret(t.resolver, "DAYTONA_API_KEY", t.log)).toBeNull();
    expect(t.warnings).toEqual([]);
  });

  it("resolves a bound ref and registers the value for masking", async () => {
    const t = make();
    await t.resolver.setRef(DAYTONA.settingName, SECRET);
    expect(await resolveSandboxProviderSecret(t.resolver, "DAYTONA_API_KEY", t.log)).toBe(REF_VALUE);
    expect(t.redacted).toEqual([REF_VALUE]);
  });

  it("emergency env override wins over the ref (priority)", async () => {
    const t = make({ DAYTONA_API_KEY: ENV_VALUE });
    await t.resolver.setRef(DAYTONA.settingName, SECRET);
    expect(await resolveSandboxProviderSecret(t.resolver, "DAYTONA_API_KEY", t.log)).toBe(ENV_VALUE);
  });

  it("change: swapping the ref applies on the next resolve; revoke: clearing it empties the result", async () => {
    const t = make();
    await t.resolver.setRef(DAYTONA.settingName, SECRET);
    t.secret.value = "rotated-value";
    expect(await resolveSandboxProviderSecret(t.resolver, "DAYTONA_API_KEY", t.log)).toBe("rotated-value");
    await t.resolver.clearRef(DAYTONA.settingName);
    expect(await resolveSandboxProviderSecret(t.resolver, "DAYTONA_API_KEY", t.log)).toBeNull();
  });

  it("denied: another plugin worker cannot resolve the daytona setting", async () => {
    const t = make();
    await t.resolver.setRef(DAYTONA.settingName, SECRET);
    await expect(
      t.resolver.resolve(DAYTONA.settingName, { consumerId: "plugin-worker:e2b" }),
    ).rejects.toMatchObject({ status: 403, details: { code: "setting_consumer_denied" } });
  });

  it("an inactive secret yields null and a code-only warning with no value", async () => {
    const t = make();
    await t.resolver.setRef(DAYTONA.settingName, SECRET);
    t.secret.status = "disabled";
    expect(await resolveSandboxProviderSecret(t.resolver, "DAYTONA_API_KEY", t.log)).toBeNull();
    expect(t.warnings).toEqual([{ settingName: DAYTONA.settingName, code: "secret_inactive" }]);
    expect(JSON.stringify(t.warnings)).not.toContain(REF_VALUE);
  });

  it("ignores env vars that are not sandbox provider keys", async () => {
    const t = make();
    expect(await resolveSandboxProviderSecret(t.resolver, "SLACK_BOT_TOKEN", t.log)).toBeNull();
  });
});

describe("buildPluginWorkerEnv with instance secret refs", () => {
  const instanceInfo = { deploymentMode: "authenticated", deploymentExposure: "public" };
  const manifest = {
    capabilities: ["environment.drivers.register"],
    environmentDrivers: [{ driverKey: "daytona" }],
  } as never;

  it("hands the ref-resolved key to a trusted provider worker", () => {
    const env = buildPluginWorkerEnv({
      manifest,
      packageName: "@myrmidon/plugin-daytona",
      packagePath: null,
      instanceInfo,
      processEnv: {},
      instanceSecretEnv: { DAYTONA_API_KEY: REF_VALUE },
    });
    expect(env.DAYTONA_API_KEY).toBe(REF_VALUE);
  });

  it("process env (emergency override) wins over the resolved ref", () => {
    const env = buildPluginWorkerEnv({
      manifest,
      packageName: "@myrmidon/plugin-daytona",
      packagePath: null,
      instanceInfo,
      processEnv: { DAYTONA_API_KEY: ENV_VALUE },
      instanceSecretEnv: { DAYTONA_API_KEY: REF_VALUE },
    });
    expect(env.DAYTONA_API_KEY).toBe(ENV_VALUE);
  });

  it("an untrusted plugin claiming the name receives nothing", () => {
    const env = buildPluginWorkerEnv({
      manifest,
      packageName: "@myrmidon/plugin-daytona",
      packagePath: "/home/op/evil-plugin",
      trustedLocalPluginRoots: ["/opt/trusted"],
      instanceInfo,
      processEnv: {},
      instanceSecretEnv: { DAYTONA_API_KEY: REF_VALUE },
    });
    expect(env).not.toHaveProperty("DAYTONA_API_KEY");
  });

  it("a key outside the provider's own list is never injected", () => {
    const env = buildPluginWorkerEnv({
      manifest,
      packageName: "@myrmidon/plugin-daytona",
      packagePath: null,
      instanceInfo,
      processEnv: {},
      instanceSecretEnv: { E2B_API_KEY: REF_VALUE },
    });
    expect(env).not.toHaveProperty("E2B_API_KEY");
  });
});

describe("runner ACPX Codex auth JSON setting", () => {
  const name = "runner.acpx_codex_auth_json";
  const row = INSTANCE_SECRET_SETTINGS.find((e) => e.name === name)!;
  const reg = () => new InstanceSecretSettingRegistry([row]);
  const store = (): InstanceSecretSettingStore => {
    let b: InstanceSecretBinding | null = null;
    return {
      getBinding: async () => b,
      resolveValue: async () => REF_VALUE,
      describeSecret: async () => ({ name: "codex", status: "active", companyId: COMPANY }),
      setBinding: async (_n, id) => (b = { companyId: COMPANY, secretId: id }),
      clearBinding: async () => ((b = null), true),
    };
  };

  it("is registered with the env name the runner reads, for the runner environment only", () => {
    expect(row.envOverride).toBe("PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET");
    expect(row.consumers).toEqual(["runner-environment"]);
  });

  it("missing, ref, env priority, denied, revoke", async () => {
    const mk = (env: NodeJS.ProcessEnv = {}) =>
      createInstanceSecretSettingResolver({ registry: reg(), store: store(), env });
    const ctx = { consumerId: "runner-environment" };
    await expect(mk().resolve(name, ctx)).rejects.toMatchObject({ details: { code: "setting_ref_missing" } });
    const r = mk();
    await r.setRef(name, SECRET);
    expect((await r.resolve(name, ctx)).value).toBe(REF_VALUE);
    await expect(r.resolve(name, { consumerId: "plugin-worker:e2b" })).rejects.toMatchObject({ status: 403 });
    await r.clearRef(name);
    await expect(r.resolve(name, ctx)).rejects.toMatchObject({ details: { code: "setting_ref_missing" } });
    const e = mk({ PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: ENV_VALUE });
    await e.setRef(name, SECRET);
    expect(await e.resolve(name, ctx)).toEqual({ source: "env", value: ENV_VALUE });
  });
});
