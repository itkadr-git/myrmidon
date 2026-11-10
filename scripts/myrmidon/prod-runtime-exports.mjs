#!/usr/bin/env node
// Point workspace-package entry fields at the built `dist` output for
// production image builds — the same substitution npm/pnpm perform through
// `publishConfig` when a package is published.
//
// Usage:
//   node scripts/myrmidon/prod-runtime-exports.mjs apply --entry @myrmidon/server [--root <dir>] [--dry-run]
//   node scripts/myrmidon/prod-runtime-exports.mjs restore [--root <dir>]
//
// The `exports` field of every workspace package in the production closure of
// the entry points at `./src/*.ts` (dev mode under tsx), while
// `publishConfig.exports` points at the built `./dist/*.js`. `apply` copies the
// `publishConfig` values of `main`/`types`/`exports` to the top level of each
// `package.json` in the closure, saving the originals for `restore`. No
// bundling: the server build keeps per-file modules and resolves workspace
// packages exactly like the published server does. `bin` is deliberately not
// substituted, `workspace:` versions are not rewritten and `publishConfig` is
// kept (OPE-12670).
//
// For image builds and CI only: it rewrites `package.json` files in the
// working tree, so never run `apply` in a development checkout.
//
// Exit codes: 0 ok, 1 usage/lookup errors, 2 preflight failure (missing
// `dist`), 3 package or backup state errors.
// No dependencies: Node built-ins only.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Fields a publish substitutes from `publishConfig` (minus `bin`, see above). */
const PUBLISH_KEYS = ["main", "types", "exports"];
/** Closure is walked through these sections only; devDependencies are not followed. */
const DEP_SECTIONS = ["dependencies", "optionalDependencies"];
const BACKUP_RELATIVE = join("node_modules", ".cache", "myrmidon-prod-exports", "backup.json");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function toPosix(p) {
  return p.split("\\").join("/");
}

function posixRelative(root, p) {
  return toPosix(relative(root, p));
}

function backupPath(root) {
  return join(root, BACKUP_RELATIVE);
}

/** Serializes a manifest the way the repo does: two-space indent, trailing newline. */
function serialize(pkg) {
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Parses the block-sequence `packages:` globs of pnpm-workspace.yaml (line matching, as in build-standalone-public-packages.mjs). */
export function parseWorkspaceGlobs(text) {
  const keyAt = text.indexOf("packages:");
  if (keyAt < 0) return [];
  const rest = text.slice(keyAt + "packages:".length);
  const nextKey = rest.search(/^[A-Za-z]/m);
  const block = nextKey >= 0 ? rest.slice(0, nextKey) : rest;
  return [...block.matchAll(/^\s*-\s*["']?([^"'\n]+?)["']?\s*$/gm)]
    .map((m) => m[1].trim())
    .filter((entry) => entry.length > 0);
}

/** Glob → RegExp on forward-slash-relative paths; `*` stays within a segment, `**` spans (as in build-standalone-public-packages.mjs). */
export function globToRegExp(pattern) {
  let regex = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      regex += ".*";
      i += 1;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    regex += /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${regex}$`);
}

function hasPackageJson(dir) {
  return existsSync(join(dir, "package.json"));
}

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Collects package dirs matched by one include glob; the wildcard must be the last segment. */
function expandIncludeGlob(root, glob) {
  const segments = glob.split("/");
  const wildcardAt = segments.findIndex((s) => s.includes("*"));
  if (wildcardAt < 0) {
    const dir = join(root, ...segments);
    return hasPackageJson(dir) ? [dir] : [];
  }
  if (wildcardAt !== segments.length - 1) {
    throw new Error(`Unsupported workspace glob (wildcard must be the last segment): ${glob}`);
  }
  const base = join(root, ...segments.slice(0, wildcardAt));
  if (!isDirectory(base)) return [];
  const pattern = segments[wildcardAt];
  if (pattern === "*") {
    const dirs = [];
    for (const entry of readdirSorted(base)) {
      const dir = join(base, entry);
      if (isDirectory(dir) && hasPackageJson(dir)) dirs.push(dir);
    }
    return dirs;
  }
  if (pattern === "**") {
    // Nearest package.json wins: do not descend into a matched package; skip node_modules.
    const dirs = [];
    const walk = (dir) => {
      for (const entry of readdirSorted(dir)) {
        if (entry === "node_modules") continue;
        const child = join(dir, entry);
        if (!isDirectory(child)) continue;
        if (hasPackageJson(child)) dirs.push(child);
        else walk(child);
      }
    };
    walk(base);
    return dirs;
  }
  throw new Error(`Unsupported workspace glob segment "${pattern}" in: ${glob}`);
}

function readdirSorted(dir) {
  return readdirSync(dir).sort();
}

/** Workspace member dirs (absolute) under `root`, mirroring pnpm-workspace.yaml include/exclude globs. */
export function workspacePackageDirs(root, { workspaceFile = join(root, "pnpm-workspace.yaml") } = {}) {
  if (!existsSync(workspaceFile)) return [];
  const entries = parseWorkspaceGlobs(readFileSync(workspaceFile, "utf8"));
  const includes = entries.filter((e) => !e.startsWith("!"));
  const excludes = entries.filter((e) => e.startsWith("!")).map((e) => e.slice(1));
  const excludeRegexps = excludes.map((ex) => {
    const re = globToRegExp(ex);
    // A trailing `/**` negation also removes the directory itself (`a/**`
    // matches `a/x` and deeper but not `a`).
    return ex.endsWith("/**") ? [re, globToRegExp(ex.slice(0, -3))] : [re];
  }).flat();
  const isExcluded = (rel) => excludeRegexps.some((re) => re.test(rel));
  const dirs = new Set();
  for (const glob of includes) {
    for (const dir of expandIncludeGlob(root, glob)) {
      if (!isExcluded(posixRelative(root, dir))) dirs.add(dir);
    }
  }
  return [...dirs].sort();
}

/** package name → package dir for every workspace member. */
export function buildPackageIndex(root) {
  const index = new Map();
  for (const dir of workspacePackageDirs(root)) {
    const pkg = readJson(join(dir, "package.json"));
    if (typeof pkg.name === "string" && pkg.name.length > 0 && !index.has(pkg.name)) {
      index.set(pkg.name, dir);
    }
  }
  return index;
}

/**
 * Walks `dependencies` + `optionalDependencies` (`workspace:` specs only) from
 * `entry`, transitively; devDependencies are not followed. The entry itself is
 * part of the closure even though nothing depends on it.
 */
export function collectWorkspaceClosure(entry, index) {
  if (!index.has(entry)) {
    throw new Error(`Entry package ${entry} not found in the workspace`);
  }
  const closure = new Map();
  const queue = [entry];
  while (queue.length > 0) {
    const name = queue.shift();
    if (closure.has(name)) continue;
    const dir = index.get(name);
    closure.set(name, dir); // undefined for a non-workspace name: not followed further.
    if (dir === undefined) continue;
    const pkg = readJson(join(dir, "package.json"));
    for (const section of DEP_SECTIONS) {
      for (const [dep, spec] of Object.entries(pkg[section] ?? {})) {
        if (typeof spec === "string" && spec.startsWith("workspace:")) {
          if (!index.has(dep)) {
            throw new Error(`workspace dependency ${dep} of ${name} not found in the workspace`);
          }
          queue.push(dep);
        }
      }
    }
  }
  return closure;
}

/** Publish-substitutable fields present in `publishConfig` (never `bin`). */
export function publishOverrides(pkg) {
  const overrides = {};
  const publishConfig = pkg.publishConfig ?? {};
  for (const key of PUBLISH_KEYS) {
    if (publishConfig[key] !== undefined) overrides[key] = publishConfig[key];
  }
  return overrides;
}

/** Applies publish substitution to one manifest text; preserves every other field and the 2-indent format. */
export function applyToText(text, overrides) {
  const pkg = JSON.parse(text);
  for (const [key, value] of Object.entries(overrides)) {
    pkg[key] = value;
  }
  return serialize(pkg);
}

function distMissing(packageDir) {
  return !isDirectory(join(packageDir, "dist"));
}

function loadBackup(root) {
  const file = backupPath(root);
  if (!existsSync(file)) return null;
  return { file, doc: readJson(file) };
}

function saveBackup(root, doc) {
  mkdirSync(dirname(backupPath(root)), { recursive: true });
  writeFileSync(backupPath(root), serialize(doc));
}

/** Backup record for one package: whole original text plus which fields `apply` replaced. */
function makeBackupRecord(root, dir, overrides) {
  return {
    packageFile: posixRelative(root, join(dir, "package.json")),
    originalText: readFileSync(join(dir, "package.json"), "utf8"),
    originalFields: (() => {
      const pkg = readJson(join(dir, "package.json"));
      const fields = {};
      for (const key of PUBLISH_KEYS) {
        if (pkg[key] !== undefined) fields[key] = pkg[key];
      }
      return fields;
    })(),
    appliedFields: Object.keys(overrides),
  };
}

function parseArgs(argv) {
  const args = { command: null, entry: null, root: null, dryRun: false };
  const requireValue = (position, option) => {
    const value = argv[position];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "apply" || arg === "restore") {
      if (args.command !== null) throw new Error(`Duplicate command: ${arg}`);
      args.command = arg;
    } else if (arg === "--entry") {
      if (args.entry !== null) throw new Error("Duplicate --entry");
      args.entry = requireValue(i + 1, arg);
      i += 1;
    } else if (arg === "--root") {
      if (args.root !== null) throw new Error("Duplicate --root");
      args.root = requireValue(i + 1, arg);
      i += 1;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.command === null) {
    throw new Error("Usage: apply --entry <package> [--root <dir>] [--dry-run] | restore [--root <dir>]");
  }
  if (args.command === "apply" && args.entry === null) {
    throw new Error("apply requires --entry <package>");
  }
  if (args.command === "restore" && args.entry !== null) {
    throw new Error("restore takes no --entry");
  }
  return args;
}

function pad(name, width) {
  return name.length >= width ? name : name + " ".repeat(width - name.length);
}

function commandApply(root, entry, dryRun, log) {
  const index = buildPackageIndex(root);
  const closure = collectWorkspaceClosure(entry, index);
  const overridesByPackage = new Map();
  const skipReasons = new Map();
  for (const [name, dir] of closure) {
    // The entry package itself stays as-is: the server manifest is wired in a
    // separate change (Ч1.3), this script handles only its workspace deps.
    if (name === entry) {
      skipReasons.set(name, "entry package");
      continue;
    }
    const pkg = readJson(join(dir, "package.json"));
    const publishConfig = pkg.publishConfig ?? {};
    if (publishConfig.exports === undefined) {
      skipReasons.set(
        name,
        Object.keys(publishOverrides(pkg)).length > 0
          ? "no publishConfig exports"
          : "no publishConfig main/types/exports",
      );
      continue;
    }
    // Gate: substitute only when the package actually deviates from its
    // publish config — `exports` pointing at src vs `publishConfig.exports`
    // pointing at dist. Packages that already serve dist (e.g.
    // @myrmidon/plugin-sdk) are skipped even if main/types differ.
    if (JSON.stringify(pkg.exports ?? null) === JSON.stringify(publishConfig.exports)) {
      skipReasons.set(name, "already serving dist");
      continue;
    }
    overridesByPackage.set(name, publishOverrides(pkg));
  }
  const skipped = [...skipReasons.keys()].sort();
  const substitute = [...overridesByPackage.keys()].sort();

  // Preflight: every package to rewrite needs a `dist` directory; nothing is
  // written otherwise (all-or-nothing).
  const missingDist = substitute.filter((name) => distMissing(index.get(name)));
  if (missingDist.length > 0) {
    for (const name of missingDist) {
      log.error(`no dist: ${name} (${posixRelative(root, index.get(name))})`);
    }
    log.error(`Preflight failed: ${missingDist.length} package(s) without dist; no files were modified.`);
    return 2;
  }

  const existing = loadBackup(root);
  const newRecords = {};
  for (const name of substitute) {
    // An existing backup is never overwritten: a repeated `apply` keeps the
    // first-seen originals so `restore` always returns to the pre-apply state.
    if (existing?.doc.packages[name] !== undefined) continue;
    newRecords[name] = makeBackupRecord(root, index.get(name), overridesByPackage.get(name));
  }
  const doc = existing?.doc ?? { version: 1, packages: {} };
  doc.packages = { ...doc.packages, ...newRecords };

  if (dryRun) {
    for (const name of substitute) {
      const overrides = overridesByPackage.get(name);
      const fields = Object.keys(overrides).join("+");
      const hasDist = distMissing(index.get(name)) ? "NO" : "yes";
      log.log(`${pad(name, 40)}  ${pad(fields, 22)}  dist: ${hasDist}`);
    }
    for (const name of skipped) log.log(`skipped (${skipReasons.get(name)}): ${name}`);
    log.log(`dry-run: ${substitute.length} package(s) to substitute, ${skipped.length} skipped, no files modified.`);
    return 0;
  }

  saveBackup(root, doc);
  for (const name of substitute) {
    const file = join(index.get(name), "package.json");
    const next = applyToText(readFileSync(file, "utf8"), overridesByPackage.get(name));
    if (next !== readFileSync(file, "utf8")) writeFileSync(file, next);
    log.log(`applied: ${name} (${posixRelative(root, file)})`);
  }
  for (const name of skipped) log.log(`skipped (${skipReasons.get(name)}): ${name}`);
  log.log(`apply: ${substitute.length} package.json rewritten; backup: ${posixRelative(root, backupPath(root))}`);
  return 0;
}

function commandRestore(root, log) {
  const backup = loadBackup(root);
  if (backup === null) {
    log.log("no backup: nothing to restore");
    return 0;
  }
  let restored = 0;
  for (const name of Object.keys(backup.doc.packages).sort()) {
    const record = backup.doc.packages[name];
    const file = resolve(root, record.packageFile);
    if (!existsSync(file)) {
      log.log(`not restored (file gone): ${name} (${record.packageFile})`);
      continue;
    }
    if (readFileSync(file, "utf8") !== record.originalText) {
      writeFileSync(file, record.originalText);
      log.log(`restored: ${name} (${record.packageFile})`);
      restored += 1;
    }
  }
  rmSync(backup.file, { force: true });
  log.log(`restore: ${restored} package.json restored from backup; backup removed.`);
  return 0;
}

/** Non-interactive CLI entry point; returns the process exit code. */
export function main(argv = process.argv.slice(2), log = console) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    log.error(`error: ${error?.message ?? error}`);
    return 1;
  }
  const root = resolve(args.root ?? process.cwd());
  if (!existsSync(join(root, "pnpm-workspace.yaml"))) {
    log.error(`pnpm-workspace.yaml not found under ${root}; pass --root with the repository root.`);
    return 1;
  }
  try {
    return args.command === "restore" ? commandRestore(root, log) : commandApply(root, args.entry, args.dryRun, log);
  } catch (error) {
    log.error(`error: ${error?.message ?? error}`);
    return 3;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
