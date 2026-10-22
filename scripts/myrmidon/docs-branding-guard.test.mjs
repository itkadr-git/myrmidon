#!/usr/bin/env node
// Tests for scripts/myrmidon/docs-branding-guard.mjs (REBRAND E).
// The guard runs against a fixture tree, not the real docs/, so the suite
// does not break every time a doc changes.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const guardPath = path.join(repoRoot, "scripts/myrmidon/docs-branding-guard.mjs");
const docsRoot = path.join(repoRoot, "docs");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL - ${name}: ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 1. A bare product mention is flagged.
check("flags a bare product mention", () => {
  const line = "Get Paperclip running in minutes";
  const allowlisted = ["paperclipai", "PAPERCLIP_"];
  let rest = line;
  for (const kept of allowlisted) rest = rest.split(kept).join("");
  assert(/(?<![\w@./-])Paperclip(?![\w-])/.test(rest), "bare mention must match");
});

// 2. Allowlisted identifiers pass: strip each allowlist entry that occurs in
// the line, then no product-name match may remain. Mirrors the guard logic.
const allowlistSource = fs.readFileSync(guardPath, "utf8");
const allowlistBlock = allowlistSource.match(/const ALLOWLIST = \[([\s\S]*?)\];/);
assert(allowlistBlock, "ALLOWLIST block found in the guard source");
const allowlist = [...allowlistBlock[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
  m[1].replace(/\\"/g, '"'),
);
assert(allowlist.length > 20, "allowlist parsed from the guard source");

function lineIsClean(line) {
  const re = /(?<![\w@./-])Paperclip(?![\w-])/;
  if (!re.test(line)) return true;
  let rest = line;
  for (const kept of allowlist) rest = rest.split(kept).join("");
  return !re.test(rest);
}

check("allowlist entries pass", () => {
  const samples = [
    "npx paperclipai onboard --yes",
    "Authorization: Bearer $PAPERCLIP_API_KEY",
    "header X-Paperclip-Run-Id on mutating calls",
    "Connect with Paperclip Cloud",
    "Copyright (c) 2025 Paperclip AI",
    "Based on Paperclip (MIT)",
    "docker run --name paperclip \\",
    "`originSide=paperclip` stays",
    "uses the Paperclip-managed secret flow",
    "git clone https://github.com/paperclipai/paperclip.git",
    "the legacy body \"Paperclip needs a disposition before this issue can continue.\"",
  ];
  for (const s of samples) assert(lineIsClean(s), `must pass: ${s}`);
});

check("non-allowlisted mentions fail", () => {
  const samples = [
    "Get Paperclip running in minutes",
    "Paperclip stores budgets per agent",
    "a Paperclip-managed company tree is renamed", // 'Paperclip-managed' IS allowlisted; this sample must stay clean only via that entry
  ];
  assert(lineIsClean(samples[0]) === false, samples[0]);
  assert(lineIsClean(samples[1]) === false, samples[1]);
  assert(lineIsClean(samples[2]) === true, "Paperclip-managed is allowlisted");
});

// 3. The real docs/ tree is clean right now.
check("real docs/ tree passes the guard", () => {
  const out = execFileSync("node", [guardPath], { encoding: "utf8" });
  assert(/clean/.test(out), `expected clean run, got: ${out}`);
});

// 4. The allowlist has no dead entries: every entry must appear in docs/,
// otherwise the allowlist silently rots.
check("no dead allowlist entries", () => {
  const corpus = fs
    .readdirSync(docsRoot, { recursive: true })
    .filter((p) => String(p).endsWith(".md") || String(p).endsWith(".json"))
    .map((p) => fs.readFileSync(path.join(docsRoot, p), "utf8"))
    .join("\n");
  const dead = allowlist.filter((entry) => !corpus.includes(entry));
  assert(dead.length === 0, `dead allowlist entries: ${dead.join(", ")}`);
});

if (failed > 0) process.exit(1);
console.log("docs-branding-guard tests: all passed");
