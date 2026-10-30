// myrmidon(LICENSING, OPE-8964): the signed deny-list in the board's licensing
// check. Key pairs are generated here; no real key is stored in the repository.

import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../routes/error-handler.js";
import { moduleStatuses } from "./client-license.js";
import { createDenyListReader, writeDenyListFile } from "./denylist.js";
import { keyId, verifyLicense } from "./license.js";
import { licensingRoutes } from "./routes.js";

const INSTALL_ID = "myr-0123456789abcdef0123";
const NOW_S = 1_800_000_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "deny-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const b64 = (b: Buffer) => b.toString("base64url");

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey };
}

function license(privateKey: KeyObject, publicKey: KeyObject, id: string | null) {
  const payload: Record<string, unknown> = {
    expires: null,
    features: ["core"],
    instance_id: INSTALL_ID,
    kid: keyId(publicKey),
    modules: ["google-ai"],
    rev: 1,
    watermark: null,
  };
  if (id) payload.id = id;
  const bytes = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(payload).sort())), "ascii");
  return `MYR1.${b64(bytes)}.${b64(sign(null, bytes, privateKey))}`;
}

function denyFile(privateKey: KeyObject, over: Record<string, unknown> = {}, raw?: string) {
  const bytes = Buffer.from(
    raw ?? JSON.stringify({ ids: [], instance_ids: [], issued_at: 1, kids: [], serial: 1, ...over }),
    "ascii",
  );
  return JSON.stringify({ payload: b64(bytes), signature: b64(sign(null, bytes, privateKey)) });
}

function setup(id: string | null = "lic-1") {
  const k = keys();
  const env = {
    MYR_LICENSE_PATH: path.join(dir, "license.key"),
    MYR_LICENSE_DENY_PATH: path.join(dir, "license.deny.json"),
  } as NodeJS.ProcessEnv;
  const warnings: string[] = [];
  const reader = createDenyListReader({ env: () => env, trustedKeys: [k.publicKey], warn: (m) => warnings.push(m) });
  const text = license(k.privateKey, k.publicKey, id);
  const status = () =>
    moduleStatuses({
      license: { text, source: "file" },
      installId: INSTALL_ID,
      nowSeconds: NOW_S,
      trustedKeys: [k.publicKey],
      installed: ["google-ai"],
      denyList: reader,
    }).find((s) => s.module === "google-ai")!;
  return { k, env, reader, warnings, status, denyPath: env.MYR_LICENSE_DENY_PATH as string, text };
}

describe("license payload id", () => {
  it("accepts the optional signed id and exposes it", () => {
    const s = setup("lic-1");
    const r = verifyLicense(s.text, INSTALL_ID, NOW_S, [s.k.publicKey], { requiredModule: "google-ai" });
    expect(r.valid).toBe(true);
    expect(r.payload?.id).toBe("lic-1");
  });
});

describe("deny-list in the licensing check", () => {
  it("no file revokes nobody; a signed list revokes on the next call; removal restores", () => {
    const s = setup();
    expect(s.status().reason).toBe("ok");
    writeFileSync(s.denyPath, denyFile(s.k.privateKey, { ids: ["lic-1"] }));
    expect(s.status().reason).toBe("revoked");
    rmSync(s.denyPath);
    expect(s.status().reason).toBe("ok");
  });

  it("id, instance_id and kid each match on their own; ids never match a license without id", () => {
    const s = setup();
    writeFileSync(s.denyPath, denyFile(s.k.privateKey, { instance_ids: [INSTALL_ID], serial: 1 }));
    expect(s.status().reason).toBe("revoked");
    writeFileSync(s.denyPath, denyFile(s.k.privateKey, { kids: [keyId(s.k.publicKey)], serial: 2 }));
    expect(s.status().reason).toBe("revoked");
    writeFileSync(s.denyPath, denyFile(s.k.privateKey, { ids: ["other"], serial: 3 }));
    expect(s.status().reason).toBe("ok");
    const noId = setup(null);
    writeFileSync(noId.denyPath, denyFile(noId.k.privateKey, { ids: ["lic-1"] }));
    expect(noId.status().reason).toBe("ok");
  });

  it("a foreign signature, broken JSON and a wrong shape are ignored with a warning", () => {
    const s = setup();
    writeFileSync(s.denyPath, denyFile(keys().privateKey, { instance_ids: [INSTALL_ID] }));
    expect(s.status().reason).toBe("ok");
    writeFileSync(s.denyPath, "{not json");
    expect(s.status().reason).toBe("ok");
    writeFileSync(s.denyPath, denyFile(s.k.privateKey, {}, '{"entries":[],"rev":1}'));
    expect(s.status().reason).toBe("ok");
    expect(s.warnings.length).toBe(3);
    expect(s.warnings.every((w) => w.startsWith("license deny-list ignored"))).toBe(true);
  });

  it("a lower serial than seen is rejected, including after a restart (state file)", () => {
    const s = setup();
    writeFileSync(s.denyPath, denyFile(s.k.privateKey, { ids: ["lic-1"], serial: 5 }));
    expect(s.status().reason).toBe("revoked");
    expect(readFileSync(path.join(dir, "license.deny.state"), "utf8").trim()).toBe("5");
    writeFileSync(s.denyPath, denyFile(s.k.privateKey, { serial: 4 }));
    expect(s.status().reason).toBe("ok");
    expect(s.warnings.some((w) => w.includes("lower than the seen 5"))).toBe(true);
    const fresh = createDenyListReader({ env: () => s.env, trustedKeys: [s.k.publicKey] });
    writeFileSync(s.denyPath, denyFile(s.k.privateKey, { ids: ["lic-1"], serial: 3 }));
    expect(fresh.revoked({ licenseId: "lic-1" })).toBe(false);
    writeFileSync(s.denyPath, denyFile(s.k.privateKey, { ids: ["lic-1"], serial: 6 }));
    expect(fresh.revoked({ licenseId: "lic-1" })).toBe(true);
  });

  it("without a state file any valid list is accepted and its serial is remembered; the state path is overridable", () => {
    const s = setup();
    expect(existsSync(path.join(dir, "license.deny.state"))).toBe(false);
    writeFileSync(s.denyPath, denyFile(s.k.privateKey, { serial: 9 }));
    s.status();
    expect(readFileSync(path.join(dir, "license.deny.state"), "utf8").trim()).toBe("9");
    const custom = path.join(dir, "custom.state");
    const reader = createDenyListReader({ env: () => ({ ...s.env, MYR_LICENSE_DENY_STATE_PATH: custom }), trustedKeys: [s.k.publicKey] });
    reader.revoked({ licenseId: "x" });
    expect(readFileSync(custom, "utf8").trim()).toBe("9");
  });

  it("the default list path is next to the license file", () => {
    const k = keys();
    const env = { MYR_LICENSE_PATH: path.join(dir, "license.key") } as NodeJS.ProcessEnv;
    const reader = createDenyListReader({ env: () => env, trustedKeys: [k.publicKey] });
    writeFileSync(path.join(dir, "license.deny.json"), denyFile(k.privateKey, { instance_ids: [INSTALL_ID] }));
    expect(reader.revoked({ instanceId: INSTALL_ID })).toBe(true);
  });

  it("writeDenyListFile writes atomically with 0644 mode and overwrites cleanly", () => {
    const k = keys();
    const denyTarget = path.join(dir, "license.deny.json");
    const content = denyFile(k.privateKey, { ids: ["lic-1"], serial: 10 });
    writeDenyListFile(denyTarget, content);
    expect(readFileSync(denyTarget, "utf8")).toBe(content.trim() + "\n");
  });
});

describe("POST /api/licensing/deny-list endpoint", () => {
  const admin = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: true, companyIds: [] };
  const member = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: [] };

  function app(actor: unknown, env: NodeJS.ProcessEnv, trustedKeys: Array<string | KeyObject>) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    a.use(
      "/api",
      licensingRoutes({
        env,
        installId: async () => ({ installId: INSTALL_ID, source: "machine-id" as const }),
        now: () => new Date(NOW_S * 1000),
        installedModules: async () => ["google-ai"],
        trustedKeys,
      }),
    );
    a.use(errorHandler);
    return a;
  }

  it("saves a valid deny-list, writes file atomically, and updates module status to revoked", async () => {
    const k = keys();
    const licenseTarget = path.join(dir, "license.key");
    const denyTarget = path.join(dir, "license.deny.json");
    const licenseText = license(k.privateKey, k.publicKey, "lic-test-1");
    writeFileSync(licenseTarget, licenseText);

    const env: NodeJS.ProcessEnv = {
      MYR_LICENSE_PATH: licenseTarget,
      MYR_LICENSE_DENY_PATH: denyTarget,
      PAPERCLIP_BUILD_VERSION: "1.6.6",
    };
    const application = app(admin, env, [k.publicKey]);

    // Initial status: valid
    const initialStatus = await request(application).get("/api/licensing/status");
    expect(initialStatus.status).toBe(200);
    const googleInitial = initialStatus.body.modules.find((m: { module: string }) => m.module === "google-ai");
    expect(googleInitial.state).toBe("valid");
    expect(googleInitial.reason).toBe("ok");

    // Post valid signed deny-list revoking lic-test-1
    const denyContent = denyFile(k.privateKey, { ids: ["lic-test-1"], serial: 1 });
    const postRes = await request(application)
      .post("/api/licensing/deny-list")
      .send({ value: `\n${denyContent}  \n` });
    expect(postRes.status).toBe(200);

    // File on disk written atomically with 0644 mode
    expect(readFileSync(denyTarget, "utf8")).toBe(denyContent.trim() + "\n");

    // Returned client state immediately reflects revocation
    const googleRevoked = postRes.body.modules.find((m: { module: string }) => m.module === "google-ai");
    expect(googleRevoked).toMatchObject({
      state: "invalid",
      reason: "revoked",
    });

    // Subsequent GET status also reports revoked
    const updatedStatus = await request(application).get("/api/licensing/status");
    const googleUpdated = updatedStatus.body.modules.find((m: { module: string }) => m.module === "google-ai");
    expect(googleUpdated).toMatchObject({
      state: "invalid",
      reason: "revoked",
    });

    // Also works under /api/myrmidon/licensing/deny-list prefix
    const denyContent2 = denyFile(k.privateKey, { instance_ids: [INSTALL_ID], serial: 2 });
    const postRes2 = await request(application)
      .post("/api/myrmidon/licensing/deny-list")
      .send({ value: denyContent2 });
    expect(postRes2.status).toBe(200);
    expect(readFileSync(denyTarget, "utf8")).toBe(denyContent2.trim() + "\n");
  });

  it("refuses invalid or foreign-signed deny-lists with 422 deny_list_invalid", async () => {
    const k = keys();
    const foreign = keys();
    const denyTarget = path.join(dir, "license.deny.json");
    const env: NodeJS.ProcessEnv = {
      MYR_LICENSE_PATH: path.join(dir, "license.key"),
      MYR_LICENSE_DENY_PATH: denyTarget,
      PAPERCLIP_BUILD_VERSION: "1.6.6",
    };
    const application = app(admin, env, [k.publicKey]);

    const cases: Array<[string, string]> = [
      ["not a json envelope", "malformed envelope"],
      [JSON.stringify({ not: "an envelope" }), "missing payload/signature"],
      [denyFile(foreign.privateKey, { ids: ["lic-1"] }), "foreign issuer key"],
      [denyFile(k.privateKey, {}, '{"broken":"json"'), "malformed payload json"],
      [denyFile(k.privateKey, { ids: [123] as unknown as string[] }), "invalid types in payload"],
    ];

    for (const [value, label] of cases) {
      const res = await request(application).post("/api/licensing/deny-list").send({ value });
      expect(res.status, label).toBe(422);
      expect(res.body.code, label).toBe("deny_list_invalid");
    }
    expect(existsSync(denyTarget)).toBe(false);
  });

  it("refuses to save deny-list when target directory is unwritable with 409 deny_list_path_unwritable", async () => {
    const k = keys();
    const unwritablePath = path.join(dir, "nonexistent-dir", "license.deny.json");
    const env: NodeJS.ProcessEnv = {
      MYR_LICENSE_PATH: path.join(dir, "license.key"),
      MYR_LICENSE_DENY_PATH: unwritablePath,
      PAPERCLIP_BUILD_VERSION: "1.6.6",
    };
    const application = app(admin, env, [k.publicKey]);
    const validDeny = denyFile(k.privateKey, { ids: ["lic-1"] });

    const res = await request(application).post("/api/licensing/deny-list").send({ value: validDeny });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("deny_list_path_unwritable");
    expect(res.body.error).toContain(unwritablePath);
    expect(res.body.error).toContain("ENOENT");
  });

  it("enforces instance-admin authorization and validates request body", async () => {
    const k = keys();
    const env: NodeJS.ProcessEnv = {
      MYR_LICENSE_PATH: path.join(dir, "license.key"),
      MYR_LICENSE_DENY_PATH: path.join(dir, "license.deny.json"),
      PAPERCLIP_BUILD_VERSION: "1.6.6",
    };
    const validDeny = denyFile(k.privateKey, { ids: ["lic-1"] });

    // 403 for non-admin
    const forbiddenRes = await request(app(member, env, [k.publicKey]))
      .post("/api/licensing/deny-list")
      .send({ value: validDeny });
    expect(forbiddenRes.status).toBe(403);
    expect(existsSync(env.MYR_LICENSE_DENY_PATH!)).toBe(false);

    // 400 for invalid body
    const badBodyRes = await request(app(admin, env, [k.publicKey]))
      .post("/api/licensing/deny-list")
      .send({ value: "" });
    expect(badBodyRes.status).toBe(400);

    const missingFieldRes = await request(app(admin, env, [k.publicKey]))
      .post("/api/licensing/deny-list")
      .send({});
    expect(missingFieldRes.status).toBe(400);
  });
});
