#!/usr/bin/env node
// Tests for scripts/myrmidon/brand-release-audit.mjs (DEBRAND 1.6.6, OPE-8127).
// The audit runs against a fixture tree so the suite does not depend on the
// live docs state. Cases mirror the acceptance criteria of OPE-8127:
//   1. a forbidden user-facing mention makes --gate red;
//   2. an exact legal/hidden compatibility boundary stays green;
//   3. no allowlist entry is a broad glob that could mask UI/logs;
//   4. plain report mode always exits 0 (a red repo is reported, not hidden).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const auditPath = path.join(repoRoot, "scripts/myrmidon/brand-release-audit.mjs");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}\n  ${err.message}`);
  }
}

function runAudit(dir, args = []) {
  return execFileSync(process.execPath, [auditPath, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env },
    // The audit resolves the repo root from its own file location, so we
    // cannot redirect it at a fixture via cwd. Instead the fixture cases
    // below copy the audit script into a fake repo layout.
  });
}

function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brand-audit-test-"));
  fs.mkdirSync(path.join(dir, "scripts/myrmidon"), { recursive: true });
  fs.copyFileSync(auditPath, path.join(dir, "scripts/myrmidon/brand-release-audit.mjs"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

function run(dir, args) {
  try {
    const stdout = execFileSync(process.execPath,
      [path.join(dir, "scripts/myrmidon/brand-release-audit.mjs"), ...args],
      { encoding: "utf8" });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ? err.stdout.toString() : "" };
  }
}

check("forbidden user-facing mention makes the gate red", () => {
  const dir = makeFixture({
    "README.md": "# Myrmidon\n\nPaperclip is a control plane for agents.\n",
  });
  const r = run(dir, ["--gate"]);
  if (r.code !== 1) throw new Error(`expected exit 1, got ${r.code}:\n${r.stdout}`);
  if (!/README\.md:3/.test(r.stdout)) throw new Error(`finding not reported:\n${r.stdout}`);
});

check("legal attribution stays green", () => {
  const dir = makeFixture({
    "README.md": "Myrmidon is based on [Paperclip](https://github.com/paperclipai/paperclip) (MIT).\nCopyright (c) 2025 Paperclip AI.\n",
  });
  const r = run(dir, ["--gate"]);
  if (r.code !== 0) throw new Error(`expected exit 0, got ${r.code}:\n${r.stdout}`);
});

check("removed product-copy allowlist entries are rejected", () => {
  const src = fs.readFileSync(auditPath, "utf8");
  const suspicious = [
    "Paperclip, взятого", "vendor name **Paperclip**", "Paperclip не отправляем",
    "бренд везде paperclip!", "БД Paperclip в бэкап-контуре", "тикеты Paperclip",
    "БД Paperclip", "Paperclip: sign-up выключен", "Paperclip в бэкап-контуре",
    "тикеты в Paperclip", "Имя вендора **Paperclip**", "[Paperclip](https://github.com/paperclipai/paperclip)",
  ];
  for (const phrase of suspicious) {
    if (src.includes(JSON.stringify(phrase))) {
      throw new Error(`product-copy phrase remains allowlisted: ${phrase}`);
    }
  }
  const dir = makeFixture({
    "docs/architecture/README.md": "Paperclip: sign-up выключен, доступны только оператору.\n",
  });
  const r = run(dir, ["--gate"]);
  if (r.code !== 1) throw new Error(`expected removed product copy to fail, got ${r.code}:\n${r.stdout}`);
  if (!/docs\\/architecture\\/README\\.md:1/.test(r.stdout)) {
    throw new Error(`architecture finding not reported:\n${r.stdout}`);
  }
});

check("hidden compatibility boundary stays green", () => {
  const dir = makeFixture({
    "docs/deploy/example.md": "Set PAPERCLIP_API_URL and the X-Paperclip-Run-Id header; the container is paperclip-server.\n",
    "README.md": "Run `npx paperclipai` to install.\n",
  });
  const r = run(dir, ["--gate"]);
  if (r.code !== 0) throw new Error(`expected exit 0, got ${r.code}:\n${r.stdout}`);
});

check("compatibility identifier does not mask a product mention on the same line", () => {
  const dir = makeFixture({
    "docs/deploy/example.md": "Paperclip is installed via PAPERCLIP_API_URL settings.\n",
  });
  const r = run(dir, ["--gate"]);
  if (r.code !== 1) throw new Error(`expected exit 1 (the prose mention must still fail), got ${r.code}:\n${r.stdout}`);
});

check("report mode exits 0 even with findings", () => {
  const dir = makeFixture({
    "README.md": "Paperclip everywhere.\n",
  });
  const r = run(dir, []);
  if (r.code !== 0) throw new Error(`expected exit 0, got ${r.code}`);
  if (!/1 non-allowlisted/.test(r.stdout)) throw new Error(`count missing:\n${r.stdout}`);
});

check("no allowlist entry is a glob that could mask a whole file", () => {
  const src = fs.readFileSync(auditPath, "utf8");
  const m = src.match(/const ALLOWLIST = \{[\s\S]*?\n\};/);
  if (!m) throw new Error("ALLOWLIST not found");
  const entries = [...m[0].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1].replace(/\\"/g, '"'));
  // Path globs (/dir/**, docs/*) or bare directory fragments that would mask
  // a whole file or directory. Markdown bold (**word**) is prose, not a glob:
  // a glob has * adjacent to / , a string boundary, or is only * characters.
  const isGlob = (e) => {
    if (!e.includes("*")) {
      // a bare directory prefix like "docs/" masks everything under it
      return /^[A-Za-z0-9_.\-/]+\/$/.test(e);
    }
    if (/^\*+$/.test(e.trim())) return true; // a bare star
    // Remove markdown bold emphasis first: **Word** (stars wrapped around a
    // word) is prose, not a glob. Bold always opens after a non-star char and
    // closes before one; a leading or trailing "**" touching a "/" is a glob.
    const s = e.replace(/(^|[\s("'`«])\*\*(\S(?:.*?\S)?)\*\*(?=$|[\s.,;:)"'`»])/g, "$1$2");
    // What remains is a glob when a * sits on a path segment boundary with a
    // word/path char on its open side: "docs/**", "ui/src/*", "**/*.md",
    // "src/*-generated.ts". A bare "*" was handled above.
    return /(?:^|[\/\s])\*(?=[\w.\-\/])|(?<=[\w.\-\/])\*(?:$|[\/\s])|\/\*|\*\//.test(s);
  };
  // self-check the detector against the fixture case lists
  const { GLOB_CASES, NON_GLOB_CASES } = { GLOB_CASES: [
    { entry: "docs/**", isGlob: true }, { entry: "ui/src/*", isGlob: true },
    { entry: "**/*.md", isGlob: true }, { entry: "*", isGlob: true },
    { entry: "docs/", isGlob: true },
  ], NON_GLOB_CASES: [
    { entry: "**Paperclip**", isGlob: false }, { entry: "vendor name **Paperclip**", isGlob: false },
    { entry: "База:** Paperclip `v2026.916.1`", isGlob: false }, { entry: "paperclipai", isGlob: false },
  ] };
  for (const c of [...GLOB_CASES, ...NON_GLOB_CASES]) {
    if (isGlob(c.entry) !== c.isGlob) {
      throw new Error(`glob detector misclassifies "${c.entry}"`);
    }
  }
  const globby = entries.filter(isGlob);
  if (globby.length > 0) throw new Error(`glob-like allowlist entries: ${globby.join(", ")}`);
});

check("UI text and log lines are never allowlisted wholesale", () => {
  // A bare product-name sentence in UI copy or a quoted log line must fail.
  const dir = makeFixture({
    "docs/wiki/Home.md": 'The welcome screen says: "Paperclip — your agent workspace".\n',
  });
  const r = run(dir, ["--gate"]);
  if (r.code !== 1) throw new Error(`expected exit 1, got ${r.code}:\n${r.stdout}`);
});

if (failed > 0) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log("brand-release-audit tests: all pass");
