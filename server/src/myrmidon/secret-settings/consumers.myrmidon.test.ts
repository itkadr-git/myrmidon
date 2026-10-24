// myrmidon(SETTINGS-UI E2.6): application consumers of the instance secret-ref resolver.
// Pins, per registered setting: missing ref, denied consumer, change, revoke, env priority
// and non-disclosure. The store is an in-memory fake; the registry is the real default one.

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../errors.js";
import { defaultInstanceSecretSettingRegistry, INSTANCE_SECRET_SETTINGS } from "./registry.js";
import {
  createInstanceSecretSettingResolver,
  type InstanceSecretBinding,
  type InstanceSecretSettingStore,
} from "./resolver.js";
import { installInstanceSecretResolver, resolveOptionalInstanceSecret } from "./runtime.js";
import { readTracingHealthSettings, withClickhousePassword } from "../tracing-health/probes.js";
import { lazyScreenConsoleClient, ScreenConsoleError } from "../browser-console/screen-console-client.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const SECRET_A = "22222222-2222-4222-8222-222222222222";
const SECRET_B = "33333333-3333-4333-8333-333333333333";
const SECRET_OFF = "44444444-4444-4444-8444-444444444444";
const VALUE_A = "value-a-must-not-leak";
const VALUE_B = "value-b-must-not-leak";
const ENV_VALUE = "env-break-glass-value";

const CASES = [
  { name: "stack.github_token", env: "MYRMIDON_STACK_GITHUB_TOKEN", consumer: "stack-registry" },
  { name: "tracing.clickhouse_password", env: "MYRMIDON_TRACING_CLICKHOUSE_PASSWORD", consumer: "tracing-health" },
  { name: "browser_console.node_token", env: "MYRMIDON_BROWSER_CONSOLE_TOKEN", consumer: "browser-console" },
] as const;

function setup() {
  const bindings = new Map<string, InstanceSecretBinding>();
  const secrets = new Map<string, { name: string; status: string; value: string }>([
    [SECRET_A, { name: "a", status: "active", value: VALUE_A }],
    [SECRET_B, { name: "b", status: "active", value: VALUE_B }],
    [SECRET_OFF, { name: "off", status: "disabled", value: "x" }],
  ]);
  const redacted: string[] = [];
  const store: InstanceSecretSettingStore = {
    async getBinding(name) {
      return bindings.get(name) ?? null;
    },
    async resolveValue(input) {
      const s = secrets.get(input.secretId);
      if (!s) throw new HttpError(404, "Secret not found", { code: "secret_missing" });
      if (s.status !== "active") throw new HttpError(422, "Secret is not active", { code: "secret_inactive" });
      return s.value;
    },
    async describeSecret(id) {
      const s = secrets.get(id);
      return s ? { name: s.name, status: s.status, companyId: COMPANY } : null;
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
    registry: defaultInstanceSecretSettingRegistry,
    store,
    env: {},
    registerForRedaction: (v) => redacted.push(v),
  });
  installInstanceSecretResolver(resolver);
  return { resolver, secrets, redacted };
}

afterEach(() => installInstanceSecretResolver(null));

describe("E2.6 registered application settings", () => {
  it("registers the value-carrying application names, none of them bootstrap", () => {
    expect(INSTANCE_SECRET_SETTINGS.map((s) => s.envOverride)).toEqual(expect.arrayContaining(CASES.map((c) => c.env)));
    for (const entry of INSTANCE_SECRET_SETTINGS) {
      expect(entry.envOverride).not.toMatch(/MASTER_KEY|BETTER_AUTH|SIGNING|PEPPER|HANDOFF|AWS_/);
    }
  });

  for (const c of CASES) {
    describe(c.name, () => {
      it("missing ref reads as null (integration stays off)", async () => {
        setup();
        expect(await resolveOptionalInstanceSecret(c.name, c.consumer, {})).toBeNull();
      });

      it("denies a consumer outside the scope", async () => {
        const { resolver } = setup();
        await expect(resolver.setRef(c.name, SECRET_A)).resolves.toBeTruthy();
        await expect(resolver.resolve(c.name, { consumerId: "some-other-module" })).rejects.toMatchObject({
          status: 403,
          details: { code: "setting_consumer_denied" },
        });
      });

      it("resolves the bound ref, follows a changed ref, and fails closed on revoke", async () => {
        const { resolver, secrets } = setup();
        await resolver.setRef(c.name, SECRET_A);
        expect(await resolveOptionalInstanceSecret(c.name, c.consumer, {})).toBe(VALUE_A);
        await resolver.setRef(c.name, SECRET_B);
        expect(await resolveOptionalInstanceSecret(c.name, c.consumer, {})).toBe(VALUE_B);
        secrets.get(SECRET_B)!.status = "disabled";
        expect(await resolveOptionalInstanceSecret(c.name, c.consumer, {})).toBeNull();
        secrets.get(SECRET_B)!.status = "active";
        await resolver.clearRef(c.name);
        expect(await resolveOptionalInstanceSecret(c.name, c.consumer, {})).toBeNull();
      });

      it("emergency env override wins over the ref", async () => {
        const { resolver } = setup();
        await resolver.setRef(c.name, SECRET_A);
        expect(await resolveOptionalInstanceSecret(c.name, c.consumer, { [c.env]: ENV_VALUE })).toBe(ENV_VALUE);
        expect(await resolveOptionalInstanceSecret(c.name, c.consumer, { [c.env]: "   " })).toBe(VALUE_A);
      });

      it("status, plan and errors carry no value", async () => {
        const { resolver } = setup();
        await resolver.setRef(c.name, SECRET_A);
        const dump = JSON.stringify([await resolver.list(), await resolver.migrationPlan()]);
        expect(dump).not.toContain(VALUE_A);
        const denied = await resolver.resolve(c.name, { consumerId: "x" }).catch((e) => e);
        expect(JSON.stringify({ m: denied.message, d: denied.details })).not.toContain(VALUE_A);
      });
    });
  }

  it("a refused ref is logged by code only, never by value", async () => {
    const { resolver, secrets } = setup();
    await resolver.setRef("stack.github_token", SECRET_A);
    secrets.get(SECRET_A)!.status = "disabled";
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await resolveOptionalInstanceSecret("stack.github_token", "stack-registry", {})).toBeNull();
    expect(JSON.stringify(spy.mock.calls)).not.toContain(VALUE_A);
    spy.mockRestore();
  });

  it("an unregistered name is never resolved", async () => {
    setup();
    expect(await resolveOptionalInstanceSecret("unknown.name", "stack-registry", { X: "1" })).toBeNull();
  });
});

describe("E2.6 consumer wiring", () => {
  it("tracing: env password is kept, ref fills a missing one", async () => {
    const { resolver } = setup();
    await resolver.setRef("tracing.clickhouse_password", SECRET_A);
    const base = readTracingHealthSettings({ MYRMIDON_TRACING_CLICKHOUSE_URL: "http://ch" });
    expect((await withClickhousePassword(base, {})).clickhousePassword).toBe(VALUE_A);
    const withEnv = readTracingHealthSettings({ MYRMIDON_TRACING_CLICKHOUSE_PASSWORD: ENV_VALUE });
    expect((await withClickhousePassword(withEnv, {})).clickhousePassword).toBe(ENV_VALUE);
  });

  it("browser console: token resolved per call, unconfigured gives 503", async () => {
    let token: string | null = null;
    const seen: string[] = [];
    const client = lazyScreenConsoleClient(async () => (token ? { host: "http://node", token } : null), {
      fetch: async (_url, init) => {
        seen.push(String((init.headers as Record<string, string>).authorization));
        return new Response("{}", { status: 200 });
      },
    });
    await expect(client.pauseBots("b1")).rejects.toBeInstanceOf(ScreenConsoleError);
    token = "t1";
    await client.pauseBots("b1");
    token = "t2";
    await client.resumeBots("b1");
    expect(seen).toEqual(["Bearer t1", "Bearer t2"]);
  });
});
