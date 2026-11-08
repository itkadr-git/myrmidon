import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, copyFile } from "node:fs/promises";
import path from "node:path";

export type FileEntry = { path: string; sizeBytes: number; sha256: string };

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * Hashes every regular file below root. Symlinks and special files are refused:
 * a link could point outside the tree and make the copy read or write there.
 */
export async function inventoryDirectory(root: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing symlink in source files: ${relative}`);
      }
      if (stats.isDirectory()) {
        await visit(absolute);
      } else if (stats.isFile()) {
        entries.push({ path: relative, sizeBytes: stats.size, sha256: await hashFile(absolute) });
      } else {
        throw new Error(`Refusing non-regular file in source files: ${relative}`);
      }
    }
  }
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Source files path is not a plain directory: ${root}`);
  }
  await visit(root);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function manifestDigest(entries: FileEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(`${entry.path}\0${entry.sizeBytes}\0${entry.sha256}\n`);
  return hash.digest("hex");
}

/** Normalizes an object key the way the local-disk storage provider does; null when invalid. */
export function normalizeObjectKey(objectKey: string): string | null {
  const normalized = objectKey.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/")) return null;
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

/** Resolves a manifest-relative path inside root or throws (traversal guard). */
export function resolveWithin(root: string, relative: string): string {
  if (relative.includes("\0") || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
    throw new Error(`Refusing unsafe path in manifest: ${relative}`);
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Refusing path outside the target directory: ${relative}`);
  }
  return resolved;
}

async function existingKind(p: string): Promise<"none" | "file" | "other"> {
  try {
    const stats = await lstat(p);
    return stats.isFile() && !stats.isSymbolicLink() ? "file" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw error;
  }
}

export type CopyResult = { copied: number; skippedIdentical: number; createdDirs: string[] };

/**
 * Copies manifest entries into targetRoot. A file that already exists is kept
 * only when its hash equals the manifest entry (resume); anything else aborts.
 * Each file is written to a temporary name, verified and renamed into place.
 * `afterFile` is a seam for failure injection in tests.
 */
export async function copyManifest(
  sourceRoot: string,
  targetRoot: string,
  entries: FileEntry[],
  hooks: { afterFile?: (index: number) => void } = {},
): Promise<CopyResult> {
  const createdDirs: string[] = [];
  let copied = 0;
  let skippedIdentical = 0;
  for (const [index, entry] of entries.entries()) {
    const from = resolveWithin(sourceRoot, entry.path);
    const to = resolveWithin(targetRoot, entry.path);
    const kind = await existingKind(to);
    if (kind === "other") throw new Error(`Refusing to overwrite a non-regular target path: ${entry.path}`);
    if (kind === "file") {
      if ((await hashFile(to)) !== entry.sha256) {
        throw new Error(`Target file exists with different content: ${entry.path}`);
      }
      skippedIdentical += 1;
    } else {
      let dir = path.dirname(to);
      const missing: string[] = [];
      while (dir !== path.resolve(targetRoot) && (await existingKind(dir)) === "none") {
        missing.unshift(dir);
        dir = path.dirname(dir);
      }
      await mkdir(path.dirname(to), { recursive: true });
      for (const created of missing) createdDirs.push(path.relative(path.resolve(targetRoot), created).split(path.sep).join("/"));
      const tmp = `${to}.migrate-tmp`;
      await rm(tmp, { force: true });
      await copyFile(from, tmp);
      if ((await hashFile(tmp)) !== entry.sha256) {
        await rm(tmp, { force: true });
        throw new Error(`Hash mismatch after copying ${entry.path}; the source file changed during the run.`);
      }
      await rename(tmp, to);
      copied += 1;
    }
    hooks.afterFile?.(index);
  }
  return { copied, skippedIdentical, createdDirs };
}

/** Verifies every manifest entry in targetRoot; returns the list of problems. */
export async function verifyManifest(targetRoot: string, entries: FileEntry[]): Promise<string[]> {
  const problems: string[] = [];
  for (const entry of entries) {
    const to = resolveWithin(targetRoot, entry.path);
    if ((await existingKind(to)) !== "file") {
      problems.push(`missing:${entry.path}`);
    } else if ((await hashFile(to)) !== entry.sha256) {
      problems.push(`hash-mismatch:${entry.path}`);
    }
  }
  return problems;
}
