import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { collect, listFragments, parseFragment } from "./collect-fragments.mjs";
import { mergeHunks, parseHunks, run } from "./fragments-from-diff.mjs";

// CHANGE-FRAGMENTS converter: a branch's direct edits of the registry
// documents become a fragment, the documents are reverted, and assembling the
// fragment gives back exactly what the direct edit produced (round trip).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "fragments-from-diff.mjs");

const TABLE_HEAD = "| Variable | Function | Default | What it does | How to disable |\n|---|---|---|---|---|\n";
const SETTINGS = `# Settings

Intro line.

## Track 5 — operations

${TABLE_HEAD}| \`MYRMIDON_OLD\` | OLD | \`1\` | Old setting | \`0\` |

## Track 6 — models

${TABLE_HEAD}| \`MYRMIDON_MODEL\` | M | \`x\` | Model | unset |

## Twin

${TABLE_HEAD}| \`MYRMIDON_A\` | A | 1 | first twin | - |

## Twin

${TABLE_HEAD}| \`MYRMIDON_A\` | A | 2 | second twin | - |
`;
const CHANGELOG = `# Changelog

## Unreleased

### Old entry (OLD-1)

- Old.

## 1.0.0

- Shipped.
`;
const CHANGELOG_RU = CHANGELOG.replace("## Unreleased", "## Без выпуска");

const REL = {
  cl: "docs/myrmidon/CHANGELOG.md",
  clru: "docs/myrmidon/CHANGELOG.ru.md",
  div: "docs/myrmidon/DIVERGENCE.md",
  set: "docs/myrmidon/SETTINGS.md",
  setru: "docs/myrmidon/SETTINGS.ru.md",
};

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

function repoWith(branchEdits) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fragments-from-diff-"));
  git(dir, "init", "-q", "-b", "main");
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write(REL.cl, CHANGELOG);
  write(REL.clru, CHANGELOG_RU);
  write(REL.div, SETTINGS);
  write(REL.set, SETTINGS);
  write(REL.setru, SETTINGS);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "feature");
  for (const [rel, fn] of Object.entries(branchEdits)) {
    const file = path.join(dir, rel);
    write(rel, fn(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""));
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "edit");
  return { dir, write };
}

const ROW = "| `MYRMIDON_NEW` | N | 1 | new | - |";

describe("parseHunks / mergeHunks", () => {
  it("parses -U0 hunks and defaults counts to 1", () => {
    const h = parseHunks("@@ -3 +3,2 @@ x\n-old\n+a\n+b\n@@ -9,0 +11 @@\n+z\n");
    assert.equal(h.length, 2);
    assert.deepEqual([h[0].oldCount, h[0].newCount, h[0].removed, h[0].added], [1, 2, ["old"], ["a", "b"]]);
    assert.deepEqual([h[1].oldCount, h[1].newStart], [0, 11]);
  });

  it("joins hunks separated only by blank lines of the head", () => {
    const head = ["x", "### T", "", "- bullet", "y"];
    const merged = mergeHunks(
      [
        { oldStart: 1, oldCount: 0, newStart: 2, newCount: 1, removed: [], added: ["### T"] },
        { oldStart: 1, oldCount: 0, newStart: 4, newCount: 1, removed: [], added: ["- bullet"] },
      ],
      head,
    );
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].added, ["### T", "", "- bullet"]);
  });
});

describe("converter round trip", () => {
  const edits = {
    [REL.cl]: (t) => t.replace("\n## 1.0.0", "\n### Feature (F-1)\n\nProse of the feature.\n\n## 1.0.0"),
    [REL.clru]: (t) => t.replace("\n## 1.0.0", "\n### Функция (F-1)\n\nПроза функции.\n\n## 1.0.0"),
    [REL.div]: (t) =>
      t
        // row appended to the first table
        .replace("| `MYRMIDON_OLD` | OLD | `1` | Old setting | `0` |\n", `| \`MYRMIDON_OLD\` | OLD | \`1\` | Old setting | \`0\` |\n${ROW}\n`)
        // existing row rewritten in the second "Twin" section
        .replace("| 2 | second twin | - |", "| 9 | second twin | - |"),
    [REL.set]: (t) =>
      `${t}\n## 1.7 — NEW AREA\n\nProse of the new area.\n\n${TABLE_HEAD}${ROW}\n\n### Sub heading\n\nMore.\n`
        // prose appended at the end of "Track 6 — models"
        .replace("| unset |\n\n## Twin", "| unset |\n\nExtra prose for models.\n\n## Twin"),
    [REL.setru]: (t) => t.replace("Intro line.\n\n## Track 5", "Intro line.\n\nNote after the intro.\n\n## Track 5"),
  };

  it("fragment + revert reproduce the direct edit exactly", () => {
    const { dir } = repoWith(edits);
    const head = Object.fromEntries(Object.values(REL).map((rel) => [rel, git(dir, "show", `feature:${rel}`)]));
    const lines = [];
    const code = run(dir, { slug: "my-feature", base: "main", head: "HEAD", revert: true, log: (l) => lines.push(l) });
    assert.equal(code, 0, lines.join("\n"));
    assert.match(lines.join("\n"), /round trip: exact/);
    // the shared documents are back to main
    for (const rel of Object.values(REL)) assert.equal(fs.readFileSync(path.join(dir, rel), "utf8"), git(dir, "show", `main:${rel}`));
    // the fragment parses with the real parser
    assert.deepEqual(listFragments(dir), ["my-feature.md"]);
    const parsed = parseFragment(fs.readFileSync(path.join(dir, "docs/myrmidon/changes/my-feature.md"), "utf8"));
    assert.ok(parsed.sections["changelog-en"] && parsed.sections["changelog-ru"]);
    assert.ok(parsed.edits.some((e) => e.kind === "new" && e.doc === "settings-en"));
    assert.ok(parsed.edits.some((e) => e.kind === "replace" && e.doc === "divergence"));
    // assembling gives what the PR's direct edit produced
    collect(dir, { version: null });
    for (const rel of Object.values(REL)) assert.equal(fs.readFileSync(path.join(dir, rel), "utf8"), head[rel], rel);
  });

  it("does not write anything when an edit cannot be expressed", () => {
    const { dir } = repoWith({ [REL.set]: (t) => t.replace("Intro line.", "Intro line, reworded.") });
    const lines = [];
    const code = run(dir, { slug: "x", base: "main", head: "HEAD", revert: true, log: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /unsupported: .*SETTINGS\.md.*edits or deletes existing text/);
    assert.deepEqual(listFragments(dir), []);
    assert.match(fs.readFileSync(path.join(dir, REL.set), "utf8"), /reworded/); // not reverted
  });

  it("a bullet added to an existing changelog entry is unsupported", () => {
    const { dir } = repoWith({ [REL.cl]: (t) => t.replace("- Old.\n", "- Old.\n- Extra bullet.\n") });
    const lines = [];
    assert.equal(run(dir, { slug: "x", base: "main", head: "HEAD", log: (l) => lines.push(l) }), 1);
    assert.match(lines.join("\n"), /does not start with a "### Title"/);
  });

  it("no registry edits: nothing to convert", () => {
    const { dir } = repoWith({ "README.md": () => "hello\n" });
    const lines = [];
    assert.equal(run(dir, { slug: "x", base: "main", head: "HEAD", revert: true, log: (l) => lines.push(l) }), 0);
    assert.match(lines.join("\n"), /nothing to convert/);
    assert.deepEqual(listFragments(dir), []);
  });

  it("refuses to overwrite an existing fragment without --force; --dry-run writes nothing", () => {
    const { dir } = repoWith({ [REL.set]: (t) => t.replace("| `MYRMIDON_OLD` | OLD | `1` | Old setting | `0` |\n", `| \`MYRMIDON_OLD\` | OLD | \`1\` | Old setting | \`0\` |\n${ROW}\n`) });
    const quiet = () => {};
    assert.equal(run(dir, { slug: "x", base: "main", head: "HEAD", dryRun: true, log: quiet }), 0);
    assert.deepEqual(listFragments(dir), []);
    assert.equal(run(dir, { slug: "x", base: "main", head: "HEAD", log: quiet }), 0);
    assert.equal(run(dir, { slug: "x", base: "main", head: "HEAD", log: quiet }), 2);
  });

  it("CLI: usage error without --slug; success with it", () => {
    const { dir } = repoWith({ [REL.cl]: (t) => t.replace("\n## 1.0.0", "\n### Feature (F-1)\n\nProse.\n\n## 1.0.0") });
    const bad = execFileSyncStatus(process.execPath, [SCRIPT, "--root", dir, "--base", "main"]);
    assert.equal(bad.status, 2);
    const ok = execFileSyncStatus(process.execPath, [SCRIPT, "--root", dir, "--base", "main", "--slug", "cli-case", "--revert"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(listFragments(dir), ["cli-case.md"]);
  });
});

function execFileSyncStatus(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}
