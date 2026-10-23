// myrmidon(OPE-8836): the installation id lives in the board database, is chosen
// once on the first start and is published for the modules as a file.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, myrmidonInstallIdentity } from "@myrmidon/db";
import { errorHandler } from "../../middleware/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { licensingInstallIdRoutes } from "../licensing-install-id/routes.js";
import { ensureInstallId, hashToInstallId, startInstallId, writeInstallIdFile } from "./install-id.js";

const MACHINE_ID = "0123456789abcdef0123456789abcdef";
const OLD_FORMULA_ID = "myr-3eb1bd439947eb762998"; // sha256(machine id) as the pre-OPE-8836 board computed it

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "install-id-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function machineIdFile(value: string | null, name = "machine-id"): string[] {
  const file = path.join(dir, name);
  if (value === null) return [file]; // a path that does not exist
  writeFileSync(file, value + "\n");
  return [file];
}

describe("instance-id file for the modules", () => {
  it("is written next to the license file, atomically, with mode 0644", () => {
    const licenseDir = path.join(dir, "myrmidon-license");
    mkdirSync(licenseDir);
    const env = { MYR_LICENSE_PATH: path.join(licenseDir, "license.key") };
    expect(writeInstallIdFile(OLD_FORMULA_ID, env)).toBe(true);
    const file = path.join(licenseDir, "instance-id");
    expect(readFileSync(file, "utf8")).toBe(OLD_FORMULA_ID + "\n");
    expect(statSync(file).mode & 0o777).toBe(0o644);
    // overwrites, and leaves no temporary file behind
    expect(writeInstallIdFile("myr-aaaaaaaaaaaaaaaaaaaa", env)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("myr-aaaaaaaaaaaaaaaaaaaa\n");
    const leftovers = readdirSync(licenseDir);
    expect(leftovers.sort()).toEqual(["instance-id"]);
  });

  it("does not fail the start when the directory is not writable", () => {
    const env = { MYR_LICENSE_PATH: path.join(dir, "not-mounted", "license.key") };
    expect(writeInstallIdFile(OLD_FORMULA_ID, env)).toBe(false);
  });

  it("defaults to /etc/myrmidon-license", async () => {
    const { installIdFilePath } = await import("./install-id.js");
    expect(installIdFilePath({})).toBe("/etc/myrmidon-license/instance-id");
  });
});

describeEmbeddedPostgres("installation id in the database", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-install-id-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(myrmidonInstallIdentity);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("the first start with a machine id gives the same id as the old formula", async () => {
    const id = await ensureInstallId(db, { env: {}, machineIdPaths: machineIdFile(MACHINE_ID) });
    expect(id).toEqual({ installId: OLD_FORMULA_ID, source: "machine-id" });
    expect(id.installId).toBe(hashToInstallId(MACHINE_ID));
  });

  it("a restart with a changed machine id keeps the stored id", async () => {
    const first = await ensureInstallId(db, { env: {}, machineIdPaths: machineIdFile(MACHINE_ID) });
    const second = await ensureInstallId(db, { env: {}, machineIdPaths: machineIdFile("ffffffffffffffffffffffffffffffff", "other") });
    expect(second).toEqual(first);
    const gone = await ensureInstallId(db, { env: {}, machineIdPaths: machineIdFile(null, "absent") });
    expect(gone).toEqual(first);
  });

  it("a later MYR_LICENSE_INSTANCE_ID does not change the stored id", async () => {
    const first = await ensureInstallId(db, { env: {}, machineIdPaths: machineIdFile(MACHINE_ID) });
    const later = await ensureInstallId(db, { env: { MYR_LICENSE_INSTANCE_ID: "myr-override" }, machineIdPaths: [] });
    expect(later).toEqual(first);
  });

  it("a start without a machine id generates a myr- id and keeps it", async () => {
    const first = await ensureInstallId(db, { env: {}, machineIdPaths: machineIdFile(null, "absent") });
    expect(first.source).toBe("generated");
    expect(first.installId).toMatch(/^myr-[0-9a-f]{20}$/);
    const second = await ensureInstallId(db, { env: {}, machineIdPaths: machineIdFile(null, "absent") });
    expect(second).toEqual(first);
  });

  it("MYR_LICENSE_INSTANCE_ID at the first start wins over the machine id", async () => {
    const id = await ensureInstallId(db, {
      env: { MYR_LICENSE_INSTANCE_ID: " myr-override " },
      machineIdPaths: machineIdFile(MACHINE_ID),
    });
    expect(id).toEqual({ installId: "myr-override", source: "env" });
    expect((await ensureInstallId(db, { env: {}, machineIdPaths: machineIdFile(MACHINE_ID) })).installId).toBe("myr-override");
  });

  it("boards starting together agree on one id", async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => ensureInstallId(db, { env: {}, machineIdPaths: machineIdFile(null, "absent") })),
    );
    expect(new Set(ids.map((i) => i.installId)).size).toBe(1);
  });

  it("start publishes the stored id as a file in the license directory", async () => {
    const licenseDir = path.join(dir, "myrmidon-license");
    mkdirSync(licenseDir);
    const env = { MYR_LICENSE_PATH: path.join(licenseDir, "license.key"), MYR_LICENSE_INSTANCE_ID: "myr-from-env" };
    const id = await startInstallId(db, env);
    expect(id.installId).toBe("myr-from-env");
    expect(readFileSync(path.join(licenseDir, "instance-id"), "utf8")).toBe("myr-from-env\n");
  });

  it("GET /api/licensing/install-id answers with the stored id", async () => {
    const stored = await ensureInstallId(db, { env: {}, machineIdPaths: machineIdFile(MACHINE_ID) });
    const server = express();
    server.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board", source: "session", userId: "user-1", isInstanceAdmin: true, companyIds: [],
      };
      next();
    });
    server.use("/api", licensingInstallIdRoutes(async () => stored));
    server.use(errorHandler);
    const response = await request(server).get("/api/licensing/install-id").expect(200);
    expect(response.body).toEqual({ install_id: OLD_FORMULA_ID, source: "machine-id" });
  });
});
