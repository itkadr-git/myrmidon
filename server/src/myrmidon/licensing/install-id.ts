// myrmidon(LICENSING, OPE-8836): the installation id of this board.
//
// There is ONE id and the board owns it. It is stored in the board database
// (`myrmidon_install_identity`) on the first start and never changes after
// that: not with the machine id, not with MYR_LICENSE_INSTANCE_ID, not with a
// re-created container. The licensing screen, the license check, the
// `GET /api/licensing/install-id` route and the `instance-id` file that the
// closed modules read all take the id from the database; nothing else reads
// the machine id.
//
// How the id is chosen, once, when no id is stored yet:
//   1. MYR_LICENSE_INSTANCE_ID, when set;
//   2. `myr-` + the first 20 hex of SHA-256 over the stripped machine id
//      (the same formula and normalisation as before, so licenses issued
//      earlier stay valid);
//   3. `myr-` + 20 hex derived from a random UUID.
//
// The raw machine id is never returned or logged; only its truncated hash.

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { myrmidonInstallIdentity, type Db } from "@myrmidon/db";
import { logger } from "../../middleware/logger.js";
import { licenseFilePath } from "./client-license.js";

export const LICENSE_INSTANCE_ID_ENV = "MYR_LICENSE_INSTANCE_ID";
export const MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"] as const;
export const INSTALL_ID_PREFIX = "myr-";
export const INSTALL_ID_HEX_LEN = 20;
export const INSTALL_ID_FILE_NAME = "instance-id";
const SINGLETON_KEY = "default";

export type InstallIdSource = "env" | "machine-id" | "generated";

export interface InstallId {
  installId: string;
  source: InstallIdSource;
}

/** The one place the board reads the installation id from. */
export type InstallIdProvider = () => Promise<InstallId>;

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

/**
 * The id a board with no stored id would pick right now. Used only for the
 * first start; once an id is stored this is never consulted again.
 */
export function computeInitialInstallId(options: InstallIdOptions = {}): InstallId {
  const env = options.env ?? process.env;
  const override = (env[LICENSE_INSTANCE_ID_ENV] ?? "").trim();
  if (override) return { installId: override, source: "env" };
  const machineId = readMachineId(options.machineIdPaths ?? MACHINE_ID_PATHS);
  if (machineId) return { installId: hashToInstallId(machineId), source: "machine-id" };
  return { installId: hashToInstallId(randomUUID().replace(/-/g, "")), source: "generated" };
}

function isSource(value: string): value is InstallIdSource {
  return value === "env" || value === "machine-id" || value === "generated";
}

/**
 * Returns the stored installation id, creating it on the first call. The
 * insert is `ON CONFLICT DO NOTHING` and the row is read back, so boards that
 * start together agree on the winner and an existing id is never replaced.
 */
export async function ensureInstallId(db: Db, options: InstallIdOptions = {}): Promise<InstallId> {
  const read = async () => {
    const [row] = await db
      .select()
      .from(myrmidonInstallIdentity)
      .where(eq(myrmidonInstallIdentity.singletonKey, SINGLETON_KEY))
      .limit(1);
    return row ?? null;
  };
  let row = await read();
  if (!row) {
    const initial = computeInitialInstallId(options);
    await db
      .insert(myrmidonInstallIdentity)
      .values({ singletonKey: SINGLETON_KEY, installId: initial.installId, source: initial.source })
      .onConflictDoNothing();
    row = await read();
    if (!row) throw new Error("installation id was not stored");
    if (row.installId === initial.installId) {
      logger.info({ installId: row.installId, source: row.source }, "licensing: installation id created");
    }
  }
  return { installId: row.installId, source: isSource(row.source) ? row.source : "generated" };
}

/** Where the `instance-id` file for the modules lives: next to the license file. */
export function installIdFilePath(env: NodeJS.ProcessEnv): string {
  return path.join(path.dirname(licenseFilePath(env)), INSTALL_ID_FILE_NAME);
}

/**
 * Writes `<license dir>/instance-id` (the id and a newline, mode 0644)
 * atomically: a temporary file in the same directory, then a rename. Never
 * throws; returns false and logs a warning when the directory is not writable,
 * so a board without the license directory still starts.
 */
export function writeInstallIdFile(installId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const target = installIdFilePath(env);
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    const fd = openSync(tmp, "w", 0o644);
    try {
      writeSync(fd, `${installId}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o644); // the umask must not narrow it
    renameSync(tmp, target);
    return true;
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing to clean up
    }
    logger.warn(
      { path: target, code: (err as NodeJS.ErrnoException).code ?? "unknown" },
      "licensing: cannot write the installation id file; modules will not see the board id",
    );
    return false;
  }
}

const providers = new WeakMap<object, InstallIdProvider>();

/**
 * The board's provider: reads the id from the database once and keeps it in
 * memory (it never changes). One provider per database handle.
 */
export function installIdProviderFor(db: Db, options: InstallIdOptions = {}): InstallIdProvider {
  const existing = providers.get(db);
  if (existing) return existing;
  let pending: Promise<InstallId> | null = null;
  const provider: InstallIdProvider = () => {
    if (!pending) {
      pending = ensureInstallId(db, options).catch((err) => {
        pending = null; // retry on the next call
        throw err;
      });
    }
    return pending;
  };
  providers.set(db, provider);
  return provider;
}

/** Start-up step: make sure the id exists and publish it for the modules. */
export async function startInstallId(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<InstallId> {
  const id = await installIdProviderFor(db, { env })();
  writeInstallIdFile(id.installId, env);
  return id;
}
