import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  collect,
  foldAppendBlock,
  foldNewSections,
  foldReplaceRows,
  listFragments,
  parseFragment,
  promoteHeadings,
} from "./collect-fragments.mjs";

// CHANGE-FRAGMENTS, extended format: new sections, prose blocks, row
// replacement and deterministic ordering. Sandbox only, no repository file is
// touched.

const SETTINGS = `# Myrmidon settings

Intro line.

## Track 5 — operations

| Variable | Function | Default | What it does | How to disable |
|---|---|---|---|---|
| \`MYRMIDON_OLD\` | OLD | \`1\` | Old setting | \`0\` |

Prose under the table.

## Track 6 — models

| Variable | Function | Default | What it does | How to disable |
|---|---|---|---|---|
| \`MYRMIDON_MODEL\` | M | \`x\` | Model | unset |

## Twin

| Variable | Function | Default | What it does | How to disable |
|---|---|---|---|---|
| \`MYRMIDON_A\` | A | 1 | first twin | - |

## Twin

| Variable | Function | Default | What it does | How to disable |
|---|---|---|---|---|
| \`MYRMIDON_A\` | A | 2 | second twin | - |
`;

const CHANGELOG = `# Changelog

## Unreleased

### Old entry (OLD-1)

- Old.

## 1.0.0

- Shipped.
`;

function sandbox(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fragments-sections-"));
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return dir;
}

const docs = () => ({
  "docs/myrmidon/CHANGELOG.md": CHANGELOG,
  "docs/myrmidon/CHANGELOG.ru.md": CHANGELOG.replace("Unreleased", "Без выпуска"),
  "docs/myrmidon/DIVERGENCE.md": SETTINGS,
  "docs/myrmidon/SETTINGS.md": SETTINGS,
  "docs/myrmidon/SETTINGS.ru.md": SETTINGS,
});
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf8");

describe("parseFragment: extended sections", () => {
  it("parses a new-section block with directives and promotes headings", () => {
    const { edits } = parseFragment(
      "## settings-en-new\n\n<!-- after: Track 5 — operations -->\n\n### 1.7 — NEW\n\nProse.\n\n#### Sub\n\n| a | b |\n",
      "f.md",
    );
    assert.equal(edits.length, 1);
    assert.equal(edits[0].doc, "settings-en");
    assert.equal(edits[0].kind, "new");
    assert.deepEqual(edits[0].directives, { after: "Track 5 — operations" });
    assert.equal(edits[0].body, "## 1.7 — NEW\n\nProse.\n\n### Sub\n\n| a | b |");
  });

  it("allows the extended families to repeat", () => {
    const { edits } = parseFragment(
      "## divergence-new\n### A\n\nx\n\n## divergence-new\n<!-- after: Track 6 — models -->\n### B\n\ny\n",
      "f.md",
    );
    assert.equal(edits.length, 2);
  });

  it("keeps a code fence containing '## ' as content", () => {
    const { edits } = parseFragment("## settings-en-new\n### A\n\n```md\n## not a heading\n```\n", "f.md");
    assert.match(edits[0].body, /## not a heading/);
    assert.equal(edits[0].body.startsWith("## A"), true);
  });

  it("rejects a new block that does not start with ###", () => {
    assert.throws(() => parseFragment("## settings-en-new\nplain text\n", "f.md"), /must start with a "### <heading>"/);
  });

  it("append needs exactly one anchor; rows-only append needs a section", () => {
    assert.throws(() => parseFragment("## settings-en-append\ntext\n", "f.md"), /exactly one of/);
    assert.throws(
      () => parseFragment("## settings-en-append\n<!-- after-line: x -->\n| a | b |\n", "f.md"),
      /rows-only block needs <!-- section/,
    );
  });

  it("replace takes only rows and a section directive", () => {
    assert.throws(() => parseFragment("## settings-en-replace\ntext\n", "f.md"), /only table rows/);
    assert.throws(
      () => parseFragment("## settings-en-replace\n<!-- after: X -->\n| a | b |\n", "f.md"),
      /accepts only/,
    );
  });

  it("rejects unknown directives and bad occurrence values", () => {
    assert.throws(() => parseFragment("## settings-en-append\n<!-- where: x -->\ntext\n", "f.md"), /unknown directive/);
    assert.throws(
      () => parseFragment("## settings-en-append\n<!-- section: X -->\n<!-- occurrence: 0 -->\ntext\n", "f.md"),
      /positive integer/,
    );
  });

  it("a fragment with only an extended block is valid content", () => {
    assert.doesNotThrow(() => parseFragment("## divergence-new\n### A\n\nx\n", "f.md"));
  });
});

describe("promoteHeadings", () => {
  it("promotes outside fences only", () => {
    assert.equal(promoteHeadings("### A\n#### B\n```\n### keep\n```\ntext"), "## A\n### B\n```\n### keep\n```\ntext");
  });
});

describe("foldNewSections", () => {
  it("appends at the end of the document by default, keeping one final newline", () => {
    const out = foldNewSections(SETTINGS, [{ body: "## New\n\nText." }]);
    assert.equal(out, `${SETTINGS}\n## New\n\nText.\n`);
  });

  it("inserts after the named section, before the next heading", () => {
    const out = foldNewSections(SETTINGS, [{ body: "## New\n\nText.", after: "Track 5 — operations" }]);
    const heads = out.split("\n").filter((l) => l.startsWith("## "));
    assert.deepEqual(heads, ["## Track 5 — operations", "## New", "## Track 6 — models", "## Twin", "## Twin"]);
    assert.match(out, /Prose under the table\.\n\n## New\n\nText\.\n\n## Track 6/);
  });

  it("two inserts at one anchor keep their order", () => {
    const out = foldNewSections(SETTINGS, [
      { body: "## First\n\na", after: "Track 6 — models" },
      { body: "## Second\n\nb", after: "Track 6 — models" },
    ]);
    const heads = out.split("\n").filter((l) => l.startsWith("## "));
    assert.deepEqual(heads.slice(2, 4), ["## First", "## Second"]);
  });

  it("an ambiguous heading is refused unless an occurrence is given", () => {
    assert.throws(() => foldNewSections(SETTINGS, [{ body: "## N\n\nx", after: "Twin" }]), /ambiguous/);
    const out = foldNewSections(SETTINGS, [{ body: "## N\n\nx", after: "Twin", occurrence: 1 }]);
    const heads = out.split("\n").filter((l) => l.startsWith("## "));
    assert.deepEqual(heads.slice(-3), ["## Twin", "## N", "## Twin"]);
  });

  it("after-line anchors right after one exact line", () => {
    const out = foldNewSections(SETTINGS, [{ body: "## N\n\nx", afterLine: "Intro line." }]);
    assert.match(out, /Intro line\.\n\n## N\n\nx\n\n## Track 5/);
  });

  it("names the available sections when the anchor is missing", () => {
    assert.throws(() => foldNewSections(SETTINGS, [{ body: "## N\n\nx", after: "Nope" }]), /have: Track 5/);
  });
});

describe("foldAppendBlock", () => {
  it("adds prose at the end of the named section", () => {
    const out = foldAppendBlock(SETTINGS, { body: "Added prose.", section: "Track 5 — operations" });
    assert.match(out, /Prose under the table\.\n\nAdded prose\.\n\n## Track 6/);
  });

  it("a rows-only block follows the table-row rule", () => {
    const out = foldAppendBlock(SETTINGS, { body: "| `MYRMIDON_NEW` | N | 1 | new | - |", section: "Track 5 — operations" });
    assert.match(out, /\| `MYRMIDON_OLD` .*\n\| `MYRMIDON_NEW` .*\n\nProse under/);
  });

  it("after-line inserts after that line and keeps the following text apart", () => {
    const out = foldAppendBlock(SETTINGS, { body: "Note.", afterLine: "Intro line." });
    assert.match(out, /Intro line\.\n\nNote\.\n\n## Track 5/);
  });

  it("refuses an anchor line that is not unique", () => {
    assert.throws(() => foldAppendBlock(SETTINGS, { body: "x", afterLine: "" }), /matches \d+ lines/);
  });
});

describe("foldReplaceRows", () => {
  it("replaces the row with the same first cell", () => {
    const out = foldReplaceRows(SETTINGS, { rows: "| `MYRMIDON_OLD` | OLD | `2` | Changed | `0` |" });
    assert.match(out, /\| `MYRMIDON_OLD` \| OLD \| `2` \| Changed/);
    assert.equal(out.includes("Old setting"), false);
  });

  it("fails when the key is missing or ambiguous; a section + occurrence disambiguates", () => {
    assert.throws(() => foldReplaceRows(SETTINGS, { rows: "| `NOPE` | x |" }), /matches 0 rows/);
    assert.throws(() => foldReplaceRows(SETTINGS, { rows: "| `MYRMIDON_A` | A | 3 | t | - |" }), /matches 2 rows/);
    const out = foldReplaceRows(SETTINGS, { rows: "| `MYRMIDON_A` | A | 3 | t | - |", section: "Twin", occurrence: 2 });
    assert.match(out, /first twin[\s\S]*\| `MYRMIDON_A` \| A \| 3 \| t/);
    assert.equal(out.includes("second twin"), false);
  });
});

describe("collect with extended fragments", () => {
  it("applies every kind, deletes the fragments, and is independent of creation order", () => {
    const fragA = [
      "---",
      "settings-section: Track 5 — operations",
      "---",
      "",
      "## changelog-en",
      "",
      "### Feature A (A-1)",
      "",
      "Prose of A.",
      "",
      "## settings-en",
      "",
      "| `MYRMIDON_A1` | A-1 | 1 | a | - |",
      "",
      "## settings-en-new",
      "",
      "<!-- after: Track 5 — operations -->",
      "### A section",
      "",
      "Section from A.",
      "",
    ].join("\n");
    const fragB = [
      "## settings-en-new",
      "",
      "<!-- after: Track 5 — operations -->",
      "### B section",
      "",
      "Section from B.",
      "",
      "## settings-en-replace",
      "",
      "| `MYRMIDON_OLD` | OLD | `3` | Changed by B | `0` |",
      "",
    ].join("\n");
    const results = [];
    for (const order of [["a-first.md", "b-second.md"], ["b-second.md", "a-first.md"]]) {
      const dir = sandbox(docs());
      const content = { "a-first.md": fragA, "b-second.md": fragB };
      for (const name of order) {
        const f = path.join(dir, "docs/myrmidon/changes", name);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, content[name]);
      }
      const r = collect(dir, { version: "1.2.3" });
      assert.deepEqual(r.deleted.sort(), ["docs/myrmidon/changes/a-first.md", "docs/myrmidon/changes/b-second.md"]);
      assert.deepEqual(listFragments(dir), []);
      results.push({
        settings: read(dir, "docs/myrmidon/SETTINGS.md"),
        changelog: read(dir, "docs/myrmidon/CHANGELOG.md"),
      });
    }
    assert.deepEqual(results[0], results[1]);
    const { settings, changelog } = results[0];
    const heads = settings.split("\n").filter((l) => l.startsWith("## "));
    assert.deepEqual(heads.slice(0, 4), ["## Track 5 — operations", "## A section", "## B section", "## Track 6 — models"]);
    assert.match(settings, /MYRMIDON_OLD` \| OLD \| `3` \| Changed by B/);
    assert.match(settings, /MYRMIDON_A1/);
    assert.match(changelog, /## 1\.2\.3\n\n### Old entry[\s\S]*### Feature A \(A-1\)\n\nProse of A\./);
  });

  it("preview mode (version null) keeps Unreleased in place and keeps the fragments", () => {
    const dir = sandbox({
      ...docs(),
      "docs/myrmidon/changes/x.md": "## changelog-en\n\n### New block (N-1)\n\nProse.\n",
    });
    const r = collect(dir, { version: null });
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(listFragments(dir), ["x.md"]);
    const cl = read(dir, "docs/myrmidon/CHANGELOG.md");
    assert.match(cl, /## Unreleased\n\n### Old entry \(OLD-1\)\n\n- Old\.\n\n### New block \(N-1\)\n\nProse\.\n\n## 1\.0\.0/);
  });

  it("an unknown anchor fails the collect loudly", () => {
    const dir = sandbox({
      ...docs(),
      "docs/myrmidon/changes/x.md": "## settings-en-append\n<!-- section: Nope -->\ntext\n",
    });
    assert.throws(() => collect(dir, { version: "1.0.1" }), /no "## Nope" section/);
  });

  it("listFragments sorts by plain code-unit order", () => {
    const dir = sandbox({
      "docs/myrmidon/changes/b.md": "x",
      "docs/myrmidon/changes/B.md": "x",
      "docs/myrmidon/changes/a-1.md": "x",
      "docs/myrmidon/changes/README.md": "x",
    });
    assert.deepEqual(listFragments(dir), ["B.md", "a-1.md", "b.md"]);
  });
});
