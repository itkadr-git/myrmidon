import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import type { Db } from "@myrmidon/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { resolveManagedInstructionsRoot } from "./agent-instructions.js";
import { resolveManagedSkillsRoot } from "./company-skills.js";
import { companyTransferRunService, type MigrationManagedDirectory } from "./company-transfer-runs.js";

function managedRoot(companyId: string, directory: MigrationManagedDirectory) {
  return directory.kind === "company_skills" ? resolveManagedSkillsRoot(companyId)
    : resolveManagedInstructionsRoot({ companyId, id: directory.agentId });
}

function relativeWithin(root: string, target: string) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Invalid managed migration path");
  }
  return relative;
}

function absent(error: NodeJS.ErrnoException) {
  if (error.code === "ENOENT") return null;
  throw error;
}

async function checkedParent(file: string, create: boolean) {
  const root = resolvePaperclipInstanceRoot();
  let current = root;
  if (create) await mkdir(root, { recursive: true });
  for (const segment of relativeWithin(root, file).split(path.sep).slice(0, -1)) {
    current = path.join(current, segment);
    if (create) await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const entry = await lstat(current).catch(absent);
    if (!entry) return false;
    if (!entry.isDirectory()) throw new Error("Invalid managed migration directory");
  }
  return true;
}

function digest(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function fileIdentity(stat: { dev: bigint; ino: bigint }) {
  return `${stat.dev}:${stat.ino}`;
}

export function migrationManagedFileWriter(db: Db, runId: string, companyId: string, directory: MigrationManagedDirectory) {
  return async (file: string, content: string) => {
    const relative = relativeWithin(managedRoot(companyId, directory), file).split(path.sep).join("/");
    await checkedParent(file, true);
    // Publish atomically without replacing an independently created file. The
    // journal identifies the inode as well as its bytes, even before publish.
    const stagingId = randomUUID();
    const staging = path.join(path.dirname(file), `.migration-${stagingId}`);
    const handle = await open(staging, "wx", 0o600);
    try {
      const identity = fileIdentity(await handle.stat({ bigint: true }));
      const sha256 = digest(content);
      await companyTransferRunService.reserveMigrationManagedFile(db, runId, companyId, directory, relative, sha256, identity, stagingId);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await link(staging, file);
    } finally {
      await handle.close();
      await unlink(staging).catch(absent);
    }
  };
}

export async function matchesJournaledMigrationFile(companyId: string, directory: MigrationManagedDirectory, relativePath: string, sha256: string, identity: string, options?: { allowMissing?: boolean }) {
  const root = managedRoot(companyId, directory);
  const file = path.resolve(root, relativePath);
  relativeWithin(root, file);
  if (!await checkedParent(file, false)) return options?.allowMissing === true;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(absent);
  if (!handle) return options?.allowMissing === true;
  try {
    const entry = await handle.stat({ bigint: true });
    if (!entry.isFile() || fileIdentity(entry) !== identity || digest(await handle.readFile()) !== sha256) return false;
    const current = await lstat(file, { bigint: true }).catch(absent);
    return current?.isFile() === true && fileIdentity(current) === identity && current.ctimeNs === entry.ctimeNs;
  } finally {
    await handle.close();
  }
}

export async function removeJournaledMigrationFile(companyId: string, directory: MigrationManagedDirectory, relativePath: string, sha256: string, identity: string, stagingId: string) {
  const root = managedRoot(companyId, directory);
  const file = path.resolve(root, relativePath);
  relativeWithin(root, file);
  if (!await checkedParent(file, false)) return;
  const staging = path.join(path.dirname(file), `.migration-${stagingId}`);
  const staged = await lstat(staging, { bigint: true }).catch(absent);
  // The random staging name is private to this write and may hold partial bytes.
  if (staged?.isFile() && fileIdentity(staged) === identity) await unlink(staging).catch(absent);
  const entry = await lstat(file, { bigint: true }).catch(absent);
  if (!entry?.isFile() || fileIdentity(entry) !== identity) return;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(absent);
  if (!handle) return;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || fileIdentity(opened) !== identity || digest(await handle.readFile()) !== sha256) return;
    const current = await lstat(file, { bigint: true }).catch(absent);
    if (current?.isFile() && fileIdentity(current) === identity && current.ctimeNs === opened.ctimeNs) {
      await unlink(file).catch(absent);
    }
  } finally {
    await handle.close();
  }
}
