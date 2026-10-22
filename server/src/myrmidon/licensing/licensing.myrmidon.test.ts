// myrmidon(LICENSING): install id, license verification, and the guard that
// the board has no license issuing (that is the vendor's closed module).
//
// Neutral data only. Key pairs are generated inside the tests; no real key is
// ever stored in the repository.

import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { computeInitialInstallId, hashToInstallId } from "./install-id.js";
import { verifyLicense } from "./license.js";
import { licensingRoutes } from "./routes.js";

const MACHINE_ID = "0123456789abcdef0123456789abcdef";
const MACHINE_ID_INSTALL_ID = "myr-3eb1bd439947eb762998"; // module-side `instance-id` for MACHINE_ID

let dir: string;
let machineIdFile: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lic-test-"));
  machineIdFile = path.join(dir, "machine-id");
  writeFileSync(machineIdFile, MACHINE_ID + "\n");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("install id: the first-start choice", () => {
  it("matches the module-side algorithm on a reference machine id", () => {
    expect(hashToInstallId(MACHINE_ID)).toBe(MACHINE_ID_INSTALL_ID);
    expect(hashToInstallId(`  ${MACHINE_ID}\n`)).toBe(MACHINE_ID_INSTALL_ID);
    expect(computeInitialInstallId({ env: {}, machineIdPaths: [machineIdFile] })).toEqual({
      installId: MACHINE_ID_INSTALL_ID,
      source: "machine-id",
    });
  });

  it("falls through the machine id paths and honours the env override first", () => {
    expect(
      computeInitialInstallId({ env: {}, machineIdPaths: [path.join(dir, "missing"), machineIdFile] }).installId,
    ).toBe(MACHINE_ID_INSTALL_ID);
    expect(
      computeInitialInstallId({ env: { MYR_LICENSE_INSTANCE_ID: " custom-id " }, machineIdPaths: [machineIdFile] }),
    ).toEqual({ installId: "custom-id", source: "env" });
  });

  it("generates a myr- id from a random UUID when there is no machine id", () => {
    const first = computeInitialInstallId({ env: {}, machineIdPaths: [] });
    const second = computeInitialInstallId({ env: {}, machineIdPaths: [] });
    expect(first.source).toBe("generated");
    expect(first.installId).toMatch(/^myr-[0-9a-f]{20}$/);
    expect(second.installId).not.toBe(first.installId);
  });
});

/** Test-only signer (throwaway keys): the board itself has no signing code. */
function testLicense(
  privateKey: KeyObject,
  p: { instanceId: string; modules: string[]; features: string[]; expires: number | null; watermark: string | null },
): string {
  const sorted = (v: string[]) => [...new Set(v)].sort();
  const bytes = Buffer.from(
    JSON.stringify({
      expires: p.expires,
      features: sorted(p.features),
      instance_id: p.instanceId,
      modules: sorted(p.modules),
      rev: 1,
      watermark: p.watermark,
    }),
    "ascii",
  );
  return `MYR1.${bytes.toString("base64url")}.${edSign(null, bytes, privateKey).toString("base64url")}`;
}

describe("verify", () => {
  it("runs the module-side checks in order", () => {
    const pair = generateKeyPairSync("ed25519");
    const license = testLicense(pair.privateKey, {
      instanceId: MACHINE_ID_INSTALL_ID,
      modules: ["google-ai"],
      features: ["core"],
      expires: 2_000_000_000,
      watermark: "client-1",
    });
    const ok = (over: Record<string, unknown> = {}, id = MACHINE_ID_INSTALL_ID, now = 1_900_000_000) =>
      verifyLicense(license, id, now, pair.publicKey, over as never).reason;
    expect(ok()).toBe("ok");
    expect(ok({ requiredModule: "google-ai" })).toBe("ok");
    expect(ok({ requiredModule: "antigravity" })).toBe("module_not_granted");
    expect(ok({ requiredFeature: "video" })).toBe("feature_not_granted");
    expect(ok({}, "myr-other")).toBe("instance_mismatch");
    expect(ok({}, MACHINE_ID_INSTALL_ID, 2_000_000_001)).toBe("expired");
    expect(verifyLicense(license, MACHINE_ID_INSTALL_ID, 1, generateKeyPairSync("ed25519").publicKey).reason).toBe(
      "bad_signature",
    );
    expect(verifyLicense("nope", MACHINE_ID_INSTALL_ID, 1, pair.publicKey).reason).toBe("bad_format");
    expect(verifyLicense("", MACHINE_ID_INSTALL_ID, 1, pair.publicKey).reason).toBe("no_license");
  });
});

function app(actor: unknown, env: NodeJS.ProcessEnv) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  a.use("/api", licensingRoutes({ env, installId: async () => ({ installId: MACHINE_ID_INSTALL_ID, source: "machine-id" }), now: () => new Date("2026-10-16T08:00:00Z") }));
  a.use(errorHandler);
  return a;
}

const admin = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: true, companyIds: [] };
const member = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: [] };
const agent = { type: "agent", source: "agent_key", agentId: "agent-a" };

describe("licensing routes", () => {
  const envFor = () => ({});

  it("install-id is instance-admin only and equals the module-side value", async () => {
    const res = await request(app(admin, envFor())).get("/api/licensing/install-id");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ installId: MACHINE_ID_INSTALL_ID, source: "machine-id" });
    expect((await request(app(admin, envFor())).get("/api/myrmidon/licensing/install-id")).body.installId).toBe(
      MACHINE_ID_INSTALL_ID,
    );
    for (const actor of [member, agent]) {
      const denied = await request(app(actor, envFor())).get("/api/licensing/install-id");
      expect([401, 403]).toContain(denied.status);
    }
    expect((await request(app(member, envFor())).get("/api/licensing/status")).status).toBe(403);
  });

  it("has no issuing routes, even with an issuer key variable set", async () => {
    const env = { MYRMIDON_LICENSE_ISSUER_KEY_FILE: path.join(dir, "issuer.pem") };
    for (const prefix of ["/api/licensing", "/api/myrmidon/licensing"]) {
      for (const [method, route, body] of [
        ["post", "issue", { instanceId: MACHINE_ID_INSTALL_ID, modules: ["google-ai"], days: 30 }],
        ["post", "parse-request", { request: "MYRQ1.e30" }],
        ["get", "issued", undefined],
      ] as const) {
        const call = method === "get" ? request(app(admin, env)).get(`${prefix}/${route}`) : request(app(admin, env)).post(`${prefix}/${route}`).send(body as object);
        expect((await call).status, `${method} ${prefix}/${route}`).toBe(404);
      }
    }
    const status = await request(app(admin, env)).get("/api/licensing/status");
    expect(status.body).not.toHaveProperty("issuerConfigured");
  });
});

// The board verifies licenses and never signs them: no code outside tests
// loads a private key or calls a signing primitive in the licensing module,
// and nothing in the server knows the issuer key variable.
describe("no issuing code in the board", () => {
  const LICENSING = path.dirname(fileURLToPath(import.meta.url));
  const SERVER_SRC = path.resolve(LICENSING, "..", "..");
  const isTest = (f: string) => /\.test\.tsx?$/.test(f) || f.includes(`${path.sep}__tests__${path.sep}`);
  const walk = (root: string): string[] =>
    readdirSync(root, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(root, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(full);
      return /\.(ts|tsx|js|mjs)$/.test(e.name) && !isTest(full) ? [full] : [];
    });

  it("the licensing module has no private key or signing call", () => {
    const forbidden = /createPrivateKey|createSign\b|generateKeyPair|\bsign\s*\(|BEGIN [A-Z ]*PRIVATE KEY|issueLicense|ISSUER_KEY_FILE/;
    const offenders = walk(LICENSING).filter((f) => forbidden.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no server code reads the issuer key or journal variables", () => {
    const forbidden = /MYRMIDON_LICENSE_ISSUER_KEY_FILE|MYRMIDON_LICENSE_JOURNAL_FILE|loadIssuerKey|licensing\/issuer/;
    const offenders = walk(SERVER_SRC).filter((f) => forbidden.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
