#!/usr/bin/env node
/**
 * paperclip-names-ratchet.mjs (REBRAND-C ratchet)
 *
 * Myrmidon names its own environment variables, constants and identifiers
 * MYRMIDON_* (environment reads go through readProductEnv / readProductEnvFrom
 * from @myrmidon/shared/env-alias, which keep the PAPERCLIP_* spelling as a
 * deprecated alias). A PAPERCLIP_* name is allowed only when the vendor ships
 * it, or when it is one of our deprecated aliases kept for one release. Both
 * lists are frozen in scripts/myrmidon/ci/paperclip-names-baseline.txt.
 *
 * The check lists the tracked files (git ls-files), skips documentation
 * (docs/, doc/, Markdown) and lock files, extracts every PAPERCLIP_<NAME>
 * token and fails on a name the baseline does not hold, printing where it is
 * used. A name that disappeared from the code is never an error: the baseline
 * shrinks by hand, when an alias is removed.
 *
 * A vendor backport that brings a new vendor name adds it to the vendor
 * section of the baseline in the same PR.
 *
 * CI runs it through paperclip-names-ratchet.test.mjs (the checks job runs
 * every scripts/myrmidon test), so it needs no workflow step of its own.
 *
 * Usage: node scripts/myrmidon/ci/paperclip-names-ratchet.mjs [--list]
 *   --list  print every name found in the scanned files (to rebuild the
 *           baseline), one per line, and exit 0.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const BASELINE_FILE = "scripts/myrmidon/ci/paperclip-names-baseline.txt";
export const NAME_PATTERN = /PAPERCLIP_[A-Z0-9_]*[A-Z0-9]/g;

const SELF_FILES = new Set([
  BASELINE_FILE,
  "scripts/myrmidon/ci/paperclip-names-ratchet.mjs",
  "scripts/myrmidon/ci/paperclip-names-ratchet.test.mjs",
]);
const SKIP_PREFIXES = ["docs/", "doc/"];
const SKIP_SUFFIXES = [
  ".md", ".mdx", "pnpm-lock.yaml", "package-lock.json",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf", ".zip", ".gz", ".tgz", ".wasm",
];

/** Whether a tracked path is scanned at all. */
export function isScanned(file) {
  if (SELF_FILES.has(file)) return false;
  if (SKIP_PREFIXES.some((prefix) => file.startsWith(prefix))) return false;
  return !SKIP_SUFFIXES.some((suffix) => file.endsWith(suffix));
}

/** Names of the baseline file: one per line, `#` starts a comment. */
export function parseBaseline(text) {
  const names = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (line) names.add(line);
  }
  return names;
}

/** Every PAPERCLIP_* token of one file's text, with the 1-based line it is on. */
export function extractNames(text) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(NAME_PATTERN)) found.push({ name: match[0], line: index + 1 });
  });
  return found;
}

/**
 * The names used by `files` ({ path, text }) that the baseline lacks, each
 * with its first few locations.
 */
export function findNewNames(files, baseline) {
  const unknown = new Map();
  for (const { path: file, text } of files) {
    for (const { name, line } of extractNames(text)) {
      if (baseline.has(name)) continue;
      const places = unknown.get(name) ?? [];
      if (places.length < 5) places.push(`${file}:${line}`);
      unknown.set(name, places);
    }
  }
  return [...unknown.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, places]) => ({ name, places }));
}

function trackedFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

function readScanned(root) {
  const files = [];
  for (const file of trackedFiles(root)) {
    if (!isScanned(file)) continue;
    let text;
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue; // deleted in the working tree, a submodule or a dangling link
    }
    if (text.includes("\0")) continue; // binary
    files.push({ path: file, text });
  }
  return files;
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function main(argv = process.argv.slice(2), root = REPO_ROOT) {
  const files = readScanned(root);
  if (argv.includes("--list")) {
    const names = new Set(files.flatMap(({ text }) => extractNames(text).map(({ name }) => name)));
    for (const name of [...names].sort()) console.log(name);
    return 0;
  }
  const baseline = parseBaseline(readFileSync(path.join(root, BASELINE_FILE), "utf8"));
  const fresh = findNewNames(files, baseline);
  if (fresh.length === 0) {
    console.log(`paperclip-names-ratchet: ok (${files.length} files, ${baseline.size} baseline names)`);
    return 0;
  }
  console.error("paperclip-names-ratchet: new PAPERCLIP_* names. Name them MYRMIDON_* " +
    "(read the environment with readProductEnv from @myrmidon/shared/env-alias); a vendor " +
    `backport adds its vendor names to ${BASELINE_FILE}.`);
  for (const { name, places } of fresh) console.error(`  ${name}: ${places.join(", ")}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
