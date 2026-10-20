// myrmidon(LICENSING): install id, license format, issue route.
//
// Neutral data only. Key pairs are generated inside the tests; no real key is
// ever stored in the repository. The golden strings below were produced by the
// module-side canonical serializer (Python json.dumps with sort_keys, tight
// separators and ensure_ascii) so the board and the modules stay byte-equal.

import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { hashToInstallId, resolveInstallId } from "./install-id.js";
import {
  buildLicenseRequest,
  canonicalPayload,
  issueLicense,
  parseLicenseRequest,
  verifyLicense,
} from "./license.js";
import { licensingRoutes } from "./routes.js";

const MACHINE_ID = "0123456789abcdef0123456789abcdef";
const MACHINE_ID_INSTALL_ID = "myr-3eb1bd439947eb762998"; // module-side `instance-id` for MACHINE_ID

let dir: string;
let machineIdFile: string;
let keyFile: string;
let journalFile: string;
let publicKey: KeyObject;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lic-test-"));
  machineIdFile = path.join(dir, "machine-id");
  writeFileSync(machineIdFile, MACHINE_ID + "\n");
  keyFile = path.join(dir, "issuer.pem");
  journalFile = path.join(dir, "issued.jsonl");
  const pair = generateKeyPairSync("ed25519");
  publicKey = pair.publicKey;
  writeFileSync(keyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("install id", () => {
  it("matches the module-side algorithm on a reference machine id", () => {
    expect(hashToInstallId(MACHINE_ID)).toBe(MACHINE_ID_INSTALL_ID);
    expect(hashToInstallId(`  ${MACHINE_ID}\n`)).toBe(MACHINE_ID_INSTALL_ID);
    expect(resolveInstallId({ env: {}, machineIdPaths: [machineIdFile] })).toEqual({
      installId: MACHINE_ID_INSTALL_ID,
      source: "machine-id",
    });
  });

  it("falls through the machine id paths and honours the env override", () => {
    expect(resolveInstallId({ env: {}, machineIdPaths: [path.join(dir, "missing"), machineIdFile] }).installId).toBe(
      MACHINE_ID_INSTALL_ID,
    );
    expect(
      resolveInstallId({ env: { MYR_LICENSE_INSTANCE_ID: " custom-id " }, machineIdPaths: [machineIdFile] }),
    ).toEqual({ installId: "custom-id", source: "env" });
  });

  it("generates a stable cached id when no machine id exists", () => {
    const env = { MYR_LICENSE_STATE_DIR: path.join(dir, "state") };
    const first = resolveInstallId({ env, machineIdPaths: [] });
    const second = resolveInstallId({ env, machineIdPaths: [] });
    expect(first.source).toBe("generated");
    expect(first.installId).toMatch(/^myr-[0-9a-f]{20}$/);
    expect(second.installId).toBe(first.installId);
  });
});

describe("canonical payload", () => {
  it("is byte-equal to the module-side serializer", () => {
    expect(
      canonicalPayload({
        instanceId: "myr-0123456789abcdef0123",
        modules: ["google-ai", "antigravity", "google-ai"],
        features: ["core"],
        expires: 1799999999,
        watermark: "client-1",
      }).toString("ascii"),
    ).toBe(
      '{"expires":1799999999,"features":["core"],"instance_id":"myr-0123456789abcdef0123","modules":["antigravity","google-ai"],"rev":1,"watermark":"client-1"}',
    );
    expect(
      canonicalPayload({
        instanceId: "myr-0123456789abcdef0123",
        modules: ["chatgpt-pool"],
        features: ["video", "core"],
        expires: null,
        watermark: null,
      }).toString("ascii"),
    ).toBe(
      '{"expires":null,"features":["core","video"],"instance_id":"myr-0123456789abcdef0123","modules":["chatgpt-pool"],"rev":1,"watermark":null}',
    );
  });

  it("escapes non-ASCII like ensure_ascii=True", () => {
    expect(
      canonicalPayload({
        instanceId: "myr-0123456789abcdef0123",
        modules: ["google-ai"],
        features: ["core"],
        expires: null,
        watermark: 'Клиент "Ёж" 😀 \\ \u0007',
      }).toString("ascii"),
    ).toBe(
      '{"expires":null,"features":["core"],"instance_id":"myr-0123456789abcdef0123","modules":["google-ai"],"rev":1,"watermark":"\\u041a\\u043b\\u0438\\u0435\\u043d\\u0442 \\"\\u0401\\u0436\\" \\ud83d\\ude00 \\\\ \\u0007"}',
    );
  });
});

describe("issue and verify", () => {
  it("a license issued with a test key passes the module-side checks in order", () => {
    const pair = generateKeyPairSync("ed25519");
    const { license } = issueLicense(pair.privateKey, {
      instanceId: MACHINE_ID_INSTALL_ID,
      modules: ["google-ai"],
      features: ["core"],
      expires: 2_000_000_000,
      watermark: "client-1",
    });
    expect(license).toMatch(/^MYR1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
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

  it("the signature covers the raw payload bytes", () => {
    const pair = generateKeyPairSync("ed25519");
    const input = {
      instanceId: "myr-0123456789abcdef0123",
      modules: ["google-ai"],
      features: ["core"],
      expires: null,
      watermark: null,
    };
    const { license } = issueLicense(pair.privateKey, input);
    const sig = Buffer.from(license.split(".")[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
    // Ed25519 is deterministic: signing the canonical bytes directly gives the same signature.
    expect(edSign(null, canonicalPayload(input), pair.privateKey).equals(sig)).toBe(true);
  });
});

describe("license request MYRQ1", () => {
  it("round-trips and rejects anything else", () => {
    const blob = buildLicenseRequest({
      instanceId: MACHINE_ID_INSTALL_ID,
      board: "1.6.6",
      modules: ["google-ai", "antigravity"],
      now: new Date("2026-10-16T08:00:00Z"),
    });
    expect(blob).toMatch(/^MYRQ1\.[A-Za-z0-9_-]+$/);
    expect(parseLicenseRequest(`  ${blob}\n`)).toEqual({
      v: 1,
      instance_id: MACHINE_ID_INSTALL_ID,
      board: "1.6.6",
      modules: ["antigravity", "google-ai"],
      ts: "2026-10-16T08:00:00Z",
    });
    for (const bad of ["", "MYRQ1.", "MYRQ1.!!!", "MYRQ2.abc", "hello", 42, null, `MYRQ1.${Buffer.from("{}").toString("base64url")}`]) {
      expect(parseLicenseRequest(bad)).toBeNull();
    }
    const badId = `MYRQ1.${Buffer.from(JSON.stringify({ v: 1, instance_id: "x y", modules: [] })).toString("base64url")}`;
    expect(parseLicenseRequest(badId)).toBeNull();
  });
});

function app(actor: unknown, env: NodeJS.ProcessEnv) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  a.use("/api", licensingRoutes({ env, machineIdPaths: [machineIdFile], now: () => new Date("2026-10-16T08:00:00Z") }));
  a.use(errorHandler);
  return a;
}

const admin = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: true, companyIds: [] };
const member = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: [] };
const agent = { type: "agent", source: "agent_key", agentId: "agent-a" };

describe("licensing routes", () => {
  const envFor = () => ({ MYRMIDON_LICENSE_ISSUER_KEY_FILE: keyFile, MYRMIDON_LICENSE_JOURNAL_FILE: journalFile });

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
    for (const route of ["status", "issued"]) {
      expect((await request(app(member, envFor())).get(`/api/licensing/${route}`)).status).toBe(403);
    }
    expect(
      (await request(app(member, envFor())).post("/api/licensing/issue").send({ modules: ["google-ai"], days: 30 }))
        .status,
    ).toBe(403);
  });

  it("status carries a request blob the issue form accepts", async () => {
    const status = await request(app(admin, envFor())).get("/api/licensing/status?modules=google-ai,bogus");
    expect(status.body.issuerConfigured).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain("PRIVATE");
    const parsed = await request(app(admin, envFor())).post("/api/licensing/parse-request").send({ request: status.body.request });
    expect(parsed.status).toBe(200);
    expect(parsed.body).toMatchObject({ instanceId: MACHINE_ID_INSTALL_ID, modules: ["google-ai"] });
    const bad = await request(app(admin, envFor())).post("/api/licensing/parse-request").send({ request: "garbage" });
    expect(bad.status).toBe(422);
  });

  it("issues a license from a pasted request, verifies, and journals metadata only", async () => {
    const status = await request(app(admin, envFor())).get("/api/licensing/status");
    const res = await request(app(admin, envFor()))
      .post("/api/licensing/issue")
      .send({ request: status.body.request, modules: ["google-ai", "chatgpt-pool"], days: 30, watermark: "client-1" });
    expect(res.status).toBe(201);
    const now = Math.floor(new Date("2026-10-16T08:00:00Z").getTime() / 1000);
    expect(res.body.payload).toEqual({
      rev: 1,
      instance_id: MACHINE_ID_INSTALL_ID,
      modules: ["chatgpt-pool", "google-ai"],
      features: ["core"],
      expires: now + 30 * 86400,
      watermark: "client-1",
    });
    expect(verifyLicense(res.body.license, MACHINE_ID_INSTALL_ID, now, publicKey, { requiredModule: "google-ai" }).valid).toBe(true);
    expect(verifyLicense(res.body.license, "myr-ffffffffffffffffffff", now, publicKey).reason).toBe("instance_mismatch");

    const journal = readFileSync(journalFile, "utf8");
    expect(journal).not.toContain("MYR1.");
    expect(journal).not.toContain("PRIVATE");
    const listed = await request(app(admin, envFor())).get("/api/licensing/issued");
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ instanceId: MACHINE_ID_INSTALL_ID, issuedBy: "user-a", watermark: "client-1" });
    expect(JSON.stringify(res.body)).not.toContain("PRIVATE");
  });

  it("accepts a manual instance id and a license without expiry", async () => {
    const res = await request(app(admin, envFor()))
      .post("/api/licensing/issue")
      .send({ instanceId: "myr-abcdefabcdefabcdefab", modules: ["antigravity"], days: null });
    expect(res.status).toBe(201);
    expect(res.body.payload.expires).toBeNull();
    expect(res.body.payload.watermark).toBeNull();
  });

  it("refuses bad input", async () => {
    const send = (body: unknown) => request(app(admin, envFor())).post("/api/licensing/issue").send(body as object);
    expect((await send({ modules: ["google-ai"], days: 30 })).status).toBe(400);
    expect((await send({ instanceId: "bad id", modules: ["google-ai"], days: 30 })).status).toBe(400);
    expect((await send({ instanceId: "myr-a", modules: [], days: 30 })).status).toBe(400);
    expect((await send({ instanceId: "myr-a", modules: ["other"], days: 30 })).status).toBe(400);
    expect((await send({ instanceId: "myr-a", modules: ["google-ai"], days: 0 })).status).toBe(400);
    expect((await send({ request: "garbage", modules: ["google-ai"], days: 30 })).status).toBe(422);
  });

  it("reports a clear error and issues nothing when the key is not configured", async () => {
    for (const env of [
      { MYRMIDON_LICENSE_JOURNAL_FILE: journalFile },
      { MYRMIDON_LICENSE_ISSUER_KEY_FILE: path.join(dir, "missing.pem"), MYRMIDON_LICENSE_JOURNAL_FILE: journalFile },
    ]) {
      const res = await request(app(admin, env))
        .post("/api/licensing/issue")
        .send({ instanceId: "myr-a", modules: ["google-ai"], days: 30 });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).not.toContain(dir);
    }
    const status = await request(app(admin, { MYRMIDON_LICENSE_JOURNAL_FILE: journalFile })).get("/api/licensing/status");
    expect(status.body.issuerConfigured).toBe(false);
    expect((await request(app(admin, envFor())).get("/api/licensing/issued")).body).toEqual([]);
  });

  it("refuses a key that is not Ed25519", async () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(keyFile, rsa.privateKey.export({ type: "pkcs8", format: "pem" }));
    const res = await request(app(admin, envFor()))
      .post("/api/licensing/issue")
      .send({ instanceId: "myr-a", modules: ["google-ai"], days: 30 });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain(dir);
  });
});
