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
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { companies, companySecrets, companySecretBindings, activityLog, createDb, toolApplications, toolConnections, type Db } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { secretService } from "../../services/secrets.js";
import { INSTANCE_SECRET_SETTING_FAMILIES, InstanceSecretSettingRegistry } from "./registry.js";
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
  const registry = new InstanceSecretSettingRegistry(
    [{ name: NAME, envOverride: ENV_NAME, description: "Test setting", consumers: [CONSUMER] }],
    INSTANCE_SECRET_SETTING_FAMILIES,
  );
  let companyId!: string;
  let firstSecretId!: string;
  let secondSecretId!: string;

  function appFor(actor: Record<string, unknown>, routeRegistry = registry) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor as never;
      next();
    });
    app.use("/api", instanceSecretSettingsRoutes(db, routeRegistry, env));
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

  it("lists an OAuth provider discovered from a connected tool application without values", async () => {
    const application = await db.insert(toolApplications).values({
      companyId,
      name: `Acme OAuth ${randomUUID()}`,
      applicationKey: `acme_oauth_${randomUUID().replace(/-/g, "")}`,
      type: "mcp_http",
      status: "active",
    }).returning().then((rows) => rows[0]!);
    const provider = String(application.applicationKey);
    await db.insert(toolConnections).values({
      companyId,
      applicationId: application.id,
      name: "Acme connection",
      uid: `acme-${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "oauth",
      status: "active",
      enabled: true,
      config: { oauth: { provider } },
    });
    await db.insert(toolConnections).values({
      companyId,
      applicationId: application.id,
      name: "Host-derived connection",
      uid: `host-${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "oauth",
      status: "active",
      enabled: true,
      config: { url: "https://mcp.Example-Host.io/v1" },
    });
    await db.insert(toolConnections).values({
      companyId,
      applicationId: application.id,
      name: "Metadata-derived connection",
      uid: `meta-${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "oauth",
      status: "active",
      enabled: true,
      config: { url: "https://mcp.endpoint-host.io/v1", oauth: { metadataUrl: "https://auth.meta-host.io/.well-known/oauth-authorization-server" } },
    });
    const response = await request(admin()).get("/api/instance/secret-settings");
    expect(response.status).toBe(200);
    const listed = response.body.settings.map((row: { name: string }) => row.name);
    expect(listed).toContain(`tool-oauth.${provider}.client-secret`);
    expect(listed).toContain("tool-oauth.mcp_example_host_io.client-secret");
    // Same name the sign-in uses: it prefers the persisted metadata URL over the endpoint host.
    expect(listed).toContain("tool-oauth.auth_meta_host_io.client-secret");
    expect(listed).not.toContain("tool-oauth.mcp_endpoint_host_io.client-secret");
    expect(JSON.stringify(response.body)).not.toContain(SECRET_VALUE);
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

  it("HTTP apply persists real audits before rolling back a failed second row", async () => {
    const first = registry.get(NAME)!;
    const second = { ...first, name: "test.cloud.second", envOverride: "TEST_CLOUD_SECOND_SECRET" };
    const third = { ...first, name: "test.cloud.third", envOverride: "TEST_CLOUD_THIRD_SECRET" };
    const localRegistry = new InstanceSecretSettingRegistry([first, second, third]);
    const previousEnv = new Map([ENV_NAME, second.envOverride, third.envOverride].map((key) => [key, process.env[key]]));
    env[ENV_NAME] = ENV_VALUE;
    env[second.envOverride] = "second-value";
    env[third.envOverride] = "third-value";

    // Fail only the second real audit insert, after the first row was committed.
    await db.execute(sql`CREATE FUNCTION reject_second_migration_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'instance.secret_setting.migrated'
           AND NEW.entity_type = 'instance_secret_setting'
           AND NEW.entity_id = 'test.cloud.second' THEN
          RAISE EXCEPTION 'injected audit insert failure';
        END IF;
        RETURN NEW;
      END
    $$`);
    await db.execute(sql`CREATE TRIGGER reject_second_migration_audit BEFORE INSERT ON activity_log
      FOR EACH ROW EXECUTE FUNCTION reject_second_migration_audit()`);

    try {
      const response = await request(appFor({
        type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true, companyIds: [], memberships: [],
      }, localRegistry)).post("/api/instance/secret-settings/migrate").send({ apply: true, companyId });

      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain("second-value");
      expect(response.body.rows.map((row: { name: string; outcome: string }) => [row.name, row.outcome]).sort()).toEqual(
        [[first.name, "bound"], [second.name, "error"], [third.name, "bound"]].sort(),
      );
      expect(response.body.rows.find((row: { name: string }) => row.name === second.name)).toMatchObject({ errorCode: "migration_failed" });

      const audits = await db.select({ entityId: activityLog.entityId, action: activityLog.action, details: activityLog.details })
        .from(activityLog).where(eq(activityLog.action, "instance.secret_setting.migrated"));
      expect(audits.map((row) => row.entityId).sort()).toEqual([first.name, third.name].sort());
      expect(audits.every((row) => Object.hasOwn(row.details ?? {}, "settingName") && Object.hasOwn(row.details ?? {}, "secretId"))).toBe(true);
      const svc = createInstanceSecretSettingService(db, localRegistry, env);
      expect((await svc.status(first.name)).ref).not.toBeNull();
      expect((await svc.status(second.name)).ref).toBeNull();
      expect((await svc.status(third.name)).ref).not.toBeNull();
      const names = await db.select({ name: companySecrets.name }).from(companySecrets);
      expect(names.map((row) => row.name)).not.toContain("instance-setting.test.cloud.second");
    } finally {
      await db.execute(sql`DROP TRIGGER reject_second_migration_audit ON activity_log`);
      await db.execute(sql`DROP FUNCTION reject_second_migration_audit()`);
      const svc = createInstanceSecretSettingService(db, localRegistry, env);
      await svc.clearRef(first.name);
      await svc.clearRef(third.name);
      await db.delete(activityLog).where(and(
        eq(activityLog.action, "instance.secret_setting.migrated"),
        inArray(activityLog.entityId, [first.name, second.name, third.name]),
      ));
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
