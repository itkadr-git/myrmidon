import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const audit = fileURLToPath(new URL("./brand-release-audit.mjs", import.meta.url));
const scratch = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-scratch");
const stale = "https://github.com/paperclipai/paperclip";
const current = "https://github.com/itkadr-git/myrmidon";

function runFixture(t, manifests) {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "manifest-shapes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "scripts/myrmidon/brand-release-audit.mjs");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(audit, script);
  for (const [name, contents] of Object.entries(manifests)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  const result = spawnSync(process.execPath, [script, "--package-json-only", "--gate"], {
    encoding: "utf8", env: {}, cwd: root,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, "");
  return result;
}

function checkResult(result, findings) {
  const lines = [
    'brand-release-audit: 0 non-allowlisted "Paperclip" mention(s) in user-facing docs',
    `brand-release-audit: ${findings.length} stale package.json repository/homepage/bugs URL(s)`,
    ...findings.map((finding) => `  ${finding}`),
    ...(findings.length ? [
      "brand-release-audit: report mode — findings listed above (a non-zero total is expected until the parallel DEBRAND parts land)",
      "brand-release-audit: --gate: failing",
    ] : ["brand-release-audit: clean"]),
    "",
  ];
  assert.equal(result.status, findings.length ? 1 : 0);
  assert.equal(result.stdout, lines.join("\n"));
}

const shapes = [
  ["stale string", stale, true],
  ["stale object url", { url: `${stale}/issues` }, true],
  ["current string", current, false],
  ["current object url", { url: current }, false],
  ["null", null, false],
  ["number", 42, false],
  ["array", [stale], false],
  ["object without string url", { url: 42 }, false],
  ["object without url", { type: "git" }, false],
];
for (const field of ["repository", "homepage", "bugs"]) {
  for (const [name, value, isStale] of shapes) {
    test(`${field}: ${name}`, (t) => {
      const result = runFixture(t, { "package.json": JSON.stringify({ [field]: value }) });
      const url = typeof value === "string" ? value : value?.url;
      checkResult(result, isStale ? [`package.json: ${field} points at the vendored repo: ${url}`] : []);
    });
  }
}

test("invalid JSON reports one diagnostic and fails the gate", (t) => {
  checkResult(runFixture(t, { "package.json": "{" }), ["package.json: package.json is not valid JSON"]);
});

for (const manifest of [
  "package.json", "cli/package.json", "packages/package.json", "server/package.json", "ui/package.json",
  "cli/a/b/package.json", "packages/a/b/package.json", "server/a/b/package.json", "ui/a/b/package.json",
]) {
  test(`scans ${manifest}`, (t) => {
    checkResult(runFixture(t, { [manifest]: JSON.stringify({ repository: stale }) }), [
      `${manifest}: repository points at the vendored repo: ${stale}`,
    ]);
  });
}

for (const excluded of ["node_modules", ".git"]) {
  for (const root of ["cli", "packages", "server", "ui"]) {
    const manifest = `${root}/nested/${excluded}/package.json`;
    test(`excludes ${manifest}`, (t) => {
      checkResult(runFixture(t, { [manifest]: JSON.stringify({ bugs: stale }) }), []);
    });
  }
}
