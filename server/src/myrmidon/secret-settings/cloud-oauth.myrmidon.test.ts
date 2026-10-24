// myrmidon(SETTINGS-UI E2.5): cloud connector OAuth client secrets as scoped refs. Pure:
// in-memory store, injected env and fetch. Pins priority (env > ref), per-provider settings,
// missing / denied / replaced / revoked / unusable refs, masking and non-disclosure, and the
// dispositions of the five E1 seal/sign/JWKS names.

import { describe, expect, it } from "vitest";
import { HttpError } from "../../errors.js";
import { exchangeCode, readOAuthClients, refreshTokenBundle, CLOUD_OAUTH_SPECS } from "../cloud-connector/oauth.js";
import {
  CLOUD_OAUTH_PROVIDERS,
  cloudOauthClientSecretSettingName,
  defaultInstanceSecretSettingRegistry,
  INSTANCE_SECRET_SETTINGS,
  InstanceSecretSettingRegistry,
} from "./registry.js";
import {
  createInstanceSecretSettingResolver,
  type InstanceSecretBinding,
  type InstanceSecretSettingStore,
} from "./resolver.js";
import { createCloudOauthClientSecretLookup } from "./cloud-oauth.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const S_A = "22222222-2222-4222-8222-222222222222";
const S_B = "33333333-3333-4333-8333-333333333333";
const S_OFF = "44444444-4444-4444-8444-444444444444";
const GOOGLE = cloudOauthClientSecretSettingName("google-drive");

function make(env: NodeJS.ProcessEnv = {}, registry = defaultInstanceSecretSettingRegistry) {
  const bindings = new Map<string, InstanceSecretBinding>();
  const secrets = new Map<string, { name: string; status: string; value: string }>([
    [S_A, { name: "a", status: "active", value: "ref-value-a" }],
    [S_B, { name: "b", status: "active", value: "ref-value-b" }],
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
      if (secret.status !== "active") throw new HttpError(422, "Secret is not active", { code: "secret_inactive" });
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
  };
  const resolver = createInstanceSecretSettingResolver({
    registry,
    store,
    env,
    registerForRedaction: (value) => redacted.push(value),
  });
  return { resolver, bindings, redacted, lookup: createCloudOauthClientSecretLookup({ resolver }) };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    const e = err as HttpError;
    return { status: e.status, code: (e.details as { code?: string } | undefined)?.code };
  }
  return null;
}

function fakeFetch(seen: string[]): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    seen.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("cloud OAuth client secret lookup", () => {
  it("registers one setting per provider with its documented emergency env", () => {
    for (const provider of CLOUD_OAUTH_PROVIDERS) {
      const descriptor = defaultInstanceSecretSettingRegistry.get(cloudOauthClientSecretSettingName(provider.id));
      expect(descriptor?.envOverride).toBe(`MYRMIDON_CLOUD_${provider.envSuffix}_CLIENT_SECRET`);
      expect(descriptor?.consumers).toEqual(["cloud-connector.oauth"]);
    }
    expect(CLOUD_OAUTH_PROVIDERS.map((p) => p.id).sort()).toEqual(Object.keys(CLOUD_OAUTH_SPECS).sort());
  });

  it("resolves the bound ref for each of the three providers", async () => {
    const t = make();
    for (const provider of CLOUD_OAUTH_PROVIDERS) {
      expect(await t.lookup(provider.id)).toBeNull(); // missing ref: no client secret
      await t.resolver.setRef(cloudOauthClientSecretSettingName(provider.id), S_A);
      expect(await t.lookup(provider.id)).toBe("ref-value-a");
    }
    expect(t.redacted).toContain("ref-value-a");
  });

  it("emergency env wins over the ref", async () => {
    const t = make({ MYRMIDON_CLOUD_GOOGLE_DRIVE_CLIENT_SECRET: "env-secret" });
    await t.resolver.setRef(GOOGLE, S_A);
    expect(await t.lookup("google-drive")).toBe("env-secret");
    expect(await t.lookup("onedrive")).toBeNull();
  });

  it("replaces and revokes a ref", async () => {
    const t = make();
    await t.resolver.setRef(GOOGLE, S_A);
    await t.resolver.setRef(GOOGLE, S_B);
    expect(await t.lookup("google-drive")).toBe("ref-value-b");
    await t.resolver.clearRef(GOOGLE);
    expect(await t.lookup("google-drive")).toBeNull();
  });

  it("fails typed on a bound but disabled secret", async () => {
    const t = make();
    await t.resolver.setRef(GOOGLE, S_A);
    t.bindings.set(GOOGLE, { companyId: COMPANY, secretId: S_OFF });
    expect(await failure(t.lookup("google-drive"))).toMatchObject({ status: 422, code: "secret_inactive" });
  });

  it("denies other consumers and refuses a ref to a missing secret", async () => {
    const t = make();
    expect(await failure(t.resolver.resolve(GOOGLE, { consumerId: "tool-access.oauth" }))).toMatchObject({
      status: 403,
      code: "setting_consumer_denied",
    });
    expect(
      await failure(t.resolver.setRef(GOOGLE, "55555555-5555-4555-8555-555555555555")),
    ).toMatchObject({ code: "secret_missing" });
    const scoped = new InstanceSecretSettingRegistry([
      { name: GOOGLE, envOverride: "X_Y", description: "d", consumers: ["someone-else"] },
    ]);
    expect(await failure(make({}, scoped).lookup("google-drive"))).toMatchObject({ status: 403 });
  });

  it("treats an unknown provider as no secret and never discloses a value in status", async () => {
    const t = make();
    expect(await t.lookup("dropbox")).toBeNull();
    await t.resolver.setRef(GOOGLE, S_A);
    expect(JSON.stringify(await t.resolver.list())).not.toContain("ref-value-a");
  });
});

describe("token requests use the ref only when the env secret is empty", () => {
  const spec = CLOUD_OAUTH_SPECS["google-drive"];
  const base = { MYRMIDON_CLOUD_GOOGLE_DRIVE_CLIENT_ID: "cid" } as NodeJS.ProcessEnv;

  it("sends the ref secret on code exchange and refresh", async () => {
    const t = make();
    await t.resolver.setRef(GOOGLE, S_A);
    const client = readOAuthClients(base, "https://b.example.com", t.lookup)["google-drive"]!;
    const seen: string[] = [];
    await exchangeCode({ spec, client, code: "c", codeVerifier: "v", fetchImpl: fakeFetch(seen) });
    await refreshTokenBundle({ spec, client, refreshToken: "r", fetchImpl: fakeFetch(seen) });
    expect(seen).toHaveLength(2);
    for (const body of seen) expect(new URLSearchParams(body).get("client_secret")).toBe("ref-value-a");
  });

  it("sends the env secret and does not touch the store when env is set", async () => {
    const t = make();
    await t.resolver.setRef(GOOGLE, S_A);
    let lookups = 0;
    const client = readOAuthClients(
      { ...base, MYRMIDON_CLOUD_GOOGLE_DRIVE_CLIENT_SECRET: "env-secret" },
      "https://b.example.com",
      async (id) => {
        lookups += 1;
        return t.lookup(id);
      },
    )["google-drive"]!;
    const seen: string[] = [];
    await refreshTokenBundle({ spec, client, refreshToken: "r", fetchImpl: fakeFetch(seen) });
    expect(new URLSearchParams(seen[0]).get("client_secret")).toBe("env-secret");
    expect(lookups).toBe(0);
  });

  it("sends no client_secret for a public client without env or ref", async () => {
    const t = make();
    const client = readOAuthClients(base, "https://b.example.com", t.lookup)["google-drive"]!;
    const seen: string[] = [];
    await refreshTokenBundle({ spec, client, refreshToken: "r", fetchImpl: fakeFetch(seen) });
    expect(new URLSearchParams(seen[0]).has("client_secret")).toBe(false);
  });
});

describe("E1 seal / sign / JWKS names stay out of the registry", () => {
  it("does not register bootstrap key material", () => {
    const registered = INSTANCE_SECRET_SETTINGS.map((e) => e.envOverride);
    for (const name of [
      "MYRMIDON_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY",
      "MYRMIDON_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY",
      "MYRMIDON_ID_CONNECTOR_SEAL_PRIVATE_KEY",
      "MYRMIDON_ID_CONNECTOR_SIGN_PRIVATE_KEY",
      "MYRMIDON_CLOUD_RUNTIME_IDENTITY_JWKS",
    ]) {
      expect(registered).not.toContain(name);
    }
  });
});
