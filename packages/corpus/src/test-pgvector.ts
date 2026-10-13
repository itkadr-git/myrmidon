/**
 * Test helpers for the corpus package.
 *
 * `installPgvectorIntoEmbeddedCluster` makes pgvector available to the
 * embedded-postgres test cluster used by the store/queue tests. The
 * embedded-postgres binaries do not ship pgvector (it is a third-party
 * extension), so the helper downloads the official Debian trixie
 * postgresql-18-pgvector package (pgvector 0.8.7 — the pilot-proven version),
 * extracts `vector.so` and the extension SQL/control files into the
 * embedded-postgres native tree ($libdir and the extension dir), and returns
 * a cleanup handle. The deb's files are cached under the OS temp dir so
 * repeated runs are offline. Tests skip with a clear reason when the shim
 * cannot run (non-linux host, no network).
 *
 * Production databases run a pgvector-enabled PostgreSQL 18 image (pilot
 * OPE-5004), so this shim exists only for the test environment.
 */
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const PGVECTOR_DEB_VERSION = process.env.CORPUS_TEST_PGVECTOR_DEB_VERSION ?? "0.8.7-1";
const PGVECTOR_DEB_URL = `https://deb.debian.org/debian/pool/main/p/pgvector/postgresql-18-pgvector_${PGVECTOR_DEB_VERSION}_amd64.deb`;

export type PgvectorInstall = {
  ok: boolean;
  reason?: string;
  /** Removes the copied files from the cluster tree (cache is kept). */
  cleanup(): Promise<void>;
};

function embeddedPostgresNativeRoot(): string | null {
  try {
    const entry = require.resolve("embedded-postgres");
    const packageRoot = path.dirname(path.dirname(entry));
    const archDir = `linux-${process.arch === "x64" ? "x64" : process.arch}`;
    return path.resolve(packageRoot, "..", "@embedded-postgres", archDir, "native");
  } catch {
    return null;
  }
}

async function ensurePgvectorDeb(cacheDir: string): Promise<string | null> {
  const debPath = path.join(cacheDir, `postgresql-18-pgvector_${PGVECTOR_DEB_VERSION}_amd64.deb`);
  if (existsSync(debPath)) return debPath;
  await mkdir(cacheDir, { recursive: true });
  try {
    const response = await fetch(PGVECTOR_DEB_URL);
    if (!response.ok || !response.body) return null;
    await pipeline(response.body, createWriteStream(debPath));
    return debPath;
  } catch {
    return null;
  }
}

export async function installPgvectorIntoEmbeddedCluster(): Promise<PgvectorInstall> {
  const noop = async () => {};
  if (process.platform !== "linux" || process.arch !== "x64") {
    return { ok: false, reason: "pgvector test shim supports linux x64 only", cleanup: noop };
  }
  const nativeRoot = embeddedPostgresNativeRoot();
  if (!nativeRoot || !existsSync(nativeRoot)) {
    return { ok: false, reason: "embedded-postgres native runtime not found", cleanup: noop };
  }

  const libDir = path.join(nativeRoot, "lib", "postgresql");
  const extDir = path.join(nativeRoot, "share", "postgresql", "extension");
  if (existsSync(path.join(libDir, "vector.so")) && existsSync(path.join(extDir, "vector.control"))) {
    return { ok: true, cleanup: noop };
  }

  const cacheDir = path.join(os.tmpdir(), "corpus-pgvector-cache");
  const deb = await ensurePgvectorDeb(cacheDir);
  if (!deb) {
    return {
      ok: false,
      reason: `pgvector deb unavailable (${PGVECTOR_DEB_URL})`,
      cleanup: noop,
    };
  }

  const extractDir = path.join(cacheDir, "extract");
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  try {
    await execFileAsync("ar", ["x", deb, "data.tar.xz"], { cwd: extractDir });
    await execFileAsync("tar", ["xJf", path.join(extractDir, "data.tar.xz"), "-C", extractDir]);
  } catch (error) {
    return { ok: false, reason: `pgvector deb extract failed: ${String(error)}`, cleanup: noop };
  }

  const debLibDir = path.join(extractDir, "usr", "lib", "postgresql", "18", "lib");
  const debExtDir = path.join(extractDir, "usr", "share", "postgresql", "18", "extension");
  if (!existsSync(path.join(debLibDir, "vector.so")) || !existsSync(path.join(debExtDir, "vector.control"))) {
    return { ok: false, reason: "pgvector deb layout unexpected", cleanup: noop };
  }

  const copied: string[] = [];
  await mkdir(libDir, { recursive: true });
  await mkdir(extDir, { recursive: true });
  const vectorSo = path.join(libDir, "vector.so");
  await cp(path.join(debLibDir, "vector.so"), vectorSo);
  copied.push(vectorSo);
  for (const entry of await readdir(debExtDir)) {
    if (!entry.startsWith("vector")) continue;
    const dst = path.join(extDir, entry);
    await cp(path.join(debExtDir, entry), dst);
    copied.push(dst);
  }

  return {
    ok: true,
    cleanup: async () => {
      await Promise.all(copied.map((file) => rm(file, { force: true })));
    },
  };
}
