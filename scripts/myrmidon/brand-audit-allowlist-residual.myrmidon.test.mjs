import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("./brand-release-audit.mjs", import.meta.url));
const scratch = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || path.join(os.homedir(), ".cache", "myrmidon-test-scratch");

function audit(t, line, finding) {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "brand-residual-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "scripts", "myrmidon", "brand-release-audit.mjs");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(source, script);
  fs.writeFileSync(path.join(root, "README.md"), `${line}\n`);
  const result = spawnSync(process.execPath, [script, "--gate"], {
    encoding: "utf8", env: {},
  });
  assert.ifError(result.error);
  assert.equal(result.status, finding ? 1 : 0, result.stderr);
  assert.equal(result.stderr, "");
  const expected = [
    `brand-release-audit: ${finding ? 1 : 0} non-allowlisted "Paperclip" mention(s) in user-facing docs`,
    ...(finding ? [`  README.md:1: ${line}`] : []),
    "brand-release-audit: 0 stale package.json repository/homepage/bugs URL(s)",
    ...(finding ? [
      "brand-release-audit: report mode — findings listed above (a non-zero total is expected until the parallel DEBRAND parts land)",
      "brand-release-audit: --gate: failing",
    ] : ["brand-release-audit: clean"]),
    "",
  ].join("\n");
  assert.equal(result.stdout, expected);
}

const categories = [
  ["vendor identifier", "paperclipai"],
  ["legal", "Copyright (c) 2025 Paperclip"],
  ["compatibility", "paperclip-server"],
  ["external service", "Paperclip Cloud"],
  ["historical", "Paperclip v2026.916.1"],
  ["provenance", "upstream Paperclip"],
];

for (const [category, phrase] of categories) {
  const cases = [
    ["phrase alone", phrase, false],
    ["repeated phrase", `${phrase} | ${phrase}`, false],
    ["bare mention after", `${phrase} | Paperclip`, true],
    ["bare mention before", `Paperclip | ${phrase}`, true],
    ["bare mention between repeats", `${phrase} | Paperclip | ${phrase}`, true],
  ];
  for (const [name, line, finding] of cases) {
    test(`${category}: ${name}`, (t) => audit(t, line, finding));
  }
}

const link = "[Paperclip](https://github.com/paperclipai/paperclip)";
test("two vendor attribution links remain clean", (t) => audit(t, `${link} | ${link}`, false));
test("vendor attribution link does not mask a bare mention", (t) => audit(t, `${link} | Paperclip`, true));
