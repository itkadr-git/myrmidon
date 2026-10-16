// myrmidon(LICENSING): the installation id shown by the board and used as the
// `instance_id` of a module license.
//
// The algorithm is byte-for-byte the one the closed connector modules use to
// decide which installation a license belongs to (their `instance-id`
// command): an explicit override, else SHA-256 of the machine id, else a
// generated id cached in a state file. Both sides must resolve the same
// string on the same machine, otherwise a license issued from the board would
// never be accepted by the modules. Do NOT change this file in isolation: a
// change of the source of the id is a synchronized change on both sides.
//
// The raw machine id is never returned or logged; only its truncated hash.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const LICENSE_INSTANCE_ID_ENV = "MYR_LICENSE_INSTANCE_ID";
export const LICENSE_STATE_DIR_ENV = "MYR_LICENSE_STATE_DIR";
export const DEFAULT_STATE_DIR = "~/.local/state/myrmidon-license";
export const MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"] as const;
export const INSTALL_ID_PREFIX = "myr-";
export const INSTALL_ID_HEX_LEN = 20;

export type InstallIdSource = "env" | "machine-id" | "generated";

export interface InstallId {
  installId: string;
  source: InstallIdSource;
}

export interface InstallIdOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam: where the machine id files live. */
  machineIdPaths?: readonly string[];
}

/** `myr-` + the first 20 hex chars of SHA-256 over the stripped UTF-8 text. */
export function hashToInstallId(raw: string): string {
  const digest = createHash("sha256").update(raw.trim(), "utf8").digest("hex");
  return INSTALL_ID_PREFIX + digest.slice(0, INSTALL_ID_HEX_LEN);
}

function readMachineId(paths: readonly string[]): string | null {
  for (const file of paths) {
    try {
      const value = readFileSync(file, "utf8").trim();
      if (value) return value;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function expandHome(raw: string): string {
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function cachedOrGenerated(env: NodeJS.ProcessEnv): string {
  const dir = expandHome((env[LICENSE_STATE_DIR_ENV] ?? "").trim() || DEFAULT_STATE_DIR);
  const file = path.join(dir, "instance-id");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // no cache yet
  }
  const generated = randomUUID().replace(/-/g, "");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, generated + "\n", "utf8");
  } catch {
    // best-effort cache, same as the module side
  }
  return generated;
}

export function resolveInstallId(options: InstallIdOptions = {}): InstallId {
  const env = options.env ?? process.env;
  const override = (env[LICENSE_INSTANCE_ID_ENV] ?? "").trim();
  if (override) return { installId: override, source: "env" };
  const machineId = readMachineId(options.machineIdPaths ?? MACHINE_ID_PATHS);
  if (machineId) return { installId: hashToInstallId(machineId), source: "machine-id" };
  return { installId: hashToInstallId(cachedOrGenerated(env)), source: "generated" };
}
