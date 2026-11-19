import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  buildManifest,
  collectNavPages,
  DOCS_JSON_PATH,
  OUTPUT_PATH,
  parseArgs,
  parseFrontMatter,
  REPO_ROOT,
  resolvePageFile,
} from "./generate-llms-txt.mjs";

const DOCS_DIR = path.dirname(DOCS_JSON_PATH);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "generate-llms-txt.mjs");

function runScript(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? err.message),
    };
  }
}
test("parseArgs accepts --check and --stdout and rejects unknown flags", () => {
  assert.deepEqual(parseArgs(["--check"]), { check: true, stdout: false });
  assert.deepEqual(parseArgs(["--stdout"]), { check: false, stdout: true });
  const originalWrite = process.stderr.write;
  const originalExitCode = process.exitCode;
  process.stderr.write = () => true;
  try {
    assert.equal(parseArgs(["--bogus"]), null);
    assert.equal(process.exitCode, 1);
  } finally {
    process.stderr.write = originalWrite;
    process.exitCode = originalExitCode;
  }
});

test("collectNavPages reads the real docs.json and orders entries nav-first", () => {
  const docsJson = JSON.parse(fs.readFileSync(DOCS_JSON_PATH, "utf8"));
  const pages = collectNavPages(docsJson);
  assert.ok(pages.length >= 50, `expected full nav, got ${pages.length} pages`);
  assert.equal(pages[0], "start/what-is-paperclip");
  assert.ok(pages.includes("api/issues"));
  assert.ok(pages.includes("cli/overview"));
  // Each tab's first page appears in tab order.
  assert.equal(pages[4], "guides/board-operator/dashboard");
});

test("collectNavPages deduplicates repeated nav entries", () => {
  const docsJson = {
    navigation: {
      tabs: [
        {
          tab: "T",
          groups: [{ group: "G", pages: ["a/b", "a/b", "a/c"] }],
        },
      ],
    },
  };
  assert.deepEqual(collectNavPages(docsJson), ["a/b", "a/c"]);
});

test("collectNavPages rejects anchor and blank nav entries", () => {
  const anchor = {
    navigation: { tabs: [{ tab: "T", groups: [{ group: "G", pages: ["a/b#x"] }] }] },
  };
  assert.throws(() => collectNavPages(anchor), /anchor/);
  const blank = {
    navigation: { tabs: [{ tab: "T", groups: [{ group: "G", pages: [" "] }] }] },
  };
  assert.throws(() => collectNavPages(blank), /clean path/);
});

test("parseFrontMatter extracts title/summary, strips quotes, tolerates absent block", () => {
  const content = [
    "---",
    'title: "Quoted Title"',
    "summary: 'Single'",
    "---",
    "",
    "body",
  ].join("\n");
  assert.deepEqual(parseFrontMatter(content), { title: "Quoted Title", summary: "Single" });
  assert.deepEqual(parseFrontMatter("no front matter"), { title: null, summary: null });
  assert.deepEqual(parseFrontMatter("---\ntitle: T"), { title: null, summary: null });
});

test("resolvePageFile resolves .mdx before .md and returns null for missing pages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llms-txt-test-"));
  try {
    fs.writeFileSync(path.join(dir, "page.mdx"), "x");
    assert.ok(resolvePageFile(dir, "page").endsWith("page.mdx"));
    fs.rmSync(path.join(dir, "page.mdx"));
    fs.writeFileSync(path.join(dir, "page.md"), "x");
    assert.ok(resolvePageFile(dir, "page").endsWith("page.md"));
    assert.equal(resolvePageFile(dir, "absent"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildManifest emits title/summary entries with relative .md links in nav order", () => {
  const docsJson = {
    navigation: {
      tabs: [
        {
          tab: "Get Started",
          groups: [
            {
              group: "Introduction",
              pages: ["start/what-is-paperclip", "start/quickstart"],
            },
          ],
        },
      ],
    },
  };
  const manifest = buildManifest(docsJson, DOCS_DIR);
  const lines = manifest.split("\n");
  assert.equal(lines[0], "# Myrmidon");
  assert.ok(lines.some((l) => l.startsWith("> The control plane")));
  const entry = lines.findIndex((l) => l.includes("](start/what-is-paperclip.md)"));
  assert.ok(entry > 0);
  assert.match(manifest, /\[What is Myrmidon\?\]\(start\/what-is-paperclip\.md\)/);
  assert.match(manifest, /\(start\/what-is-paperclip\.md\): The control plane for autonomous AI companies\n/);
  const qsIndex = manifest.indexOf("](start/quickstart.md)");
  assert.ok(qsIndex > entry, "nav order preserved");
});

test("buildManifest excludes out-of-nav docs and fails closed on missing nav pages", () => {
  const docsJson = JSON.parse(fs.readFileSync(DOCS_JSON_PATH, "utf8"));
  const manifest = buildManifest(docsJson, DOCS_DIR);
  // Private/internal trees never appear in the manifest.
  for (const forbidden of ["myrmidon/", "wiki/", "adr/", "plans/", ".ru"]) {
    assert.ok(!manifest.includes(forbidden), `manifest leaked ${forbidden}`);
  }
  // Every linked path resolves to a real published doc file.
  const linked = [...manifest.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(linked.length >= 50, `expected ${linked.length} links to cover full nav`);
  for (const link of linked) {
    assert.ok(!link.startsWith("/") && !link.includes("://"), `non-relative link: ${link}`);
    assert.ok(link.endsWith(".md"), `non-.md link: ${link}`);
    const resolved = path.join(DOCS_DIR, link);
    assert.ok(
      fs.existsSync(resolved) && fs.statSync(resolved).isFile(),
      `broken link: ${link}`,
    );
  }
  const missingNav = {
    navigation: { tabs: [{ tab: "T", groups: [{ group: "G", pages: ["no/such/page"] }] }] },
  };
  assert.throws(() => buildManifest(missingNav, DOCS_DIR), /broken links/);
});

test("committed docs/llms.txt matches generated output (check mode)", () => {
  const { status, stderr } = runScript(["--check"]);
  assert.equal(status, 0, `--check failed: ${stderr}`);
});

test("generate writes docs/llms.txt and reports the output path", () => {
  const before = fs.readFileSync(OUTPUT_PATH, "utf8");
  const out = runScript([]);
  assert.match(out.stdout, /wrote docs\/llms\.txt/);
  assert.equal(fs.readFileSync(OUTPUT_PATH, "utf8"), before);
});
