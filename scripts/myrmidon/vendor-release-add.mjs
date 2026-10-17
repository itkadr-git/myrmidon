#!/usr/bin/env node
// Adds a Paperclip release to the list of source releases that `myrmidon migrate`
// accepts, or checks that the list is complete.
//
//   node scripts/myrmidon/vendor-release-add.mjs v2026.1012.0   # add (or refresh) one release
//   node scripts/myrmidon/vendor-release-add.mjs --regen        # rebuild the file from its own list
//   node scripts/myrmidon/vendor-release-add.mjs --check-latest # exit 1 if the newest Paperclip release is not listed
//
// What it does for a release tag: reads the migration journal and the migration
// folder of paperclipai/paperclip at that tag (through `gh api`), proves that the
// first 278 migrations are byte-identical to the ones in this tree (git blob ids),
// and pins the tag and sha256 of every migration after them, together with the
// tables and columns those migrations add. The result goes to
// cli/src/commands/myrmidon-migrate-vendor-releases.ts. Needs `gh` logged in
// (or GH_TOKEN) and nothing else; it never touches a database.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS_DIR = path.join(ROOT, "packages/db/src/migrations");
const OUT_FILE = path.join(ROOT, "cli/src/commands/myrmidon-migrate-vendor-releases.ts");
const UPSTREAM = process.env.PAPERCLIP_UPSTREAM_REPO || "paperclipai/paperclip";
const BASE_RELEASE = "v2026.916.1";
const BASE_LAST_IDX = 279;
const BASE_LENGTH = 278;
const UPSTREAM_MIGRATIONS = "packages/db/src/migrations";

function gh(args) {
  return execFileSync("gh", ["api", ...args], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
}
const ghJson = (url) => JSON.parse(gh([url]).toString("utf8"));
const ghRaw = (url) => gh(["-H", "Accept: application/vnd.github.raw", url]);

const gitBlobSha = (buf) =>
  createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Tables created and columns added by one migration file (drizzle statement-per-ALTER layout). */
export function parseMigrationSql(text) {
  const tables = new Set();
  const columns = new Set();
  const name = String.raw`(?:"public"\.)?"([^"]+)"`;
  for (const raw of text.split("--> statement-breakpoint")) {
    const stmt = raw.trim();
    for (const m of stmt.matchAll(new RegExp(String.raw`CREATE TABLE (?:IF NOT EXISTS )?${name}`, "gi"))) tables.add(m[1]);
    const alter = new RegExp(String.raw`^ALTER TABLE (?:ONLY )?(?:IF EXISTS )?${name}`, "i").exec(stmt);
    if (alter) {
      const table = alter[1];
      for (const m of stmt.matchAll(/ADD COLUMN (?:IF NOT EXISTS )?"([^"]+)"/gi)) columns.add(`${table}.${m[1]}`);
      for (const m of stmt.matchAll(/RENAME COLUMN "[^"]+" TO "([^"]+)"/gi)) columns.add(`${table}.${m[1]}`);
    }
  }
  return { tables: [...tables].sort(), columns: [...columns].sort() };
}

function readLocalJournal() {
  return JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")).entries;
}

function buildRelease(tag, local) {
  const ref = encodeURIComponent(tag);
  const journal = JSON.parse(ghRaw(`repos/${UPSTREAM}/contents/${UPSTREAM_MIGRATIONS}/meta/_journal.json?ref=${ref}`).toString("utf8")).entries;
  const listing = ghJson(`repos/${UPSTREAM}/contents/${UPSTREAM_MIGRATIONS}?ref=${ref}&per_page=100`);
  // The contents API returns up to 1000 entries for a directory; ours is far below that.
  const blobByName = new Map(listing.map((f) => [f.name, f.sha]));

  const base = journal.filter((e) => e.idx <= BASE_LAST_IDX);
  const extra = journal.filter((e) => e.idx > BASE_LAST_IDX);
  if (base.length !== BASE_LENGTH) throw new Error(`${tag}: expected ${BASE_LENGTH} migrations up to idx ${BASE_LAST_IDX}, found ${base.length}`);
  const localBase = local.filter((e) => e.idx <= BASE_LAST_IDX);
  base.forEach((e, i) => {
    if (e.tag !== localBase[i].tag) throw new Error(`${tag}: migration #${i} is ${e.tag}, this tree has ${localBase[i].tag}`);
    const want = blobByName.get(`${e.tag}.sql`);
    const have = gitBlobSha(readFileSync(path.join(MIGRATIONS_DIR, `${e.tag}.sql`)));
    if (want !== have) throw new Error(`${tag}: ${e.tag}.sql differs from this tree (git blob ${want} vs ${have})`);
  });

  const entries = extra.map((e) => {
    const buf = ghRaw(`repos/${UPSTREAM}/contents/${UPSTREAM_MIGRATIONS}/${e.tag}.sql?ref=${ref}`);
    if (gitBlobSha(buf) !== blobByName.get(`${e.tag}.sql`)) throw new Error(`${tag}: ${e.tag}.sql download does not match its git blob id`);
    const parsed = parseMigrationSql(buf.toString("utf8"));
    return { tag: e.tag, sha256: sha256(buf), when: e.when, tables: parsed.tables, columns: parsed.columns };
  });
  return { release: tag, extra: entries };
}

const HEADER = "// releases:";

function readListedTags(file) {
  try {
    const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(HEADER));
    return line ? line.slice(HEADER.length).trim().split(/\s+/).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const tagKey = (t) => t.replace(/^v/, "").split(".").map(Number);
function byVersion(a, b) {
  const x = tagKey(a);
  const y = tagKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

const list = (a) => (a.length === 0 ? "[]" : `[${a.map((s) => JSON.stringify(s)).join(", ")}]`);

function render(releases) {
  const out = [];
  out.push("// GENERATED by scripts/myrmidon/vendor-release-add.mjs; do not edit by hand.");
  out.push("// To support a new Paperclip release run: node scripts/myrmidon/vendor-release-add.mjs <tag>");
  out.push(`${HEADER} ${releases.map((r) => r.release).join(" ")}`);
  out.push('import type { VendorReleaseExtra } from "./myrmidon-migrate-vendor-chain.js";');
  out.push("");
  out.push("// For every supported release after the base one: the migrations that come after the shared first 278,");
  out.push("// each with the sha256 of its SQL file, and the tables and columns that migration adds.");
  out.push("export const VENDOR_EXTRA_RELEASES: ReadonlyArray<VendorReleaseExtra> = [");
  for (const r of releases) {
    out.push("  {");
    out.push(`    release: ${JSON.stringify(r.release)},`);
    out.push("    extra: [");
    for (const e of r.extra) {
      out.push("      {");
      out.push(`        tag: ${JSON.stringify(e.tag)},`);
      out.push(`        sha256: ${JSON.stringify(e.sha256)},`);
      out.push(`        when: ${e.when},`);
      out.push(`        tables: ${list(e.tables)},`);
      out.push(`        columns: ${list(e.columns)},`);
      out.push("      },");
    }
    out.push("    ],");
    out.push("  },");
  }
  out.push("];");
  out.push("");
  return out.join("\n");
}

function loadExisting(file) {
  // The previous file is the cache for releases that are not being refreshed.
  const text = (() => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  })();
  const m = /export const VENDOR_EXTRA_RELEASES[^=]*= (\[[\s\S]*\]);\s*$/.exec(text);
  if (!m) return new Map();
  const releases = new Function(`return ${m[1]}`)();
  return new Map(releases.map((r) => [r.release, r]));
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--check-latest")) {
    const latest = JSON.parse(gh([`repos/${UPSTREAM}/releases/latest`]).toString("utf8")).tag_name;
    const listed = new Set([BASE_RELEASE, ...readListedTags(OUT_FILE)]);
    if (!listed.has(latest)) {
      console.error(`Paperclip released ${latest}, which "myrmidon migrate" does not accept yet.`);
      console.error(`Supported source releases: ${[...listed].sort(byVersion).join(", ")}.`);
      console.error(`Add it: node scripts/myrmidon/vendor-release-add.mjs ${latest}`);
      console.error("then run the cli tests and commit the regenerated file cli/src/commands/myrmidon-migrate-vendor-releases.ts.");
      process.exit(1);
    }
    console.log(`Paperclip latest release ${latest} is supported.`);
    return;
  }
  const regen = args.includes("--regen");
  const tags = args.filter((a) => !a.startsWith("--"));
  const existing = loadExisting(OUT_FILE);
  const listed = readListedTags(OUT_FILE);
  const want = new Set([...listed, ...tags]);
  want.delete(BASE_RELEASE);
  if (tags.length === 0 && !regen) {
    console.error("usage: vendor-release-add.mjs <tag>... | --regen | --check-latest");
    process.exit(2);
  }
  const local = readLocalJournal();
  const releases = [];
  for (const tag of [...want].sort(byVersion)) {
    const refresh = regen || tags.includes(tag) || !existing.has(tag);
    releases.push(refresh ? buildRelease(tag, local) : existing.get(tag));
    console.error(`${tag}: ${refresh ? "read from upstream" : "kept"}`);
  }
  writeFileSync(OUT_FILE, render(releases));
  console.error(`wrote ${path.relative(ROOT, OUT_FILE)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv);
