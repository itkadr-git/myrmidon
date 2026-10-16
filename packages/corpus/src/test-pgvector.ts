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
 * The archive tools run with `LD_LIBRARY_PATH` stripped (`extractionEnv`): the embedded-postgres
 * helper prepends its native lib dir to that variable, and the dir ships an older `liblzma.so.5`
 * (XZ_5.3), which makes the system `xz` fail with ``version `XZ_5.4' not found`` and `tar -J` exit
 * non-zero — the same trap the repo's rootless runner script avoids with `env -u LD_LIBRARY_PATH`.
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

/**
 * Environment handed to the archive tools.
 *
 * `@paperclipai/db`'s embedded-postgres helper prepends its native lib dir to `LD_LIBRARY_PATH`,
 * and that dir carries an older `liblzma.so.5` (`XZ_5.3`): the system `xz` then refuses to start
 * (`version `XZ_5.4' not found`) and `tar -J` exits 1, which reads as "the package cannot be
 * extracted" rather than "the tool inherited a library path". Both loader variables are dropped for
 * the duration of the command — the same treatment the repo's rootless runner script gives
 * `dpkg-deb` with `env -u LD_LIBRARY_PATH`. The input is never mutated: a copy is returned.
 */
export function extractionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  delete clean.LD_LIBRARY_PATH;
  delete clean.DYLD_LIBRARY_PATH;
  return clean;
}

/**
 * Name of the deb's payload member, read from `ar t` output. Not hard-coded: the compressor depends
 * on the distribution's build settings (`data.tar.xz` for the trixie package this shim pins,
 * `data.tar.zst` elsewhere) and a wrong name fails the whole install.
 */
export function pickDebDataMember(listing: string): string | null {
  const members = listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return members.find((name) => /^data\.tar(\.[a-z0-9]+)?$/.test(name)) ?? null;
}

/** `tar` arguments that unpack the member, or `null` when its compression is not supported. */
export function tarFlagsForDataMember(member: string): string[] | null {
  if (member.endsWith(".tar.xz")) return ["xJf"];
  if (member.endsWith(".tar.gz")) return ["xzf"];
  if (member.endsWith(".tar.zst")) return ["--zstd", "xf"];
  if (member.endsWith(".tar")) return ["xf"];
  return null;
}

/**
 * Text of a failed child process. `String(error)` keeps the command line but drops `stderr`, which
 * is where `xz`, `tar` and `ar` say what actually went wrong — the reason a first CI run of this
 * shim could only report "extract failed".
 */
export function childProcessErrorDetail(error: unknown): string {
  const message =
    error instanceof Error && error.message.trim() !== "" ? error.message.trim() : String(error);
  const stderr = (error as { stderr?: unknown } | null | undefined)?.stderr;
  const stderrText =
    typeof stderr === "string"
      ? stderr.trim()
      : stderr instanceof Uint8Array
        ? Buffer.from(stderr).toString("utf8").trim()
        : "";
  return stderrText === "" ? message : `${message} — ${stderrText}`;
}

async function ensurePgvectorDeb(cacheDir: string): Promise<string | null> {
  const debPath = path.join(cacheDir, `postgresql-18-pgvector_${PGVECTOR_DEB_VERSION}_amd64.deb`);
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
  // Archive tools run on a copy of the environment with the loader paths removed: an inherited
  // `LD_LIBRARY_PATH` makes `xz` load the embedded-postgres copy of `liblzma` and fail.
  const toolEnv = extractionEnv(process.env);
  let dataMember: string;
  try {
    const listing = await execFileAsync("ar", ["t", deb], { env: toolEnv });
    const member = pickDebDataMember(String(listing.stdout));
    if (member === null) {
      return {
        ok: false,
        reason: `pgvector deb has no data.tar member: ${String(listing.stdout).trim().replace(/\s+/g, " ")}`,
        cleanup: noop,
      };
    }
    dataMember = member;
  } catch (error) {
    return { ok: false, reason: `pgvector deb listing failed: ${childProcessErrorDetail(error)}`, cleanup: noop };
  }
  const tarFlags = tarFlagsForDataMember(dataMember);
  if (tarFlags === null) {
    return {
      ok: false,
      reason: `pgvector deb data member ${dataMember} uses an unsupported compression`,
      cleanup: noop,
    };
  }
  try {
    await execFileAsync("ar", ["x", deb, dataMember], { cwd: extractDir, env: toolEnv });
    await execFileAsync("tar", [...tarFlags, path.join(extractDir, dataMember), "-C", extractDir], {
      env: toolEnv,
    });
  } catch (error) {
    return { ok: false, reason: `pgvector deb extract failed: ${childProcessErrorDetail(error)}`, cleanup: noop };
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
