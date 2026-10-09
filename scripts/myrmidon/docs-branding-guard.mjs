#!/usr/bin/env node
// REBRAND E: the docs must call the product Myrmidon. This guard
// fails when `docs/` contains a "Paperclip" mention that is not on the
// allowlist below — the allowlist covers identifiers that are renamed only
// together with their owning code epics (packages, env vars, protocol fields),
// third-party vendor product names, and license/attribution strings.
//
// Usage: node scripts/myrmidon/docs-branding-guard.mjs
// Exit code: 0 clean, 1 findings.
//
// The allowlist mirrors the one in the REBRAND E rename pass and is documented
// in docs/myrmidon/guides/docs-branding.md. When an owning epic renames an
// identifier, remove its entry here and update the docs in the same PR.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docsRoot = path.join(repoRoot, "docs");

// Substrings that keep a line compliant. Order matters only for readability.
// Everything here is either a code/config identifier, a third-party product
// name, a license/attribution string, or a historical record of a pre-rename
// state.
const ALLOWLIST = [
  "paperclipai", // @paperclipai/* packages, the paperclipai CLI, vendor repo URLs
  "PAPERCLIP_", // env vars
  "X-Paperclip-", // HTTP headers
  "Paperclip Cloud", "Paperclip Labs", "Paperclip EE", "Paperclip Enterprise",
  "Paperclip Runner",
  "skills/paperclip", "paperclip/SKILL",
  "paperclip/instances", "paperclip-server", "paperclip-db",
  "paperclip.service", ".paperclip", "paperclip-ecs-execution",
  "paperclip-fleetd", "git-credential-paperclip", "paperclip-assigned",
  "my-paperclip-adapter", "paperclip_runner", "buildPaperclipEnv",
  "buildPaperclipWakePayload", "hindsight-paperclip",
  "paperclip-version",
  "MYRMIDON_BASE_PAPERCLIP", "basePaperclipVersion",
  "sanitizeInheritedPaperclipEnv", "paperclipTaskMarkdown",
  "_paperclipGuardrails", "paperclip-plugin-telegram",
  "paperclip-plugin-fake-sandbox", "paperclip-plugin-hindsight",
  "paperclip-claude-auth", "droid-paperclip-adapter",
  "paperclip-create-agent", "openclaw-paperclip-smoke",
  "paperclip-self-read", "--paperclip-url", "--require-paperclip",
  "paperclip-operations", "paperclip-run-", "paperclip-local",
  "docker-paperclip", "paperclip-dev", "paperclip-fork", "paperclip-local-lab",
  "paperclip-ext/", "<paperclip-secret-id>",
  "paperclip-runnerd", "paperclip.adapterUiParser",
  "paperclip.manifest.json", "stack-registry",
  "`paperclip`", "\"paperclip\"", "'paperclip'",
  "paperclip:2026.", "paperclipVersionMin",
  "Copyright (c) 2025 Paperclip",
  "Based on Paperclip",
  "Paperclip AI", // vendor company name (license/provenance sections)
  "PaperclipLockup", "PaperclipLoading", "AnimatedPaperclipIcon",
  "Paperclip-managed skills",
  "Paperclip needs a disposition", // legacy notification body, still recognized
  "Close the current Paperclip task", // frozen legacy Discord command digest
  "«Paperclip ", "Paperclip connections", "Paperclip projects",
  "Paperclip connected",
  // License/provenance and historical-context phrasings (see the guides):
  "на основе Paperclip", "Отношение к Paperclip", "Основан на Paperclip",
  "основан на Paperclip", "Имя Paperclip в коде", "Myrmidon от Paperclip",
  "отличий Myrmidon от Paperclip",
  "вместо Paperclip", "остаётся Paperclip",
  "Paperclip — только основа", "Paperclip 2026.916.1",
  "Paperclip base", "Paperclip в основе", "основы Paperclip",
  "рутина Paperclip", "рутине Paperclip", "за основу",
  "Base Paperclip version", "**База:** Paperclip", "Paperclip (MIT)»",
  "PaperclipIcon", "PaperclipLockup.tsx", "Paperclip»-строки",
  "`Paperclip`", "Paperclip, взятого",
  "Paperclip**", "«Paperclip»", "stays Paperclip", "остаётся Paperclip",
  "Paperclip-managed", // managed-by-vendor flows named in prose; kept one release
  "/paperclip", // docker container/volume paths
  "paperclip/", // repo-relative internal paths
];

// Product-name mentions that are never allowed outside the allowlist matches.
const PRODUCT_NAME = /(?<![\w@./-])Paperclip(?![\w-])/;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith(".md") || entry.name.endsWith(".json")) yield p;
  }
}

let findings = 0;
for (const file of walk(docsRoot)) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!PRODUCT_NAME.test(line)) return;
    let rest = line;
    for (const kept of ALLOWLIST) rest = rest.split(kept).join("");
    if (PRODUCT_NAME.test(rest)) {
      findings += 1;
      console.log(`${path.relative(repoRoot, file)}:${i + 1}: non-allowlisted "Paperclip" mention`);
    }
  });
}

if (findings > 0) {
  console.log(`docs-branding-guard: ${findings} finding(s) — rename the product mention to Myrmidon or extend the allowlist (see docs/myrmidon/guides/docs-branding.md)`);
  process.exit(1);
}
console.log("docs-branding-guard: clean");
