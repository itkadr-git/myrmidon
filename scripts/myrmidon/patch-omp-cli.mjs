#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TARGET_NEEDLE =
  "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.";
export const REPLACEMENT_TEXT =
  "Keywords MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL follow their usual meaning.";

export function patchOmpCliText(content) {
  if (!content.includes(TARGET_NEEDLE)) {
    throw new Error(
      `Target RFC 2119 pattern not found in cli.js: ${JSON.stringify(TARGET_NEEDLE)}`,
    );
  }
  return content.replaceAll(TARGET_NEEDLE, REPLACEMENT_TEXT);
}

export function patchOmpCliFile(cliPath) {
  if (!fs.existsSync(cliPath)) {
    throw new Error(`omp cli.js not found at path: ${cliPath}`);
  }
  const original = fs.readFileSync(cliPath, "utf8");
  const patched = patchOmpCliText(original);
  fs.writeFileSync(cliPath, patched, "utf8");

  // Post-condition validation
  const recheck = fs.readFileSync(cliPath, "utf8");
  if (recheck.includes("RFC 2119 keywords:")) {
    throw new Error(
      `Validation failed: 'RFC 2119 keywords:' still present in ${cliPath}`,
    );
  }
  if (!recheck.includes(REPLACEMENT_TEXT)) {
    throw new Error(
      `Validation failed: replacement text not found in ${cliPath}`,
    );
  }
}

const isMain =
  Boolean(import.meta.main) ||
  (Boolean(process.argv[1]) &&
    (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
      import.meta.url.endsWith(process.argv[1])));

if (isMain) {
  const cliPath = process.argv[2];
  if (!cliPath) {
    console.error("Usage: patch-omp-cli.mjs <path-to-cli.js>");
    process.exit(1);
  }
  try {
    patchOmpCliFile(cliPath);
    console.log(`Successfully patched omp prompt in ${cliPath}`);
  } catch (err) {
    console.error(`patch-omp-cli failed: ${err.message}`);
    process.exit(1);
  }
}
