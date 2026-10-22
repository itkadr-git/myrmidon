#!/usr/bin/env node
/**
 * check-env-registry.mjs (OPE-8820)
 *
 * Completeness check for the versioned environment-variable registry
 * docs/myrmidon/env-registry-1.6.6.{json,csv}.
 *
 * It scans runtime source (server, cli, packages; tests, fixtures and build
 * output excluded) for environment-variable NAMES (never values) and fails when:
 *   - a name used by the code is missing from the registry;
 *   - a registry entry is not fully classified (no "pending-audit" left);
 *   - the registry counts, the JSON and the CSV disagree.
 *
 * Dev/CI tooling directories (scripts, devtools) are out of scope: they are not part of the shipped runtime.
 *
 * Detected forms:
 *   process.env.NAME, process.env["NAME"], readProductEnv("NAME") (= MYRMIDON_NAME,
 *   PAPERCLIP_NAME alias) and string literals "MYRMIDON_*" / "PAPERCLIP_*".
 * MYRMIDON_X and PAPERCLIP_X are one variable (alias) and are counted once.
 *
 * Usage: node scripts/check-env-registry.mjs [--dump]
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SCAN_ROOTS = ["server/src", "cli/src", "packages"];
export const REGISTRY_JSON = "docs/myrmidon/env-registry-1.6.6.json";
export const REGISTRY_CSV = "docs/myrmidon/env-registry-1.6.6.csv";

const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["scripts", "devtools", "node_modules", "dist", "build", ".turbo", "coverage", "__tests__", "fixtures", "__fixtures__"]);
const SKIP_FILE = /(\.d\.ts|\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?)$/;

export const CLASSIFICATIONS = new Set(["secret", "infra", "product"]);
export const SCOPES = new Set(["instance", "company", "agent", "process", "host", "build-dev"]);

const PATTERNS = [
  { rx: /process\.env\.([A-Z][A-Z0-9_]+)/g, map: (n) => n },
  { rx: /process\.env\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\]/g, map: (n) => n },
  { rx: /readProductEnv\(\s*["'`]([A-Z][A-Z0-9_]+)["'`]/g, map: (n) => `MYRMIDON_${n}` },
  { rx: /["'`]((?:MYRMIDON|PAPERCLIP)_[A-Z0-9_]*[A-Z0-9])["'`]/g, map: (n) => n },
];

/** Canonical key: MYRMIDON_X and PAPERCLIP_X collapse to MYRMIDON_X. */
export function canonicalName(name) {
  return name.startsWith("PAPERCLIP_") ? `MYRMIDON_${name.slice("PAPERCLIP_".length)}` : name;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (EXTENSIONS.has(path.extname(entry.name)) && !SKIP_FILE.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

/** Returns Map<canonicalName, {variants:Set<string>, first:{file,line}}>. */
export function extractEnvNames(root = ".") {
  const found = new Map();
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of walk(path.join(root, scanRoot))) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const { rx, map } of PATTERNS) {
          rx.lastIndex = 0;
          for (const match of line.matchAll(rx)) {
            const name = map(match[1]);
            const key = canonicalName(name);
            let item = found.get(key);
            if (!item) {
              item = { variants: new Set(), first: { file: rel, line: index + 1 } };
              found.set(key, item);
            }
            item.variants.add(name);
          }
        }
      });
    }
  }
  return found;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function checkRegistry({ root = ".", extracted, registry, csvText }) {
  const problems = [];
  const entries = registry.entries ?? [];
  const names = new Map();
  for (const entry of entries) {
    if (names.has(entry.name)) problems.push(`duplicate registry entry ${entry.name}`);
    names.set(entry.name, entry);
    for (const field of ["classification", "scope", "consumer", "ui_or_store", "secret_ref_or_instance_setup", "ticket_or_pr", "decision"]) {
      const value = entry[field];
      if (typeof value !== "string" || value === "" || /pending-audit/.test(value)) {
        problems.push(`${entry.name}: field ${field} is empty or pending-audit`);
      }
    }
    if (!CLASSIFICATIONS.has(entry.classification)) problems.push(`${entry.name}: bad classification ${entry.classification}`);
    if (!SCOPES.has(entry.scope)) problems.push(`${entry.name}: bad scope ${entry.scope}`);
  }
  for (const [key, item] of extracted) {
    if (!names.has(key)) {
      problems.push(`${key}: used in ${item.first.file}:${item.first.line} but missing from the registry`);
    }
  }
  const byClass = { secret: 0, infra: 0, product: 0 };
  for (const entry of entries) if (entry.classification in byClass) byClass[entry.classification] += 1;
  if (registry.counts?.unique_names !== entries.length) {
    problems.push(`counts.unique_names ${registry.counts?.unique_names} != entries ${entries.length}`);
  }
  for (const cls of Object.keys(byClass)) {
    if (registry.counts?.[cls] !== byClass[cls]) problems.push(`counts.${cls} ${registry.counts?.[cls]} != ${byClass[cls]}`);
  }
  if (csvText !== undefined) {
    const rows = parseCsv(csvText).filter((r) => r.length > 1 || r[0] !== "");
    const header = rows.shift() ?? [];
    const nameIndex = header.indexOf("name");
    if (nameIndex < 0) problems.push("CSV has no name column");
    else {
      const csvNames = rows.map((r) => r[nameIndex]);
      const jsonNames = entries.map((e) => e.name);
      if (csvNames.length !== jsonNames.length || csvNames.some((n, i) => n !== jsonNames[i])) {
        problems.push("CSV rows do not match JSON entries (name order/count)");
      }
    }
  }
  return problems;
}

function main() {
  const root = process.cwd();
  const extracted = extractEnvNames(root);
  if (process.argv.includes("--dump")) {
    const out = {};
    for (const [key, item] of [...extracted].sort(([a], [b]) => a.localeCompare(b))) {
      out[key] = { variants: [...item.variants].sort(), file: item.first.file, line: item.first.line };
    }
    process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
    return;
  }
  const registry = JSON.parse(readFileSync(path.join(root, REGISTRY_JSON), "utf8"));
  const csvText = readFileSync(path.join(root, REGISTRY_CSV), "utf8");
  const problems = checkRegistry({ root, extracted, registry, csvText });
  if (problems.length) {
    console.error(`env registry check failed (${problems.length}):`);
    for (const p of problems.slice(0, 100)) console.error(`  - ${p}`);
    console.error("Add the new variable to docs/myrmidon/env-registry-1.6.6.{json,csv} with classification, scope and decision.");
    process.exit(1);
  }
  console.log(`env registry ok: ${registry.entries.length} entries cover ${extracted.size} names used in code`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
