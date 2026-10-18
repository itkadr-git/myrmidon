// myrmidon(LICENSING): the issuer side — loads the Ed25519 private key from a
// server-side file and keeps an append-only journal of issued licenses.
//
// The key path comes from MYRMIDON_LICENSE_ISSUER_KEY_FILE. The key is read
// per issue and never cached, returned by the API or written to a log; only
// the fact "configured / not configured" is exposed. The journal holds
// metadata only (who, when, for which installation, modules, expiry) — never
// the license text.

import { createPrivateKey, randomUUID, type KeyObject } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";

export const ISSUER_KEY_FILE_ENV = "MYRMIDON_LICENSE_ISSUER_KEY_FILE";
export const JOURNAL_FILE_ENV = "MYRMIDON_LICENSE_JOURNAL_FILE";

export type IssuerKeyErrorCode = "not_configured" | "unreadable" | "not_ed25519";

export class IssuerKeyError extends Error {
  constructor(readonly code: IssuerKeyErrorCode) {
    super(`issuer key: ${code}`);
  }
}

export function issuerKeyPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env[ISSUER_KEY_FILE_ENV] ?? "").trim();
  return raw || null;
}

export function isIssuerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return issuerKeyPath(env) !== null;
}

/** Throws IssuerKeyError; the message never contains the path or key bytes. */
export function loadIssuerKey(env: NodeJS.ProcessEnv = process.env): KeyObject {
  const file = issuerKeyPath(env);
  if (!file) throw new IssuerKeyError("not_configured");
  let pem: Buffer;
  try {
    pem = readFileSync(file);
  } catch {
    throw new IssuerKeyError("unreadable");
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new IssuerKeyError("not_ed25519");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new IssuerKeyError("not_ed25519");
  return key;
}

export interface IssuedLicenseRecord {
  id: string;
  issuedAt: string;
  issuedBy: string | null;
  instanceId: string;
  modules: string[];
  features: string[];
  expires: number | null;
  watermark: string | null;
}

export function journalPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[JOURNAL_FILE_ENV] ?? "").trim();
  if (raw) return raw;
  return path.join(resolvePaperclipInstanceRoot(), "data", "licensing", "issued.jsonl");
}

export function appendJournal(
  entry: Omit<IssuedLicenseRecord, "id" | "issuedAt">,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): IssuedLicenseRecord {
  const record: IssuedLicenseRecord = { id: randomUUID(), issuedAt: now.toISOString(), ...entry };
  const file = journalPath(env);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
  return record;
}

/** Newest first; malformed lines are skipped, a missing file is an empty list. */
export function readJournal(env: NodeJS.ProcessEnv = process.env, limit = 200): IssuedLicenseRecord[] {
  let text: string;
  try {
    text = readFileSync(journalPath(env), "utf8");
  } catch {
    return [];
  }
  const out: IssuedLicenseRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as IssuedLicenseRecord;
      if (r && typeof r.id === "string" && typeof r.instanceId === "string") out.push(r);
    } catch {
      // skip a damaged line
    }
  }
  return out.reverse().slice(0, limit);
}
