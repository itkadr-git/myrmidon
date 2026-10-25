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
  const secrets = new Map<string, { name: string; status: string; companyId: string; value: string; description?: string }>([
    [SECRET_A, { name: "gdrive", status: "active", companyId: COMPANY, value: SECRET_VALUE }],
    [SECRET_B, { name: "old", status: "disabled", companyId: COMPANY, value: "x" }],
  ]);
  const resolved: Array<{ settingName: string; consumerId: string }> = [];
  const created: Array<{ name: string; companyId: string }> = [];
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
    async createSecret(input) {
      if (input.value === "boom") throw new Error(`provider failed for ${input.value}`);
      const id = `66666666-6666-4666-8666-${String(secrets.size).padStart(12, "0")}`;
      secrets.set(id, { name: input.name, status: "active", companyId: input.companyId, value: input.value, description: input.description });
      created.push({ name: input.name, companyId: input.companyId });
      return id;
    },
    async findSecretByName(companyId, name) {
      for (const [id, secret] of secrets) {
        if (secret.companyId === companyId && secret.name === name) return { id, description: secret.description ?? null };
      }
      return null;
    },
    async deleteSecret(secretId) {
      secrets.delete(secretId);
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
  return { store, bindings, secrets, resolved, created };
}

async function make(env: NodeJS.ProcessEnv = {}) {
  const t = makeStore();
  const redacted: string[] = [];
  const resolver = createInstanceSecretSettingResolver({
    registry,
    store: t.store,
    env,
    registerForRedaction: (value) => redacted.push(value),
  });
  return { ...t, resolver, redacted };
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
    const t = await make();
    await t.resolver.setRef(NAME, SECRET_A);
    const out = await t.resolver.resolve(NAME, { consumerId: "cloud-connector" });
    expect(out).toEqual({ source: "secret_ref", value: SECRET_VALUE });
    expect(t.resolved).toEqual([{ settingName: NAME, consumerId: "cloud-connector" }]);
    expect(t.redacted).toEqual([SECRET_VALUE]);
  });

  it("denies a consumer outside the setting scope, before touching env or store", async () => {
    const t = await make({ TEST_CLOUD_GDRIVE_CLIENT_SECRET: ENV_VALUE });
    await t.resolver.setRef(NAME, SECRET_A);
    const denied = await codeOf(t.resolver.resolve(NAME, { consumerId: "tool-oauth" }));
    expect(denied).toMatchObject({ status: 403, code: "setting_consumer_denied" });
    expect(t.resolved).toHaveLength(0);
    expect(t.redacted).toHaveLength(0);
  });

  it("rejects an unregistered name", async () => {
    const t = await make();
    expect(await codeOf(t.resolver.resolve("nope", { consumerId: "cloud-connector" }))).toMatchObject({
      status: 404,
      code: "setting_unknown",
    });
    expect(await codeOf(t.resolver.setRef("nope", SECRET_A))).toMatchObject({ code: "setting_unknown" });
  });

  it("reports a missing ref without falling back to anything", async () => {
    const t = await make();
    expect(await codeOf(t.resolver.resolve(NAME, { consumerId: "cloud-connector" }))).toMatchObject({
      status: 422,
      code: "setting_ref_missing",
    });
  });

  it("emergency env override wins over the stored ref", async () => {
    const t = await make({ TEST_CLOUD_GDRIVE_CLIENT_SECRET: ` ${ENV_VALUE} ` });
    await t.resolver.setRef(NAME, SECRET_A);
    const out = await t.resolver.resolve(NAME, { consumerId: "cloud-connector" });
    expect(out).toEqual({ source: "env", value: ENV_VALUE });
    expect(t.resolved).toHaveLength(0);
    expect((await t.resolver.status(NAME)).effectiveSource).toBe("env");
  });

  it("an empty env value does not override the ref", async () => {
    const t = await make({ TEST_CLOUD_GDRIVE_CLIENT_SECRET: "   " });
    await t.resolver.setRef(NAME, SECRET_A);
    expect((await t.resolver.resolve(NAME, { consumerId: "cloud-connector" })).source).toBe("secret_ref");
  });

  it("revoke: clearing the ref makes the next resolve fail", async () => {
    const t = await make();
    await t.resolver.setRef(NAME, SECRET_A);
    await t.resolver.clearRef(NAME);
    expect(await codeOf(t.resolver.resolve(NAME, { consumerId: "cloud-connector" }))).toMatchObject({
      code: "setting_ref_missing",
    });
  });

  it("rotation/disable: a ref whose secret became inactive fails typed, and the ref can be swapped", async () => {
    const t = await make();
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
    const t = await make();
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
    const t = await make({ TEST_CLOUD_GDRIVE_CLIENT_SECRET: ENV_VALUE });
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
    const t = await make({ TEST_CLOUD_GDRIVE_CLIENT_SECRET: ENV_VALUE });
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

describe("migration", () => {
  const ENV = { TEST_CLOUD_GDRIVE_CLIENT_SECRET: ENV_VALUE };

  it("is a dry run by default: nothing is created or bound, no value is shown", async () => {
    const t = await make(ENV);
    const out = await t.resolver.migrate({});
    expect(out.dryRun).toBe(true);
    expect(out.rows).toEqual([
      { name: NAME, envOverride: "TEST_CLOUD_GDRIVE_CLIENT_SECRET", outcome: "planned" },
    ]);
    expect(t.created).toHaveLength(0);
    expect(t.bindings.size).toBe(0);
    expect(JSON.stringify(out)).not.toContain(ENV_VALUE);
  });

  it("only exactly apply:true writes, and it needs a company", async () => {
    const t = await make(ENV);
    expect((await t.resolver.migrate({ apply: undefined, companyId: COMPANY })).dryRun).toBe(true);
    expect(await codeOf(t.resolver.migrate({ apply: true }))).toMatchObject({ code: "migration_company_required" });
    expect(t.created).toHaveLength(0);
  });

  it("apply creates the secret, binds it, leaves env alone and never echoes the value", async () => {
    const t = await make(ENV);
    const out = await t.resolver.migrate({ apply: true, companyId: COMPANY });
    expect(out.dryRun).toBe(false);
    expect(out.rows[0]).toMatchObject({ name: NAME, outcome: "bound" });
    expect(t.created).toEqual([{ name: `instance-setting.${NAME}`, companyId: COMPANY }]);
    expect(t.bindings.get(NAME)?.secretId).toBe(out.rows[0]!.secretId);
    expect(JSON.stringify(out)).not.toContain(ENV_VALUE);
    expect(ENV.TEST_CLOUD_GDRIVE_CLIENT_SECRET).toBe(ENV_VALUE);
    // Second apply is idempotent: the ref exists, nothing more is created.
    const again = await t.resolver.migrate({ apply: true, companyId: COMPANY });
    expect(again.rows[0]!.outcome).toBe("skipped");
    expect(t.created).toHaveLength(1);
  });

  it("a failing provider is reported as a row error without the value and later rows still run", async () => {
    const localRegistry = new InstanceSecretSettingRegistry([
      { name: "cloud.first", envOverride: "FIRST", description: "First", consumers: ["cloud-connector"] },
      { name: "cloud.second", envOverride: "SECOND", description: "Second", consumers: ["cloud-connector"] },
      { name: "cloud.third", envOverride: "THIRD", description: "Third", consumers: ["cloud-connector"] },
    ]);
    const env = { FIRST: "first-value", SECOND: "boom", THIRD: "third-value" };
    const fake = makeStore();
    let count = 0;
    const originalCreate = fake.store.createSecret.bind(fake.store);
    fake.store.createSecret = async (input) => {
      count += 1;
      if (input.value === "boom") throw new Error(`provider failed for ${input.value}`);
      return originalCreate(input);
    };
    const resolver = createInstanceSecretSettingResolver({ registry: localRegistry, store: fake.store, env });
    const out = await resolver.migrate({ apply: true, companyId: COMPANY });
    expect(out.rows.map((row) => row.outcome)).toEqual(["bound", "error", "bound"]);
    expect(out.rows[1]).toMatchObject({ errorCode: "migration_failed" });
    expect(fake.bindings.has("cloud.first")).toBe(true);
    expect(fake.bindings.has("cloud.second")).toBe(false);
    expect(fake.bindings.has("cloud.third")).toBe(true);
    expect(JSON.stringify(out)).not.toContain("first-value");
    expect(JSON.stringify(out)).not.toContain("boom");
    expect(count).toBe(3);
  });

  it("rolls back a row whose audit fails: binding cleared, new secret deleted", async () => {
    const t = await make(ENV);
    const out = await t.resolver.migrate({
      apply: true,
      companyId: COMPANY,
      onBound: async () => {
        throw new Error("audit down");
      },
    });
    expect(out.rows[0]).toMatchObject({ outcome: "error", errorCode: "migration_failed" });
    expect(t.bindings.has(NAME)).toBe(false);
    expect([...t.secrets.values()].map((secret) => secret.name)).not.toContain(`instance-setting.${NAME}`);
  });

  it("reuses the deterministic secret after a binding is cleared", async () => {
    const t = await make(ENV);
    const first = await t.resolver.migrate({ apply: true, companyId: COMPANY });
    await t.resolver.clearRef(NAME);
    const again = await t.resolver.migrate({ apply: true, companyId: COMPANY });
    expect(again.rows[0]).toMatchObject({ outcome: "bound", secretId: first.rows[0]!.secretId });
    expect(t.created).toHaveLength(1);
  });

  it("a failing provider is reported without the value", async () => {
    const t = await make({ TEST_CLOUD_GDRIVE_CLIENT_SECRET: "boom" });
    const out = await t.resolver.migrate({ apply: true, companyId: COMPANY });
    expect(out.rows[0]).toMatchObject({ outcome: "error", errorCode: "migration_failed" });
    expect(JSON.stringify(out)).not.toContain("boom");
    expect(t.bindings.size).toBe(0);
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
