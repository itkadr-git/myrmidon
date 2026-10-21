// myrmidon(LICENSING): the client side — MYRQ1 compatibility with the module
// side, verification of licenses minted by the module-side `runner issue`,
// key rotation (kid, several trusted keys), license state per module and
// saving a license where the modules read it.
//
// The fixtures below were produced by the module-side reference tooling with
// a throwaway key pair made for this test (only its public half is here):
//   runner issue --signing-key <throwaway> --instance myr-3eb1bd439947eb762998 ...
//   build_request(["google-ai","chatgpt-pool"], board="1.6.6-rc.11",
//                 instance_id="myr-3eb1bd439947eb762998", now=1760918400)
// Set MYR_LICENSE_CORE_SRC to the module-side `license-core/src` directory
// (and MYR_ANTIGRAVITY_LICENSE_TS to the adapter's `src/license.ts`) to
// additionally run the live round trips against the reference code.

import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import {
  hostShare,
  moduleStatuses,
  needsAttention,
  readCandidateLicense,
  writeLicenseFile,
} from "./client-license.js";
import { buildLicenseRequest, keyId, verifyLicense, type TrustedIssuerKey } from "./license.js";
import { licensingRoutes } from "./routes.js";
import { TRUSTED_ISSUER_KEYS } from "./trusted-keys.js";

const MACHINE_ID = "0123456789abcdef0123456789abcdef";
const INSTALL_ID = "myr-3eb1bd439947eb762998";
const LICENSE_CORE_SRC = (process.env.MYR_LICENSE_CORE_SRC ?? "").trim();
// The antigravity adapter's license gate (`.../antigravity/adapter/src/license.ts`):
// it runs inside the board container, so it must read what the screen saved.
const ADAPTER_LICENSE_TS = (process.env.MYR_ANTIGRAVITY_LICENSE_TS ?? "").trim();

const TEST_KEY_1 =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPC+aKt6rukuqsW1vgR4NlACvsAMS1bDx4SJCWb1EvgY=\n-----END PUBLIC KEY-----\n";
const TEST_KEY_2 =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAX9iZZF76JaUe/wdyMFMAxV8sb34Kxufv/chPPn62v8A=\n-----END PUBLIC KEY-----\n";

// `runner issue` outputs (key 1 unless named).
const RUNNER_ISSUED = {
  // all three modules, expires 2100-01-01, watermark client-test
  all: "MYR1.eyJleHBpcmVzIjo0MTAyNDQ0ODAwLCJmZWF0dXJlcyI6WyJjb3JlIl0sImluc3RhbmNlX2lkIjoibXlyLTNlYjFiZDQzOTk0N2ViNzYyOTk4IiwibW9kdWxlcyI6WyJhbnRpZ3Jhdml0eSIsImNoYXRncHQtcG9vbCIsImdvb2dsZS1haSJdLCJyZXYiOjEsIndhdGVybWFyayI6ImNsaWVudC10ZXN0In0.Pl-8KA31anJzXn_yiFBeDmBewxSVnNotBuozBJ-QRvkHNkoBkpV_sTElfL8RTh-WEQbY1ZLYGpMIZyk8GehIBw",
  // google-ai, expired in 2023
  expired:
    "MYR1.eyJleHBpcmVzIjoxNzAwMDAwMDAwLCJmZWF0dXJlcyI6WyJjb3JlIl0sImluc3RhbmNlX2lkIjoibXlyLTNlYjFiZDQzOTk0N2ViNzYyOTk4IiwibW9kdWxlcyI6WyJnb29nbGUtYWkiXSwicmV2IjoxLCJ3YXRlcm1hcmsiOm51bGx9.WYOOwEeJdCCotjLwVLX-yUhj859IuaNDP0TcDx5h-BgbmT1ecZLvzU7LgjQyyMPL3H4V5fEIl-ZduZwUfakMAA",
  // google-ai + chatgpt-pool for another installation, no expiry
  other:
    "MYR1.eyJleHBpcmVzIjpudWxsLCJmZWF0dXJlcyI6WyJjb3JlIl0sImluc3RhbmNlX2lkIjoibXlyLTAwMDAwMDAwMDAwMDAwMDAwMDAwIiwibW9kdWxlcyI6WyJjaGF0Z3B0LXBvb2wiLCJnb29nbGUtYWkiXSwicmV2IjoxLCJ3YXRlcm1hcmsiOm51bGx9.TVCvSL5oDo8hS7C4HX_BZDDaRKeGwQpiUz-eWKovdOGt3F-stCWVQJtus-HGyk4lkq97XrsjlN1K_vlrCks-Bw",
  // chatgpt-pool only, features core+video, no expiry
  chatgptOnly:
    "MYR1.eyJleHBpcmVzIjpudWxsLCJmZWF0dXJlcyI6WyJjb3JlIiwidmlkZW8iXSwiaW5zdGFuY2VfaWQiOiJteXItM2ViMWJkNDM5OTQ3ZWI3NjI5OTgiLCJtb2R1bGVzIjpbImNoYXRncHQtcG9vbCJdLCJyZXYiOjEsIndhdGVybWFyayI6bnVsbH0.g9aVCn4lKALdJ3vrzIDeyYSWFpknZkGkvVti9RjooPiJESCtbHt4pE3TiP5ktQ1nTJiGoWZgDpVMPBPTcH6OBQ",
  // google-ai + antigravity with kid (runner issue default since rotation support), expires 2100-01-01
  withKid:
    "MYR1.eyJleHBpcmVzIjo0MTAyNDQ0ODAwLCJmZWF0dXJlcyI6WyJjb3JlIl0sImluc3RhbmNlX2lkIjoibXlyLTNlYjFiZDQzOTk0N2ViNzYyOTk4Iiwia2lkIjoiMDkxMmU0ZTk2YzhhMzlhZiIsIm1vZHVsZXMiOlsiYW50aWdyYXZpdHkiLCJnb29nbGUtYWkiXSwicmV2IjoxLCJ3YXRlcm1hcmsiOm51bGx9.-faodQMn9hOt4y5mNGD3CeS5t-TUZ_2JvpJ9_N0wqYuuZO8zeS09H3pvWTnRJZtj2yqDvdtFcvz7uaEWUzkTBA",
  // antigravity, signed with key 2, expires 2100-01-01
  key2Antigravity:
    "MYR1.eyJleHBpcmVzIjo0MTAyNDQ0ODAwLCJmZWF0dXJlcyI6WyJjb3JlIl0sImluc3RhbmNlX2lkIjoibXlyLTNlYjFiZDQzOTk0N2ViNzYyOTk4IiwibW9kdWxlcyI6WyJhbnRpZ3Jhdml0eSJdLCJyZXYiOjEsIndhdGVybWFyayI6bnVsbH0.M1qJO0fpgrNbODxXSg-TfNcJ7AzgoyhNkT0WnUnpEayXIlSbe-jqgjCdJ3NIauxvPgrC60W6d9SqJdNSmmvHCA",
} as const;

const REFERENCE_REQUEST =
  "MYRQ1.eyJib2FyZCI6IjEuNi42LXJjLjExIiwiaW5zdGFuY2VfaWQiOiJteXItM2ViMWJkNDM5OTQ3ZWI3NjI5OTgiLCJtb2R1bGVzIjpbImNoYXRncHQtcG9vbCIsImdvb2dsZS1haSJdLCJ0cyI6IjIwMjUtMTAtMjBUMDA6MDA6MDBaIiwidiI6MX0";

const NOW = new Date("2026-10-16T08:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const MODULES = ["google-ai", "antigravity", "chatgpt-pool"] as const;

function python(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("python3", args, {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: LICENSE_CORE_SRC, ...env },
  }).trim();
}

let dir: string;
let machineIdFile: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lic-client-"));
  machineIdFile = path.join(dir, "machine-id");
  writeFileSync(machineIdFile, MACHINE_ID + "\n");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("MYRQ1 request is the module-side build_request byte for byte", () => {
  it("matches the reference blob for the same inputs", () => {
    expect(
      buildLicenseRequest({
        instanceId: INSTALL_ID,
        board: "1.6.6-rc.11",
        modules: ["google-ai", "chatgpt-pool", "google-ai"],
        now: new Date(1760918400 * 1000 + 789),
      }),
    ).toBe(REFERENCE_REQUEST);
  });

  it("uses `unknown` for an empty board, caps it at 32 chars and refuses unknown or no modules", () => {
    const decode = (blob: string) => JSON.parse(Buffer.from(blob.split(".")[1], "base64url").toString("ascii"));
    const board = (value: string) =>
      decode(buildLicenseRequest({ instanceId: INSTALL_ID, board: value, modules: ["antigravity"], now: NOW })).board;
    expect(board("")).toBe("unknown");
    expect(board("x".repeat(40))).toBe("x".repeat(32));
    expect(() => buildLicenseRequest({ instanceId: INSTALL_ID, board: "1", modules: [], now: NOW })).toThrow();
    expect(() => buildLicenseRequest({ instanceId: INSTALL_ID, board: "1", modules: ["other"], now: NOW })).toThrow();
    const raw = Buffer.from(
      buildLicenseRequest({ instanceId: INSTALL_ID, board: "1.6.6", modules: ["antigravity"], now: NOW }).split(".")[1],
      "base64url",
    ).toString("ascii");
    expect(raw).toBe('{"board":"1.6.6","instance_id":"myr-3eb1bd439947eb762998","modules":["antigravity"],"ts":"2026-10-16T08:00:00Z","v":1}');
  });

  it.skipIf(!LICENSE_CORE_SRC)("passes the reference parse_request (live)", () => {
    const blob = buildLicenseRequest({ instanceId: INSTALL_ID, board: "1.6.6", modules: [...MODULES], now: NOW });
    const parsed = JSON.parse(
      python([
        "-c",
        "import json,sys; from license_core.request import parse_request; print(json.dumps(parse_request(sys.argv[1]), sort_keys=True))",
        blob,
      ]),
    );
    expect(parsed).toEqual({
      board: "1.6.6",
      instance_id: INSTALL_ID,
      modules: ["antigravity", "chatgpt-pool", "google-ai"],
      ts: "2026-10-16T08:00:00Z",
      v: 1,
    });
    const reference = python([
      "-c",
      "import sys; from license_core.request import build_request; print(build_request(['antigravity','chatgpt-pool','google-ai'], board='1.6.6', instance_id=sys.argv[1], now=int(sys.argv[2])))",
      INSTALL_ID,
      String(NOW_S),
    ]);
    expect(blob).toBe(reference);
  });
});

describe("licenses minted by the module-side `runner issue`", () => {
  const keys: TrustedIssuerKey[] = [TEST_KEY_1, TEST_KEY_2];
  // Expected reasons: the module-side verify_license on the same strings
  // (key 1 as the only trust anchor, then key 2 as the only one).
  const expected: Record<keyof typeof RUNNER_ISSUED, Record<(typeof MODULES)[number], [string, string]>> = {
    all: { "google-ai": ["ok", "bad_signature"], antigravity: ["ok", "bad_signature"], "chatgpt-pool": ["ok", "bad_signature"] },
    expired: {
      "google-ai": ["expired", "bad_signature"],
      antigravity: ["expired", "bad_signature"],
      "chatgpt-pool": ["expired", "bad_signature"],
    },
    other: {
      "google-ai": ["instance_mismatch", "bad_signature"],
      antigravity: ["instance_mismatch", "bad_signature"],
      "chatgpt-pool": ["instance_mismatch", "bad_signature"],
    },
    chatgptOnly: {
      "google-ai": ["module_not_granted", "bad_signature"],
      antigravity: ["module_not_granted", "bad_signature"],
      "chatgpt-pool": ["ok", "bad_signature"],
    },
    withKid: {
      "google-ai": ["ok", "bad_signature"],
      antigravity: ["ok", "bad_signature"],
      "chatgpt-pool": ["module_not_granted", "bad_signature"],
    },
    key2Antigravity: {
      "google-ai": ["bad_signature", "module_not_granted"],
      antigravity: ["bad_signature", "ok"],
      "chatgpt-pool": ["bad_signature", "module_not_granted"],
    },
  };

  it("gives the same verdict as the module side, key by key", () => {
    for (const [name, license] of Object.entries(RUNNER_ISSUED) as [keyof typeof RUNNER_ISSUED, string][]) {
      for (const module of MODULES) {
        const [withKey1, withKey2] = expected[name][module];
        expect(verifyLicense(license, INSTALL_ID, NOW_S, TEST_KEY_1, { requiredModule: module }).reason, `${name}/${module}/k1`).toBe(withKey1);
        expect(verifyLicense(license, INSTALL_ID, NOW_S, TEST_KEY_2, { requiredModule: module }).reason, `${name}/${module}/k2`).toBe(withKey2);
      }
    }
  });

  it("verifies old licenses without kid against every trusted key", () => {
    expect(verifyLicense(RUNNER_ISSUED.all, INSTALL_ID, NOW_S, keys, { requiredModule: "google-ai" })).toMatchObject({
      valid: true,
      payload: { modules: ["antigravity", "chatgpt-pool", "google-ai"], expires: 4102444800, watermark: "client-test" },
    });
    expect(verifyLicense(RUNNER_ISSUED.key2Antigravity, INSTALL_ID, NOW_S, keys, { requiredModule: "antigravity" }).valid).toBe(true);
    expect(verifyLicense(RUNNER_ISSUED.all, INSTALL_ID, NOW_S, [TEST_KEY_2]).reason).toBe(
      "bad_signature",
    );
  });

  it("does not trust the test keys in production: the shipped list knows only the issuer key", () => {
    expect(TRUSTED_ISSUER_KEYS).toHaveLength(1);
    expect(verifyLicense(RUNNER_ISSUED.all, INSTALL_ID, NOW_S, TRUSTED_ISSUER_KEYS).reason).toBe("bad_signature");
  });

  it.skipIf(!LICENSE_CORE_SRC)("verifies a license issued live by `runner issue` with a temporary key", () => {
    const pair = generateKeyPairSync("ed25519");
    const keyFile = path.join(dir, "temp-signing.pem");
    writeFileSync(keyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const license = python([
      "-m", "license_core.runner", "issue",
      "--signing-key", keyFile,
      "--instance", INSTALL_ID,
      "--module", "google-ai", "--module", "chatgpt-pool",
      "--feature", "core", "--feature", "video",
      "--expires", String(NOW_S + 30 * 86400),
      "--watermark", "client-a",
    ]);
    const legacy = python([
      "-m", "license_core.runner", "issue", "--no-kid",
      "--signing-key", keyFile, "--instance", INSTALL_ID, "--module", "antigravity",
    ]);
    const referenceKid = python([
      "-c",
      "import sys; from license_core.key import key_id; print(key_id(sys.argv[1]))",
      pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    ]);
    expect(keyId(pair.publicKey)).toBe(referenceKid);
    expect(verifyLicense(license, INSTALL_ID, NOW_S, [pair.publicKey]).kid).toBe(referenceKid);
    expect(verifyLicense(legacy, INSTALL_ID, NOW_S, [pair.publicKey], { requiredModule: "antigravity" })).toMatchObject({
      valid: true,
      kid: null,
    });
    const trusted = [pair.publicKey];
    expect(verifyLicense(license, INSTALL_ID, NOW_S, trusted, { requiredModule: "google-ai" })).toMatchObject({
      valid: true,
      payload: { modules: ["chatgpt-pool", "google-ai"], features: ["core", "video"], expires: NOW_S + 30 * 86400, watermark: "client-a" },
    });
    expect(verifyLicense(license, INSTALL_ID, NOW_S, trusted, { requiredModule: "antigravity" }).reason).toBe("module_not_granted");
    expect(verifyLicense(license, "myr-ffffffffffffffffffff", NOW_S, trusted).reason).toBe("instance_mismatch");
    expect(verifyLicense(license, INSTALL_ID, NOW_S + 31 * 86400, trusted).reason).toBe("expired");
  });
});

/** Test-only signer (throwaway keys): the board itself has no signing code. */
function issueLicense(
  privateKey: KeyObject,
  p: { instanceId: string; modules: string[]; features: string[]; expires: number | null; watermark: string | null },
): { license: string } {
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
  return { license: `MYR1.${bytes.toString("base64url")}.${edSign(null, bytes, privateKey).toString("base64url")}` };
}

/** A license whose payload carries `kid` (the rotation format), signed by `key`. */
function kidLicense(key: KeyObject, kid: unknown, extra: Record<string, unknown> = {}): string {
  const payload = {
    expires: null,
    features: ["core"],
    instance_id: INSTALL_ID,
    kid,
    modules: ["google-ai"],
    rev: 1,
    watermark: null,
    ...extra,
  };
  const bytes = Buffer.from(JSON.stringify(payload), "ascii");
  return `MYR1.${bytes.toString("base64url")}.${edSign(null, bytes, key).toString("base64url")}`;
}

describe("key rotation: kid and several trusted keys", () => {
  const oldPair = generateKeyPairSync("ed25519");
  const newPair = generateKeyPairSync("ed25519");
  const keys: TrustedIssuerKey[] = [oldPair.publicKey, newPair.publicKey];

  it("computes the module-side key id", () => {
    expect(keyId(TEST_KEY_1)).toBe("0912e4e96c8a39af");
    expect(keyId(TEST_KEY_2)).toBe("2bc8cc8ac044b69a");
  });

  it("accepts a kid license signed by any trusted key whose id it names", () => {
    const kid = keyId(newPair.publicKey);
    expect(verifyLicense(kidLicense(newPair.privateKey, kid), INSTALL_ID, NOW_S, keys)).toMatchObject({ valid: true, kid });
    expect(verifyLicense(RUNNER_ISSUED.withKid, INSTALL_ID, NOW_S, [TEST_KEY_2, TEST_KEY_1])).toMatchObject({
      valid: true,
      kid: "0912e4e96c8a39af",
    });
  });

  it("refuses a kid that is not the id of the verifying key, and untrusted keys", () => {
    expect(verifyLicense(kidLicense(newPair.privateKey, keyId(oldPair.publicKey)), INSTALL_ID, NOW_S, keys).reason).toBe("bad_payload");
    expect(verifyLicense(kidLicense(newPair.privateKey, 7), INSTALL_ID, NOW_S, keys).reason).toBe("bad_payload");
    expect(
      verifyLicense(kidLicense(newPair.privateKey, keyId(newPair.publicKey), { extra: true }), INSTALL_ID, NOW_S, keys).reason,
    ).toBe("bad_payload");
    expect(verifyLicense(kidLicense(newPair.privateKey, keyId(newPair.publicKey)), INSTALL_ID, NOW_S, [oldPair.publicKey]).reason).toBe(
      "bad_signature",
    );
  });

  it("still verifies licenses without kid from the old key", () => {
    const { license } = issueLicense(oldPair.privateKey, {
      instanceId: INSTALL_ID,
      modules: ["antigravity"],
      features: ["core"],
      expires: null,
      watermark: null,
    });
    expect(verifyLicense(license, INSTALL_ID, NOW_S, keys, { requiredModule: "antigravity" })).toMatchObject({ valid: true, kid: null });
  });
});

describe("license state per module", () => {
  const keys = [TEST_KEY_1];
  const states = (text: string | null, installed: string[] = [...MODULES]) =>
    Object.fromEntries(
      moduleStatuses({
        license: { text, source: text ? "file" : "none" },
        installId: INSTALL_ID,
        nowSeconds: NOW_S,
        trustedKeys: keys,
        installed,
      }).map((s) => [s.module, s.state]),
    );

  it("maps the module decisions to the screen states", () => {
    expect(states(RUNNER_ISSUED.all)).toEqual({ "google-ai": "valid", antigravity: "valid", "chatgpt-pool": "valid" });
    expect(states(RUNNER_ISSUED.expired)["google-ai"]).toBe("expired");
    expect(states(RUNNER_ISSUED.other)["google-ai"]).toBe("wrong_instance");
    expect(states(RUNNER_ISSUED.chatgptOnly)).toEqual({ "google-ai": "not_granted", antigravity: "not_granted", "chatgpt-pool": "valid" });
    expect(states(RUNNER_ISSUED.key2Antigravity).antigravity).toBe("bad_signature");
    expect(states(null).antigravity).toBe("missing");
    expect(states("MYR1.garbage").antigravity).toBe("invalid");
  });

  it("reports a license that ends within 14 days as expiring", () => {
    const pair = generateKeyPairSync("ed25519");
    const soon = issueLicense(pair.privateKey, {
      instanceId: INSTALL_ID,
      modules: ["google-ai"],
      features: ["core"],
      expires: NOW_S + 5 * 86400,
      watermark: null,
    }).license;
    const [google] = moduleStatuses({
      license: { text: soon, source: "file" },
      installId: INSTALL_ID,
      nowSeconds: NOW_S,
      trustedKeys: [pair.publicKey],
      installed: ["google-ai"],
    });
    expect(google).toMatchObject({ state: "expiring", expires: NOW_S + 5 * 86400 });
  });

  it("raises attention only for installed modules without a working license", () => {
    const st = (text: string | null, installed: string[]) =>
      moduleStatuses({ license: { text, source: text ? "file" : "none" }, installId: INSTALL_ID, nowSeconds: NOW_S, trustedKeys: keys, installed });
    expect(needsAttention(st(null, []))).toBe(false);
    expect(needsAttention(st(null, ["antigravity"]))).toBe(true);
    expect(needsAttention(st(RUNNER_ISSUED.chatgptOnly, ["chatgpt-pool"]))).toBe(false);
    expect(needsAttention(st(RUNNER_ISSUED.chatgptOnly, ["chatgpt-pool", "google-ai"]))).toBe(true);
  });

  it("reads the license from MYR_LICENSE first, then the file", () => {
    const file = path.join(dir, "license.key");
    expect(readCandidateLicense({ MYR_LICENSE_PATH: file })).toEqual({ text: null, source: "none" });
    writeFileSync(file, `  ${RUNNER_ISSUED.all}\n`);
    expect(readCandidateLicense({ MYR_LICENSE_PATH: file })).toEqual({ text: RUNNER_ISSUED.all, source: "file" });
    expect(readCandidateLicense({ MYR_LICENSE_PATH: file, MYR_LICENSE: " MYR1.x.y " })).toEqual({ text: "MYR1.x.y", source: "env" });
    expect(readCandidateLicense({ MYR_LICENSE_PATH: dir }).source).toBe("file-error");
  });
});

describe("writing the license file", () => {
  it("rewrites in place, keeping the inode, and never leaves stale bytes", () => {
    const file = path.join(dir, "license.key");
    writeLicenseFile(file, RUNNER_ISSUED.all);
    expect(readFileSync(file, "utf8")).toBe(RUNNER_ISSUED.all + "\n");
    const inode = statSync(file).ino;
    writeLicenseFile(file, RUNNER_ISSUED.expired);
    expect(statSync(file).ino).toBe(inode);
    expect(readFileSync(file, "utf8")).toBe(RUNNER_ISSUED.expired + "\n");
  });

  it("does not create a missing directory", () => {
    expect(() => writeLicenseFile(path.join(dir, "absent", "license.key"), RUNNER_ISSUED.all)).toThrow();
  });
});

describe("host share probe", () => {
  const mountInfo = (mountPoints: string[]) => {
    const file = path.join(dir, "mountinfo");
    writeFileSync(
      file,
      mountPoints.map((mp, i) => `${100 + i} 1 0:${i} / ${mp} rw,relatime - ext4 /dev/sda1 rw`).join("\n") + "\n",
    );
    return file;
  };
  const marker = () => {
    const file = path.join(dir, "dockerenv");
    writeFileSync(file, "");
    return file;
  };

  it("tells a bind-mounted directory or file from the container layer", () => {
    const target = "/etc/myrmidon-license/license.key";
    expect(hostShare(target, { containerMarkers: [path.join(dir, "none")] })).toBe("host");
    const containerMarkers = [marker()];
    expect(hostShare(target, { containerMarkers, mountInfoPath: mountInfo(["/", "/etc/hosts", "/etc/myrmidon-license"]) })).toBe("mounted");
    expect(hostShare(target, { containerMarkers, mountInfoPath: mountInfo(["/", target]) })).toBe("mounted");
    expect(hostShare(target, { containerMarkers, mountInfoPath: mountInfo(["/", "/etc/hosts", "/etc/myrmidon"]) })).toBe("container-only");
  });
});

function app(actor: unknown, env: NodeJS.ProcessEnv, installed: string[] = [...MODULES]) {
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
      machineIdPaths: [machineIdFile],
      now: () => NOW,
      installedModules: async () => installed,
      trustedKeys: [TEST_KEY_1],
      hostShare: { containerMarkers: [path.join(dir, "no-container")] },
    }),
  );
  a.use(errorHandler);
  return a;
}

const admin = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: true, companyIds: [] };
const member = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: [] };

describe("licensing routes: client side", () => {
  let licenseDir: string;
  let licenseFile: string;
  const envFor = (extra: NodeJS.ProcessEnv = {}) => ({ MYR_LICENSE_PATH: licenseFile, PAPERCLIP_BUILD_VERSION: "1.6.6", ...extra });

  beforeEach(() => {
    licenseDir = path.join(dir, "myrmidon-license");
    mkdirSync(licenseDir);
    licenseFile = path.join(licenseDir, "license.key");
  });

  it("status lists the installed modules, their state and a request for them", async () => {
    const res = await request(app(admin, envFor(), ["antigravity", "google-ai"])).get("/api/licensing/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      installId: INSTALL_ID,
      installedModules: ["antigravity", "google-ai"],
      attention: true,
      license: { source: "none", path: licenseFile, envOverride: false, share: "host" },
    });
    expect(res.body.modules).toEqual([
      { module: "google-ai", installed: true, state: "missing", reason: "no_license", expires: null },
      { module: "antigravity", installed: true, state: "missing", reason: "no_license", expires: null },
      { module: "chatgpt-pool", installed: false, state: "missing", reason: "no_license", expires: null },
    ]);
    const payload = JSON.parse(Buffer.from(res.body.request.split(".")[1], "base64url").toString("ascii"));
    expect(payload).toMatchObject({ v: 1, instance_id: INSTALL_ID, modules: ["antigravity", "google-ai"] });
    expect(payload.ts).toBe("2026-10-16T08:00:00Z");
  });

  it("falls back to every known module in the request when none is installed", async () => {
    const res = await request(app(admin, envFor(), [])).get("/api/licensing/status");
    const payload = JSON.parse(Buffer.from(res.body.request.split(".")[1], "base64url").toString("ascii"));
    expect(payload.modules).toEqual(["antigravity", "chatgpt-pool", "google-ai"]);
    expect(res.body.attention).toBe(false);
  });

  it("saves a valid license where the modules read it and reports it as valid", async () => {
    const res = await request(app(admin, envFor())).post("/api/licensing/license").send({ value: `\n${RUNNER_ISSUED.all}  \n` });
    expect(res.status).toBe(200);
    expect(readFileSync(licenseFile, "utf8")).toBe(RUNNER_ISSUED.all + "\n");
    expect(res.body.attention).toBe(false);
    expect(res.body.license.source).toBe("file");
    expect(res.body.modules.map((m: { state: string }) => m.state)).toEqual(["valid", "valid", "valid"]);
    expect(res.body.modules[0].expires).toBe(4102444800);
    expect(JSON.stringify(res.body)).not.toContain(RUNNER_ISSUED.all.split(".")[2]);

    const status = await request(app(admin, envFor())).get("/api/licensing/status");
    expect(JSON.stringify(status.body)).not.toContain(RUNNER_ISSUED.all.split(".")[2]);
  });

  it("refuses a license that no module would accept and keeps the current file", async () => {
    writeFileSync(licenseFile, RUNNER_ISSUED.chatgptOnly + "\n");
    const [prefix, body, sig] = RUNNER_ISSUED.all.split(".");
    const tampered = [prefix, body, sig.slice(0, 10) + (sig[10] === "A" ? "B" : "A") + sig.slice(11)].join(".");
    const cases: Array<[string, string]> = [
      [RUNNER_ISSUED.other, "license_instance_mismatch"],
      [RUNNER_ISSUED.expired, "license_expired"],
      [RUNNER_ISSUED.key2Antigravity, "license_bad_signature"],
      [tampered, "license_bad_signature"],
      ["hello", "license_bad_format"],
    ];
    for (const [value, code] of cases) {
      const res = await request(app(admin, envFor())).post("/api/licensing/license").send({ value });
      expect(res.status, code).toBe(422);
      expect(res.body.code).toBe(code);
    }
    expect(readFileSync(licenseFile, "utf8")).toBe(RUNNER_ISSUED.chatgptOnly + "\n");
  });

  it("says where it cannot write and refuses when MYR_LICENSE overrides the file", async () => {
    const missing = path.join(dir, "not-mounted", "license.key");
    const unwritable = await request(app(admin, envFor({ MYR_LICENSE_PATH: missing })))
      .post("/api/licensing/license")
      .send({ value: RUNNER_ISSUED.all });
    expect(unwritable.status).toBe(409);
    expect(unwritable.body.code).toBe("license_path_unwritable");
    expect(unwritable.body.error).toContain(missing);
    expect(unwritable.body.error).toContain("ENOENT");

    const env = envFor({ MYR_LICENSE: RUNNER_ISSUED.all });
    const overridden = await request(app(admin, env)).post("/api/licensing/license").send({ value: RUNNER_ISSUED.all });
    expect(overridden.status).toBe(409);
    expect(overridden.body.code).toBe("license_env_override");
    const status = await request(app(admin, env)).get("/api/licensing/status");
    expect(status.body.license).toMatchObject({ source: "env", envOverride: true });
    expect(status.body.modules[0].state).toBe("valid");
  });

  it.skipIf(!LICENSE_CORE_SRC || !ADAPTER_LICENSE_TS)(
    "a license saved by the screen is allowed by the module gates reading the same env (live)",
    async () => {
      const pair = generateKeyPairSync("ed25519");
      const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
      const license = issueLicense(pair.privateKey, {
        instanceId: INSTALL_ID,
        modules: ["antigravity", "google-ai"],
        features: ["core"],
        expires: Math.floor(Date.now() / 1000) + 90 * 86400,
        watermark: null,
      }).license;
      const env = { MYR_LICENSE_PATH: licenseFile, MYR_LICENSE_INSTANCE_ID: INSTALL_ID };
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = admin;
        next();
      });
      a.use("/api", licensingRoutes({ env, trustedKeys: [publicPem] }));
      a.use(errorHandler);
      const saved = await request(a).post("/api/licensing/license").send({ value: license });
      expect(saved.status).toBe(200);
      expect(saved.body.modules.find((m: { module: string }) => m.module === "antigravity").state).toBe("valid");

      // The adapter gate, in a separate process with the same environment.
      const adapter = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "const { createLicenseGate } = await import(process.argv[1]); const g = createLicenseGate('antigravity', process.env, process.argv[2]); console.log(JSON.stringify(g.check()));",
            ADAPTER_LICENSE_TS,
            publicPem,
          ],
          { encoding: "utf8", env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "ignore"] },
        ).trim(),
      );
      expect(adapter).toMatchObject({ allowed: true, reason: "ok", source: "file" });

      // The host-side Python gate of google-ai, same file and instance.
      const core = JSON.parse(
        python(
          [
            "-c",
            "import json,sys; from license_core import LicenseGate, load_config; c = load_config('google-ai'); c.public_key_pem = sys.argv[1]; print(json.dumps(LicenseGate(c).check().to_dict()))",
            publicPem,
          ],
          { ...env, MYR_LICENSE_LOG_TARGET: "/dev/null" },
        ),
      );
      expect(core).toMatchObject({ allowed: true, reason: "ok", source: "file" });
    },
  );

  it("is instance-admin only", async () => {
    expect((await request(app(member, envFor())).get("/api/licensing/status")).status).toBe(403);
    const res = await request(app(member, envFor())).post("/api/licensing/license").send({ value: RUNNER_ISSUED.all });
    expect(res.status).toBe(403);
    expect(() => readFileSync(licenseFile)).toThrow();
  });
});
