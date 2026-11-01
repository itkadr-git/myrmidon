#!/usr/bin/env node

/**
 * Generator for packages/shared/src/myrmidon/index.ts domain barrel.
 *
 * Part of OPE-9341: eliminates merge conflicts across parallel PRs by moving
 * Myrmidon contracts into a dedicated domain barrel and keeping exports
 * strictly sorted alphabetically.
 *
 * Usage:
 *   node scripts/generate-shared-exports.mjs                 # regenerate barrel
 *   node scripts/generate-shared-exports.mjs --check         # verify barrel is up to date
 *   node scripts/generate-shared-exports.mjs --root <dir>    # specify alternative repository root (for tests/fixtures)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const defaultRepoRoot = resolve(__dirname, "..");

// Explicit standalone contracts in packages/shared/src/
export const CONTRACT_FILES = [
  "blocker-graph.ts",
  "continuation-key.ts",
  "interaction-routing.ts",
  "recovery-factory.ts",
];

export function generateBarrelContent(customRepoRoot) {
  const root = customRepoRoot ? resolve(customRepoRoot) : defaultRepoRoot;
  const sharedSrc = join(root, "packages/shared/src");
  const myrmidonDir = join(sharedSrc, "myrmidon");

  const exports = [];

  // 1. Files in packages/shared/src/myrmidon/ (excluding index.ts and tests)
  if (existsSync(myrmidonDir)) {
    const myrmidonDirEntries = readdirSync(myrmidonDir)
      .filter(
        (f) =>
          f.endsWith(".ts") &&
          f !== "index.ts" &&
          !f.endsWith(".test.ts") &&
          !f.endsWith(".d.ts"),
      )
      .sort();

    for (const f of myrmidonDirEntries) {
      const mod = f.replace(/\.ts$/, ".js");
      exports.push({ specifier: `./${mod}`, statement: `export * from "./${mod}";` });
    }
  }

  // 2. Standalone contract files in packages/shared/src/
  for (const f of CONTRACT_FILES) {
    if (existsSync(join(sharedSrc, f))) {
      const mod = f.replace(/\.ts$/, ".js");
      exports.push({ specifier: `../${mod}`, statement: `export * from "../${mod}";` });
    }
  }

  // 3. myrmidon-* files in packages/shared/src/
  if (existsSync(sharedSrc)) {
    const sharedEntries = readdirSync(sharedSrc)
      .filter(
        (f) =>
          f.startsWith("myrmidon-") &&
          f.endsWith(".ts") &&
          !f.endsWith(".test.ts") &&
          !f.endsWith(".d.ts"),
      )
      .sort();

    for (const f of sharedEntries) {
      const mod = f.replace(/\.ts$/, ".js");
      exports.push({ specifier: `../${mod}`, statement: `export * from "../${mod}";` });
    }
  }

  // Sort exports alphabetically by specifier to ensure deterministic, conflict-free diffs
  exports.sort((a, b) => a.specifier.localeCompare(b.specifier));

  const lines = [
    "// Auto-generated domain barrel for Myrmidon contracts (OPE-9341).",
    "// Do NOT append exports to the end of packages/shared/src/index.ts.",
    "// New contracts go here or in packages/shared/src/myrmidon/, sorted alphabetically.",
    "// Regenerate with: node scripts/generate-shared-exports.mjs",
    "",
  ];

  for (const entry of exports) {
    lines.push(entry.statement);
  }
  lines.push("");

  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const rootIdx = args.indexOf("--root");
  const customRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : undefined;

  const targetRoot = customRoot ? resolve(customRoot) : defaultRepoRoot;
  const barrelPath = join(targetRoot, "packages/shared/src/myrmidon/index.ts");

  const generated = generateBarrelContent(targetRoot);

  if (isCheck) {
    let existing = "";
    try {
      existing = readFileSync(barrelPath, "utf8");
    } catch (err) {
      console.error(`Error reading ${barrelPath}:`, err);
      process.exit(1);
    }

    if (existing.trim() !== generated.trim()) {
      console.error(
        `Error: ${barrelPath} is out of date.\nRun "node scripts/generate-shared-exports.mjs" to regenerate it.`,
      );
      process.exit(1);
    }

    console.log("Myrmidon shared exports barrel is up to date.");
    process.exit(0);
  }

  writeFileSync(barrelPath, generated, "utf8");
  console.log(`Updated ${barrelPath} with sorted domain exports.`);
}
