// myrmidon(SETTINGS-UI E2.1): routes and DB store against the real secrets service
// (embedded Postgres, local encrypted provider, no mocks). Pins: a non-admin gets
// 403 everywhere, an instance admin gets 200, the dry run never returns a value, a
// ref set / swapped / revoked through the routes changes what the resolver returns.

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { companies, companySecrets, companySecretBindings, activityLog, createDb, type Db } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { secretService } from "../../services/secrets.js";
import { InstanceSecretSettingRegistry } from "./registry.js";
import { instanceSecretSettingsRoutes } from "./routes.js";
import { createInstanceSecretSettingService } from "./wiring.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NAME = "test.connector.client_secret";
const ENV_NAME = "TEST_CONNECTOR_CLIENT_SECRET";
const SECRET_VALUE = "real-secret-value-0a1b2c3d";
const OTHER_VALUE = "rotated-secret-value-9z8y7x";
const ENV_VALUE = "env-migration-value-5k4j3h";
const CONSUMER = "test-consumer";

describeEmbeddedPostgres("instance secret settings: routes and store on the real secrets service", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const keyDir = path.join(os.tmpdir(), `paperclip-secret-settings-${randomUUID()}`);
  const env: NodeJS.ProcessEnv = {};
  const registry = new InstanceSecretSettingRegistry([
    { name: NAME, envOverride: ENV_NAME, description: "Test setting", consumers: [CONSUMER] },
  ]);
  let companyId!: string;
  let firstSecretId!: string;
  let secondSecretId!: string;

  function appFor(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor as never;
      next();
    });
    app.use("/api", instanceSecretSettingsRoutes(db, registry, env));
    app.use(errorHandler);
    return app;
  }
  const admin = () =>
    appFor({ type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true, companyIds: [], memberships: [] });
  const member = () =>
    appFor({ type: "board", userId: "member-1", source: "session", isInstanceAdmin: false, companyIds: [], memberships: [] });
  const resolver = () => createInstanceSecretSettingService(db, registry, env);

  beforeAll(async () => {
    mkdirSync(keyDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(keyDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-secret-settings-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Settings Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    });
    const secrets = secretService(db);
    firstSecretId = (
      await secrets.create(companyId, { name: `first-${randomUUID()}`, provider: "local_encrypted", value: SECRET_VALUE })
    ).id;
    secondSecretId = (
      await secrets.create(companyId, { name: `second-${randomUUID()}`, provider: "local_encrypted", value: OTHER_VALUE })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(keyDir, { recursive: true, force: true });
  });

  it("a non-admin board user gets 403 on every route", async () => {
    const app = member();
    expect((await request(app).get("/api/instance/secret-settings")).status).toBe(403);
    expect((await request(app).get("/api/instance/secret-settings/migration-plan")).status).toBe(403);
    expect(
      (await request(app).put(`/api/instance/secret-settings/${NAME}/ref`).send({ secretId: firstSecretId })).status,
    ).toBe(403);
    expect((await request(app).delete(`/api/instance/secret-settings/${NAME}/ref`)).status).toBe(403);
    expect((await request(app).post("/api/instance/secret-settings/migrate").send({})).status).toBe(403);
    // And nothing was bound by the refused PUT.
    expect((await resolver().status(NAME)).ref).toBeNull();
  });

  it("an instance admin lists the setting with no value in the body", async () => {
    const res = await request(admin()).get("/api/instance/secret-settings");
    expect(res.status).toBe(200);
    expect(res.body.settings).toHaveLength(1);
    expect(res.body.settings[0]).toMatchObject({ name: NAME, envOverride: ENV_NAME, effectiveSource: "unset", ref: null });
    expect(JSON.stringify(res.body)).not.toContain(SECRET_VALUE);
  });

  it("set, swap and revoke a ref through the routes changes what the resolver returns", async () => {
    const app = admin();
    await expect(resolver().resolve(NAME, { consumerId: CONSUMER })).rejects.toMatchObject({
      details: { code: "setting_ref_missing" },
    });

    const set = await request(app).put(`/api/instance/secret-settings/${NAME}/ref`).send({ secretId: firstSecretId });
    expect(set.status).toBe(200);
    expect(set.body.ref.secretId).toBe(firstSecretId);
    expect(JSON.stringify(set.body)).not.toContain(SECRET_VALUE);
    expect(await resolver().resolve(NAME, { consumerId: CONSUMER })).toEqual({ source: "secret_ref", value: SECRET_VALUE });

    const swap = await request(app).put(`/api/instance/secret-settings/${NAME}/ref`).send({ secretId: secondSecretId });
    expect(swap.status).toBe(200);
    expect((await resolver().resolve(NAME, { consumerId: CONSUMER })).value).toBe(OTHER_VALUE);

    const revoked = await request(app).delete(`/api/instance/secret-settings/${NAME}/ref`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.ref).toBeNull();
    await expect(resolver().resolve(NAME, { consumerId: CONSUMER })).rejects.toMatchObject({
      details: { code: "setting_ref_missing" },
    });
  });

  it("refuses a consumer outside the scope even with a valid ref, and an unknown secret", async () => {
    const app = admin();
    await request(app).put(`/api/instance/secret-settings/${NAME}/ref`).send({ secretId: firstSecretId });
    await expect(resolver().resolve(NAME, { consumerId: "someone-else" })).rejects.toMatchObject({ status: 403 });
    const missing = await request(app)
      .put(`/api/instance/secret-settings/${NAME}/ref`)
      .send({ secretId: randomUUID() });
    expect(missing.status).toBe(422);
    await request(app).delete(`/api/instance/secret-settings/${NAME}/ref`);
  });

  it("the emergency env override wins over a bound ref", async () => {
    const app = admin();
    await request(app).put(`/api/instance/secret-settings/${NAME}/ref`).send({ secretId: firstSecretId });
    env[ENV_NAME] = "break-glass-value";
    try {
      expect(await resolver().resolve(NAME, { consumerId: CONSUMER })).toEqual({ source: "env", value: "break-glass-value" });
    } finally {
      delete env[ENV_NAME];
      await request(app).delete(`/api/instance/secret-settings/${NAME}/ref`);
    }
  });

  it("migrate reports a failed second row but keeps earlier successful audit and leaves no orphan", async () => {
    const first = registry.get(NAME)!;
    const second = { ...first, name: "test.cloud.second", envOverride: "TEST_CLOUD_SECOND_SECRET" };
    const third = { ...first, name: "test.cloud.third", envOverride: "TEST_CLOUD_THIRD_SECRET" };
    const localRegistry = new InstanceSecretSettingRegistry([first, second, third]);
    const previousEnv = new Map([ENV_NAME, second.envOverride, third.envOverride].map((key) => [key, process.env[key]]));
    env[ENV_NAME] = ENV_VALUE;
    env[second.envOverride] = "second-value";
    env[third.envOverride] = "third-value";
    const svc = createInstanceSecretSettingService(db, localRegistry, env);
    const audited: string[] = [];
    try {
      const rows = await svc.migrate({
        apply: true,
        companyId,
        onBound: async (name) => {
          audited.push(name);
          if (name === second.name) throw new Error("audit failure");
        },
      });
      expect(JSON.stringify(rows)).not.toContain("second-value");
      expect([...audited].sort()).toEqual([first.name, second.name, third.name].sort());
      expect(rows.rows.map((row) => [row.name, row.outcome]).sort()).toEqual(
        [[first.name, "bound"], [second.name, "error"], [third.name, "bound"]].sort(),
      );
      expect(rows.rows.find((row) => row.name === second.name)).toMatchObject({ errorCode: "migration_failed" });
      expect((await svc.status(second.name)).ref).toBeNull();
            expect((await svc.status(first.name)).ref).not.toBeNull();
      expect((await svc.status(third.name)).ref).not.toBeNull();
      const names = await db.select({ name: companySecrets.name }).from(companySecrets);
      expect(names.map((row) => row.name)).not.toContain("instance-setting.test.cloud.second");
    } finally {
      await svc.clearRef(first.name);
      await svc.clearRef(third.name);
      await db.delete(companySecrets).where(like(companySecrets.name, "instance-setting.%"));
      for (const key of [ENV_NAME, second.envOverride, third.envOverride]) {
        const value = previousEnv.get(key);
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
    }
  });

  it("a foreign secret holding the migration name is a row error and is left untouched", async () => {
    const foreignId = (
      await secretService(db).create(companyId, {
        name: `instance-setting.${NAME}`,
        provider: "local_encrypted",
        value: "foreign-value-77",
        description: "someone else's",
      })
    ).id;
    env[ENV_NAME] = ENV_VALUE;
    try {
      const out = await resolver().migrate({ apply: true, companyId });
      expect(out.rows[0]).toMatchObject({ outcome: "error", errorCode: "migration_secret_name_conflict" });
      expect(JSON.stringify(out)).not.toContain("foreign-value-77");
      expect((await resolver().status(NAME)).ref).toBeNull();
      const still = await db.select({ id: companySecrets.id }).from(companySecrets).where(eq(companySecrets.id, foreignId));
      expect(still).toHaveLength(1);
    } finally {
      delete env[ENV_NAME];
      await db.delete(companySecrets).where(eq(companySecrets.id, foreignId));
    }
  });

  it("apply creates the secret, binds it, audits each successful row and leaves env alone", async () => {
    const app = admin();
    env[ENV_NAME] = ENV_VALUE;
    try {
      const dry = await request(app).post("/api/instance/secret-settings/migrate").send({});
      expect(dry.status).toBe(200);
      expect(dry.body.dryRun).toBe(true);
      expect(dry.body.rows[0]).toMatchObject({ name: NAME, outcome: "planned" });
      expect(JSON.stringify(dry.body)).not.toContain(ENV_VALUE);
      expect((await resolver().status(NAME)).ref).toBeNull();

      const plan = await request(app).get("/api/instance/secret-settings/migration-plan");
      expect(plan.status).toBe(200);
      expect(JSON.stringify(plan.body)).not.toContain(ENV_VALUE);

      const noCompany = await request(app).post("/api/instance/secret-settings/migrate").send({ apply: true });
      expect(noCompany.status).toBe(422);

      const applied = await request(app).post("/api/instance/secret-settings/migrate").send({ apply: true, companyId });
      expect(applied.status).toBe(200);
      expect(applied.body.dryRun).toBe(false);
      expect(applied.body.rows[0].outcome).toBe("bound");
      expect(JSON.stringify(applied.body)).not.toContain(ENV_VALUE);

      // With env removed, the migrated ref resolves to the original value.
      delete env[ENV_NAME];
      expect((await resolver().resolve(NAME, { consumerId: CONSUMER })).value).toBe(ENV_VALUE);

      const migratedSecretId = applied.body.rows[0].secretId as string;
      await request(app).delete(`/api/instance/secret-settings/${NAME}/ref`);
      env[ENV_NAME] = ENV_VALUE;
      const reapplied = await request(app).post("/api/instance/secret-settings/migrate").send({ apply: true, companyId });
      expect(reapplied.status).toBe(200);
      expect(reapplied.body.rows[0]).toMatchObject({ outcome: "bound", secretId: migratedSecretId });
      expect(JSON.stringify(reapplied.body)).not.toContain(ENV_VALUE);
      const duplicateNames = await db.select({ id: companySecrets.id }).from(companySecrets).where(eq(companySecrets.name, `instance-setting.${NAME}`));
      expect(duplicateNames).toHaveLength(1);
    } finally {
      delete env[ENV_NAME];
    }
  });
});
