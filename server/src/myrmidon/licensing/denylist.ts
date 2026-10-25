// myrmidon(LICENSING, OPE-8964): the signed deny-list of revoked licenses —
// VERIFICATION ONLY, the same format and rules as license_core.denylist in the
// closed modules (the vendor's issuer signs it; the board never holds a key).
//
//   {"payload": b64url(JSON), "signature": b64url(ed25519(payload))}
//   payload = {ids, instance_ids, kids, serial, issued_at}
//
// A license is revoked when its signed `id`, its `instance_id` or its `kid`
// is listed. The file is re-read on every call: no file -> nobody is revoked;
// a broken or foreign signature, or a wrong shape -> the whole list is ignored
// (one warning); a serial lower than the highest one accepted before is
// rejected. The highest accepted serial lives in memory and in a state file
// next to the license (no state file -> any valid list is accepted).

import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_LICENSE_PATH, LICENSE_PATH_ENV } from "./client-license.js";
import type { TrustedIssuerKey } from "./license.js";

export const DENY_PATH_ENV = "MYR_LICENSE_DENY_PATH";
export const DENY_STATE_PATH_ENV = "MYR_LICENSE_DENY_STATE_PATH";
const DENY_FILE_NAME = "license.deny.json";
const DENY_STATE_NAME = "license.deny.state";
const MAX_DENY_BYTES = 1_000_000;

export interface DenyList {
  ids: string[];
  instance_ids: string[];
  kids: string[];
  serial: number;
  issued_at: number;
}

function licenseDir(env: NodeJS.ProcessEnv): string {
  return path.dirname((env[LICENSE_PATH_ENV] ?? "").trim() || DEFAULT_LICENSE_PATH);
}

export function denyListPath(env: NodeJS.ProcessEnv): string {
  return (env[DENY_PATH_ENV] ?? "").trim() || path.join(licenseDir(env), DENY_FILE_NAME);
}

export function denyStatePath(env: NodeJS.ProcessEnv): string {
  return (env[DENY_STATE_PATH_ENV] ?? "").trim() || path.join(licenseDir(env), DENY_STATE_NAME);
}

function b64urlDecode(part: unknown): Buffer {
  if (typeof part !== "string" || !/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("not base64url");
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
const nonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Verify and decode a deny-list file; throws an Error with a neutral message when it must be ignored. */
export function parseDenyList(text: string, trusted: readonly TrustedIssuerKey[]): DenyList {
  let payloadBytes: Buffer;
  let signature: Buffer;
  try {
    const envelope = JSON.parse(text) as { payload?: unknown; signature?: unknown };
    payloadBytes = b64urlDecode(envelope.payload);
    signature = b64urlDecode(envelope.signature);
  } catch {
    throw new Error("malformed deny-list envelope");
  }
  const verified = trusted.some((candidate) => {
    try {
      const key: KeyObject = typeof candidate === "string" ? createPublicKey(candidate) : candidate;
      return verify(null, payloadBytes, key, signature);
    } catch {
      return false;
    }
  });
  if (!verified) throw new Error("deny-list signature does not verify against a trusted key");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new Error("malformed deny-list payload");
  }
  const fields = ["ids", "instance_ids", "kids", "serial", "issued_at"];
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== fields.length || !fields.every((f) => f in data)) {
    throw new Error("deny-list payload has unexpected fields");
  }
  if (!strList(data.ids) || !strList(data.instance_ids) || !strList(data.kids)) throw new Error("deny-list lists are not lists of strings");
  if (!nonNegInt(data.serial) || !nonNegInt(data.issued_at)) throw new Error("deny-list serial or issued_at invalid");
  return data as unknown as DenyList;
}

export interface DenyListReader {
  revoked(who: { licenseId?: string | null; instanceId?: string | null; kid?: string | null }): boolean;
}

export function createDenyListReader(input: {
  env: () => NodeJS.ProcessEnv;
  trustedKeys: readonly TrustedIssuerKey[];
  warn?: (message: string) => void;
}): DenyListReader {
  let maxSerial: number | null = null;
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    input.warn?.(`license deny-list ignored: ${message}`);
  };

  function storedSerial(statePath: string): number | null {
    try {
      const raw = readFileSync(statePath, "utf8").trim();
      return /^[0-9]{1,15}$/.test(raw) ? Number(raw) : null;
    } catch {
      return null;
    }
  }

  function load(): DenyList | null {
    const env = input.env();
    let raw: string;
    try {
      const buf = readFileSync(denyListPath(env));
      if (buf.length > MAX_DENY_BYTES) {
        warnOnce("too-large", "the file is too large");
        return null;
      }
      raw = buf.toString("utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") warnOnce("unreadable", "the file cannot be read");
      return null;
    }
    let data: DenyList;
    try {
      data = parseDenyList(raw, input.trustedKeys);
    } catch (err) {
      warnOnce(`invalid:${(err as Error).message}`, (err as Error).message);
      return null;
    }
    const statePath = denyStatePath(env);
    const seen = [maxSerial, storedSerial(statePath)].filter((n): n is number => n !== null);
    const highest = seen.length > 0 ? Math.max(...seen) : null;
    if (highest !== null && data.serial < highest) {
      warnOnce(`rollback:${data.serial}<${highest}`, `serial ${data.serial} is lower than the seen ${highest}`);
      return null;
    }
    if (highest === null || data.serial > highest) {
      try {
        writeFileSync(`${statePath}.tmp`, `${data.serial}\n`);
        renameSync(`${statePath}.tmp`, statePath);
      } catch {
        warnOnce("state-write", "cannot persist the highest seen serial");
      }
    }
    maxSerial = data.serial;
    return data;
  }

  return {
    revoked({ licenseId, instanceId, kid }) {
      const list = load();
      if (!list) return false;
      return Boolean(
        (licenseId && list.ids.includes(licenseId)) ||
          (instanceId && list.instance_ids.includes(instanceId)) ||
          (kid && list.kids.includes(kid)),
      );
    },
  };
}
