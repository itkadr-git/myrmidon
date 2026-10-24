// myrmidon(SETTINGS-UI E2.4): tool OAuth client secret lookup. Pure: in-memory store, injected
// env. Pins priority (provider env > instance env > provider ref > instance ref), missing and
// denied refs, replace/revoke, typed failure of a broken ref, masking and non-disclosure.

import { describe, expect, it } from "vitest";
import { HttpError } from "../../errors.js";
import {
  defaultInstanceSecretSettingRegistry,
  InstanceSecretSettingRegistry,
  INSTANCE_SECRET_SETTING_FAMILIES,
  INSTANCE_SECRET_SETTINGS,
  TOOL_OAUTH_CLIENT_SECRET_SETTING,
  toolOauthProviderSecretSettingName,
} from "./registry.js";
import {
  createInstanceSecretSettingResolver,
  type InstanceSecretBinding,
  type InstanceSecretSettingStore,
} from "./resolver.js";
import { createToolOauthClientSecretLookup } from "./tool-oauth.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const S_PROVIDER = "22222222-2222-4222-8222-222222222222";
const S_INSTANCE = "33333333-3333-4333-8333-333333333333";
const S_OTHER = "44444444-4444-4444-8444-444444444444";
const S_OFF = "55555555-5555-4555-8555-555555555555";
const PROVIDER_NAME = "tool-oauth.slack.client-secret";

function make(env: NodeJS.ProcessEnv = {}, registry = defaultInstanceSecretSettingRegistry) {
  const bindings = new Map<string, InstanceSecretBinding>();
  const secrets = new Map<string, { name: string; status: string; value: string }>([
    [S_PROVIDER, { name: "slack", status: "active", value: "provider-ref-value" }],
    [S_INSTANCE, { name: "shared", status: "active", value: "instance-ref-value" }],
    [S_OTHER, { name: "rotated", status: "active", value: "rotated-ref-value" }],
    [S_OFF, { name: "off", status: "disabled", value: "disabled-value" }],
  ]);
  const redacted: string[] = [];
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
    async describeSecret(secretId) {
      const secret = secrets.get(secretId);
      return secret ? { name: secret.name, status: secret.status, companyId: COMPANY } : null;
    },
    async createSecret() {
      return "66666666-6666-4666-8666-666666666666";
    },
    async setBinding(name, secretId) {
      const binding = { companyId: COMPANY, secretId };
      bindings.set(name, binding);
      return binding;
    },
    async clearBinding(name) {
      return bindings.delete(name);
    },
  };
  const resolver = createInstanceSecretSettingResolver({
    registry,
    store,
    env,
    registerForRedaction: (value) => redacted.push(value),
  });
  const lookup = createToolOauthClientSecretLookup({ resolver, env: () => env });
  return { resolver, lookup, bindings, redacted };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    const e = err as HttpError;
    return { status: e.status, code: (e.details as { code?: string } | undefined)?.code, message: e.message };
  }
  return null;
}

describe("tool OAuth client secret lookup", () => {
  it("returns null when nothing is configured (missing ref is not an error)", async () => {
    const t = make();
    expect(await t.lookup("slack")).toBeNull();
  });

  it("uses the provider ref, then the instance ref", async () => {
    const t = make();
    await t.resolver.setRef(TOOL_OAUTH_CLIENT_SECRET_SETTING, S_INSTANCE);
    expect(await t.lookup("slack")).toBe("instance-ref-value");
    await t.resolver.setRef(PROVIDER_NAME, S_PROVIDER);
    expect(await t.lookup("slack")).toBe("provider-ref-value");
    expect(await t.lookup("notion")).toBe("instance-ref-value");
    expect(t.redacted).toContain("provider-ref-value");
  });

  it("emergency env wins over refs: provider env, then instance env (incl. legacy alias)", async () => {
    const t = make({
      PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_SECRET: "env-provider",
      PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET: "env-instance-legacy",
    });
    await t.resolver.setRef(PROVIDER_NAME, S_PROVIDER);
    await t.resolver.setRef(TOOL_OAUTH_CLIENT_SECRET_SETTING, S_INSTANCE);
    expect(await t.lookup("slack")).toBe("env-provider");
    expect(await t.lookup("notion")).toBe("env-instance-legacy");
    const canonical = make({ MYRMIDON_TOOL_OAUTH_CLIENT_SECRET: "env-canonical" });
    await canonical.resolver.setRef(TOOL_OAUTH_CLIENT_SECRET_SETTING, S_INSTANCE);
    expect(await canonical.lookup("notion")).toBe("env-canonical");
  });

  it("treats an empty env value as unset and falls to the ref", async () => {
    const t = make({ PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_SECRET: "  ", MYRMIDON_TOOL_OAUTH_CLIENT_SECRET: "" });
    await t.resolver.setRef(PROVIDER_NAME, S_PROVIDER);
    expect(await t.lookup("slack")).toBe("provider-ref-value");
  });

  it("replaces and revokes a ref", async () => {
    const t = make();
    await t.resolver.setRef(PROVIDER_NAME, S_PROVIDER);
    await t.resolver.setRef(PROVIDER_NAME, S_OTHER);
    expect(await t.lookup("slack")).toBe("rotated-ref-value");
    await t.resolver.clearRef(PROVIDER_NAME);
    expect(await t.lookup("slack")).toBeNull();
  });

  it("fails typed on a bound but unusable ref instead of degrading to a public client", async () => {
    const t = make();
    await t.resolver.setRef(PROVIDER_NAME, S_PROVIDER);
    // the secret was disabled after binding
    t.bindings.set(PROVIDER_NAME, { companyId: COMPANY, secretId: S_OFF });
    expect(await failure(t.lookup("slack"))).toMatchObject({ status: 422, code: "secret_inactive" });
  });

  it("denies a consumer that is not in the setting scope", async () => {
    const t = make();
    const denied = await failure(t.resolver.resolve(PROVIDER_NAME, { consumerId: "cloud-connector" }));
    expect(denied).toMatchObject({ status: 403, code: "setting_consumer_denied" });
    // and a registry without the consumer propagates the denial through the lookup
    const scoped = new InstanceSecretSettingRegistry(
      [{ name: TOOL_OAUTH_CLIENT_SECRET_SETTING, envOverride: "X_Y", description: "d", consumers: ["someone-else"] }],
      [{ ...INSTANCE_SECRET_SETTING_FAMILIES[0]!, consumers: ["someone-else"] }],
    );
    const t2 = make({}, scoped);
    expect(await failure(t2.lookup("slack"))).toMatchObject({ status: 403 });
  });

  it("never discloses the value in errors or status", async () => {
    const t = make();
    await t.resolver.setRef(PROVIDER_NAME, S_PROVIDER);
    const status = JSON.stringify(await t.resolver.status(PROVIDER_NAME));
    expect(status).not.toContain("provider-ref-value");
    expect(JSON.stringify(await t.resolver.list())).not.toContain("provider-ref-value");
  });
});

describe("tool OAuth registry entries", () => {
  it("derives the provider setting name and env name like the legacy generator", () => {
    expect(toolOauthProviderSecretSettingName("Google-Drive")).toBe("tool-oauth.google_drive.client-secret");
    expect(toolOauthProviderSecretSettingName("---")).toBe("tool-oauth._.client-secret");
    const descriptor = defaultInstanceSecretSettingRegistry.get("tool-oauth.google_drive.client-secret");
    expect(descriptor?.envOverride).toBe("PAPERCLIP_TOOL_OAUTH_GOOGLE_DRIVE_CLIENT_SECRET");
    expect(descriptor?.consumers).toEqual(["tool-access.oauth"]);
  });

  it("rejects names outside the family and registers the instance fallback", () => {
    expect(defaultInstanceSecretSettingRegistry.get("tool-oauth..client-secret")).toBeNull();
    expect(defaultInstanceSecretSettingRegistry.get("tool-oauth.Bad Name.client-secret")).toBeNull();
    expect(defaultInstanceSecretSettingRegistry.get("tool-oauth.x")).toBeNull();
    expect(INSTANCE_SECRET_SETTINGS.map((e) => e.envOverride)).toContain("MYRMIDON_TOOL_OAUTH_CLIENT_SECRET");
    expect(INSTANCE_SECRET_SETTING_FAMILIES).toHaveLength(1);
  });

  it("does not register the non-secret gateway limits or allowed hosts", () => {
    const registered = INSTANCE_SECRET_SETTINGS.map((e) => e.envOverride);
    for (const name of [
      "MYRMIDON_MCP_GATEWAY_TOKEN_REQUEST_LIMIT",
      "MYRMIDON_MCP_GATEWAY_TOKEN_REQUEST_WINDOW_MS",
      "MYRMIDON_TOKEN_BROKER_ALLOWED_HOSTS",
    ]) {
      expect(registered).not.toContain(name);
    }
  });
});
