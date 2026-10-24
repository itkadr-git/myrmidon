// myrmidon(SETTINGS-UI E2.1): resolver contract. Pure: the store is an in-memory fake, so the
// suite pins ordering (scope -> env override -> ref), typed errors and non-disclosure.

import { describe, expect, it } from "vitest";
import { HttpError } from "../../errors.js";
import { InstanceSecretSettingRegistry, INSTANCE_SECRET_SETTINGS } from "./registry.js";
import {
  createInstanceSecretSettingResolver,
  type InstanceSecretBinding,
  type InstanceSecretSettingStore,
} from "./resolver.js";

const SECRET_VALUE = "s3cr3t-value-that-must-not-leak";
const ENV_VALUE = "env-break-glass-value";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const SECRET_A = "22222222-2222-4222-8222-222222222222";
const SECRET_B = "33333333-3333-4333-8333-333333333333";

const registry = new InstanceSecretSettingRegistry([
  {
    name: "cloud.google_drive.client_secret",
    envOverride: "TEST_CLOUD_GDRIVE_CLIENT_SECRET",
    description: "Test setting",
    consumers: ["cloud-connector"],
  },
]);
const NAME = "cloud.google_drive.client_secret";

function makeStore() {
  const bindings = new Map<string, InstanceSecretBinding>();
  const secrets = new Map<string, { name: string; status: string; companyId: string; value: string }>([
    [SECRET_A, { name: "gdrive", status: "active", companyId: COMPANY, value: SECRET_VALUE }],
    [SECRET_B, { name: "old", status: "disabled", companyId: COMPANY, value: "x" }],
  ]);
  const resolved: Array<{ settingName: string; consumerId: string }> = [];
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
      resolved.push({ settingName: input.settingName, consumerId: input.consumerId });
      return secret.value;
    },
    async describeSecret(secretId) {
      const secret = secrets.get(secretId);
      return secret ? { name: secret.name, status: secret.status, companyId: secret.companyId } : null;
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
  return { store, bindings, secrets, resolved };
}

function make(env: NodeJS.ProcessEnv = {}) {
  const fake = makeStore();
  const redacted: string[] = [];
  const resolver = createInstanceSecretSettingResolver({
    registry,
    store: fake.store,
    env,
    registerForRedaction: (value) => redacted.push(value),
  });
  return { ...fake, resolver, redacted };
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    const error = err as HttpError;
    return { status: error.status, code: (error.details as { code?: string } | undefined)?.code, message: error.message };
  }
  return null;
}

describe("instance secret setting resolver", () => {
  it("resolves a bound ref server-side and registers the value for masking", async () => {
    const t = make();
    await t.resolver.setRef(NAME, SECRET_A);
    const out = await t.resolver.resolve(NAME, { consumerId: "cloud-connector" });
    expect(out).toEqual({ source: "secret_ref", value: SECRET_VALUE });
    expect(t.resolved).toEqual([{ settingName: NAME, consumerId: "cloud-connector" }]);
    expect(t.redacted).toEqual([SECRET_VALUE]);
  });

  it("denies a consumer outside the setting scope, before touching env or store", async () => {
    const t = make({ TEST_CLOUD_GDRIVE_CLIENT_SECRET: ENV_VALUE });
    await t.resolver.setRef(NAME, SECRET_A);
    const denied = await codeOf(t.resolver.resolve(NAME, { consumerId: "tool-oauth" }));
    expect(denied).toMatchObject({ status: 403, code: "setting_consumer_denied" });
    expect(t.resolved).toHaveLength(0);
    expect(t.redacted).toHaveLength(0);
  });

  it("rejects an unregistered name", async () => {
    const t = make();
    expect(await codeOf(t.resolver.resolve("nope", { consumerId: "cloud-connector" }))).toMatchObject({
      status: 404,
      code: "setting_unknown",
    });
    expect(await codeOf(t.resolver.setRef("nope", SECRET_A))).toMatchObject({ code: "setting_unknown" });
  });

  it("reports a missing ref without falling back to anything", async () => {
    const t = make();
    expect(await codeOf(t.resolver.resolve(NAME, { consumerId: "cloud-connector" }))).toMatchObject({
      status: 422,
      code: "setting_ref_missing",
    });
  });

  it("emergency env override wins over the stored ref", async () => {
    const t = make({ TEST_CLOUD_GDRIVE_CLIENT_SECRET: ` ${ENV_VALUE} ` });
    await t.resolver.setRef(NAME, SECRET_A);
    const out = await t.resolver.resolve(NAME, { consumerId: "cloud-connector" });
    expect(out).toEqual({ source: "env", value: ENV_VALUE });
    expect(t.resolved).toHaveLength(0);
    expect((await t.resolver.status(NAME)).effectiveSource).toBe("env");
  });

  it("an empty env value does not override the ref", async () => {
    const t = make({ TEST_CLOUD_GDRIVE_CLIENT_SECRET: "   " });
    await t.resolver.setRef(NAME, SECRET_A);
    expect((await t.resolver.resolve(NAME, { consumerId: "cloud-connector" })).source).toBe("secret_ref");
  });

  it("revoke: clearing the ref makes the next resolve fail", async () => {
    const t = make();
    await t.resolver.setRef(NAME, SECRET_A);
    await t.resolver.clearRef(NAME);
    expect(await codeOf(t.resolver.resolve(NAME, { consumerId: "cloud-connector" }))).toMatchObject({
      code: "setting_ref_missing",
    });
  });

  it("rotation/disable: a ref whose secret became inactive fails typed, and the ref can be swapped", async () => {
    const t = make();
    await t.resolver.setRef(NAME, SECRET_A);
    t.secrets.get(SECRET_A)!.status = "disabled";
    expect(await codeOf(t.resolver.resolve(NAME, { consumerId: "cloud-connector" }))).toMatchObject({
      code: "secret_inactive",
    });
    t.secrets.set(SECRET_B, { name: "new", status: "active", companyId: COMPANY, value: "rotated" });
    await t.resolver.setRef(NAME, SECRET_B);
    expect((await t.resolver.resolve(NAME, { consumerId: "cloud-connector" })).value).toBe("rotated");
  });

  it("setRef refuses a missing, deleted or inactive secret", async () => {
    const t = make();
    expect(await codeOf(t.resolver.setRef(NAME, "44444444-4444-4444-8444-444444444444"))).toMatchObject({
      code: "secret_missing",
    });
    t.secrets.set("55555555-5555-4555-8555-555555555555", {
      name: "gone",
      status: "deleted",
      companyId: COMPANY,
      value: "x",
    });
    expect(await codeOf(t.resolver.setRef(NAME, "55555555-5555-4555-8555-555555555555"))).toMatchObject({
      code: "secret_missing",
    });
    expect(await codeOf(t.resolver.setRef(NAME, SECRET_B))).toMatchObject({ code: "secret_inactive" });
    expect(t.bindings.size).toBe(0);
  });

  it("never discloses values in status, listing, migration plan or errors", async () => {
    const t = make({ TEST_CLOUD_GDRIVE_CLIENT_SECRET: ENV_VALUE });
    await t.resolver.setRef(NAME, SECRET_A);
    const blob = JSON.stringify([
      await t.resolver.status(NAME),
      await t.resolver.list(),
      await t.resolver.migrationPlan(),
      await codeOf(t.resolver.resolve(NAME, { consumerId: "tool-oauth" })),
    ]);
    expect(blob).not.toContain(SECRET_VALUE);
    expect(blob).not.toContain(ENV_VALUE);
    expect(blob).toContain(NAME);
  });

  it("migration plan is a dry run that reads no store values", async () => {
    const t = make({ TEST_CLOUD_GDRIVE_CLIENT_SECRET: ENV_VALUE });
    expect(await t.resolver.migrationPlan()).toEqual([
      {
        name: NAME,
        envOverride: "TEST_CLOUD_GDRIVE_CLIENT_SECRET",
        envPresent: true,
        refBound: false,
        action: "create_secret_and_bind",
      },
    ]);
    await t.resolver.setRef(NAME, SECRET_A);
    expect((await t.resolver.migrationPlan())[0]).toMatchObject({ refBound: true, action: "unset_env_when_ready" });
    expect(t.resolved).toHaveLength(0);
  });
});

describe("instance secret setting registry", () => {
  it("rejects malformed, duplicate and consumer-less entries", () => {
    const ok = { name: "a.b", envOverride: "A_B", description: "d", consumers: ["c"] };
    expect(() => new InstanceSecretSettingRegistry([{ ...ok, name: "Bad Name" }])).toThrow();
    expect(() => new InstanceSecretSettingRegistry([{ ...ok, envOverride: "lower" }])).toThrow();
    expect(() => new InstanceSecretSettingRegistry([{ ...ok, consumers: [] }])).toThrow();
    expect(() => new InstanceSecretSettingRegistry([ok, ok])).toThrow();
    expect(new InstanceSecretSettingRegistry([ok]).list()).toHaveLength(1);
  });
});

// Bootstrap names cannot be stored in the secret store they open; the E2 matrix records them
// as env-only. This guard fails if a later part registers one as a ref-backed setting.
const BOOTSTRAP_ENV_NAMES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "MYRMIDON_SECRETS_MASTER_KEY",
  "MYRMIDON_SECRETS_MASTER_KEY_FILE",
  "MYRMIDON_SECRETS_PROVIDER",
];

describe("default registry", () => {
  it("never registers a secret-provider bootstrap name", () => {
    for (const entry of INSTANCE_SECRET_SETTINGS) {
      expect(BOOTSTRAP_ENV_NAMES).not.toContain(entry.envOverride);
    }
  });
});
