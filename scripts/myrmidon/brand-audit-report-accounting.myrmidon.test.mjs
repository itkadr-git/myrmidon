import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const audit = fileURLToPath(new URL("./brand-release-audit.mjs", import.meta.url));
const scratch = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-scratch");
const vendor = "https://github.com/paperclipai/paperclip";

function run(t, files, flags = []) {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "brand-accounting-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "scripts/myrmidon/brand-release-audit.mjs");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(audit, script);
  for (const [name, contents] of Object.entries(files)) {
    const dest = path.join(root, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, contents);
  }
  const result = spawnSync(process.execPath, [script, ...flags], {
    encoding: "utf8", env: {}, cwd: root,
  });
  assert.ifError(result.error);
  assert.equal(result.stderr, "");
  return result;
}

const scenarios = [
  { name: "doc-only", docs: true, manifest: false },
  { name: "manifest-only", docs: false, manifest: true },
  { name: "both", docs: true, manifest: true },
  { name: "clean", docs: false, manifest: false },
];
const modes = [
  { name: "report", flags: [], gate: false, packagesOnly: false },
  { name: "gate", flags: ["--gate"], gate: true, packagesOnly: false },
  { name: "package-only", flags: ["--package-json-only"], gate: false, packagesOnly: true },
  { name: "package-only gate", flags: ["--package-json-only", "--gate"], gate: true, packagesOnly: true },
];

for (const scenario of scenarios) {
  for (const mode of modes) {
    test(`${scenario.name} / ${mode.name}: totals, findings and footer`, (t) => {
      const files = {
        "README.md": scenario.docs ? "Paperclip everywhere.\n" : "Myrmidon everywhere.\n",
        "package.json": JSON.stringify({ repository: scenario.manifest ? vendor : "https://github.com/itkadr-git/myrmidon" }),
      };
      const docs = scenario.docs && !mode.packagesOnly ? 1 : 0;
      const manifests = scenario.manifest ? 1 : 0;
      const hasFindings = docs + manifests > 0;
      const expected = [
        `brand-release-audit: ${docs} non-allowlisted "Paperclip" mention(s) in user-facing docs`,
        ...(docs ? ["  README.md:1: Paperclip everywhere."] : []),
        `brand-release-audit: ${manifests} stale package.json repository/homepage/bugs URL(s)`,
        ...(manifests ? [`  package.json: repository points at the vendored repo: ${vendor}`] : []),
        ...(hasFindings
          ? ["brand-release-audit: report mode — findings listed above (a non-zero total is expected until the parallel DEBRAND parts land)", ...(mode.gate ? ["brand-release-audit: --gate: failing"] : [])]
          : ["brand-release-audit: clean"]),
      ];
      const result = run(t, files, mode.flags);
      assert.equal(result.status, hasFindings && mode.gate ? 1 : 0);
      assert.equal(result.stdout, `${expected.join("\n")}\n`);
    });
  }
}

const docCases = [
  { name: "blank lines and CRLF retain line numbers", input: "heading\r\n\r\nPaperclip here.\r\n", finding: "  docs/example.md:3: Paperclip here." },
  { name: "surrounding whitespace is trimmed", input: "  \tPaperclip here.  \t\n", finding: "  docs/example.md:1: Paperclip here." },
  { name: "long lines are truncated to 120 characters after trimming", input: `  Paperclip ${"x".repeat(150)}  \n`, finding: `  docs/example.md:1: Paperclip ${"x".repeat(110)}` },
  { name: "multiple mentions on one line count once", input: "Paperclip and Paperclip again.\n", finding: "  docs/example.md:1: Paperclip and Paperclip again." },
];
for (const item of docCases) {
  test(item.name, (t) => {
    const result = run(t, { "docs/example.md": item.input });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, [
      'brand-release-audit: 1 non-allowlisted "Paperclip" mention(s) in user-facing docs',
      item.finding,
      "brand-release-audit: 0 stale package.json repository/homepage/bugs URL(s)",
      "brand-release-audit: report mode — findings listed above (a non-zero total is expected until the parallel DEBRAND parts land)",
      "",
    ].join("\n"));
  });
}
