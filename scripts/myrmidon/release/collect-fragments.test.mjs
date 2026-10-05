import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  collect,
  foldChangelog,
  foldTableRows,
  listFragments,
  parseFragment,
} from "./collect-fragments.mjs";

// CHANGE-FRAGMENTS: unit tests of the release fragment collector. Everything
// runs against a sandbox directory; no repository file is touched.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "collect-fragments.mjs");

function sandbox(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collect-fragments-"));
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return dir;
}

const CHANGELOG_EN = `# Myrmidon changelog

> Russian version: [CHANGELOG.ru.md](CHANGELOG.ru.md)

## Unreleased

### Existing unreleased entry (OLD-1)

- A line.

## 1.6.2

- Shipped.
`;

const CHANGELOG_RU = `# Журнал изменений Myrmidon

## Без выпуска

### Старая запись без выпуска (OLD-1)

- Строка.

## 1.6.2

- Вышло.
`;

const DIVERGENCE = `# Реестр отличий

## Трек 5 — эксплуатация

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| OLD | Старое | \`server/src/x.ts\` | Причина | \`x.test.ts\` | Никогда | [#1](https://example.com/1) |

## Трек 6 — безопасность и модели

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
`;

const SETTINGS = `# Myrmidon settings

## Track 5 — operations

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| \`MYRMIDON_OLD\` | OLD | \`1\` | Old setting | \`0\` — off |

## Track 6 — security and models

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
`;

const SETTINGS_RU = `# Настройки Myrmidon

## Track 5 — operations

| Переменная | Функция | Умолчание | Что делает | Как выключить / особенности |
|---|---|---|---|---|
`;

const FRAGMENT_A = `---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Feature A (FEAT-A)

- New behaviour A.

## changelog-ru

### Функция A (FEAT-A)

- Новое поведение A.

## divergence

| FEAT-A | Feature A | + \`server/src/myrmidon/feat-a.ts\` | Reason A | \`feat-a.myrmidon.test.ts\` | Never | [#2](https://example.com/2) |

## settings-en

| \`MYRMIDON_FEAT_A\` | FEAT-A | \`5\` | Knob A | \`0\` — off |

## settings-ru

| \`MYRMIDON_FEAT_A\` | FEAT-A | \`5\` | Ручка A | \`0\` — выкл |
`;

const FRAGMENT_B = `## changelog-en

### Feature B (FEAT-B)

- Docs only.

## changelog-ru

### Функция B (FEAT-B)

- Только документация.
`;

function fullTree(extra = {}) {
  return sandbox({
    "docs/myrmidon/CHANGELOG.md": CHANGELOG_EN,
    "docs/myrmidon/CHANGELOG.ru.md": CHANGELOG_RU,
    "docs/myrmidon/DIVERGENCE.md": DIVERGENCE,
    "docs/myrmidon/SETTINGS.md": SETTINGS,
    "docs/myrmidon/SETTINGS.ru.md": SETTINGS_RU,
    "docs/myrmidon/changes/feat-a.md": FRAGMENT_A,
    "docs/myrmidon/changes/feat-b.md": FRAGMENT_B,
    ...extra,
  });
}

describe("parseFragment", () => {
  it("parses front matter and all five sections", () => {
    const { meta, sections } = parseFragment(FRAGMENT_A, "feat-a.md");
    assert.equal(meta["divergence-section"], "Трек 5 — эксплуатация");
    assert.equal(meta["settings-section"], "Track 5 — operations");
    assert.deepEqual(Object.keys(sections).sort(), [
      "changelog-en",
      "changelog-ru",
      "divergence",
      "settings-en",
      "settings-ru",
    ]);
    assert.match(sections["changelog-en"], /^### Feature A/);
    assert.match(sections.divergence, /^\| FEAT-A \|/);
  });

  it("parses a fragment without front matter", () => {
    const { meta, sections } = parseFragment(FRAGMENT_B, "feat-b.md");
    assert.deepEqual(meta, {});
    assert.deepEqual(Object.keys(sections).sort(), ["changelog-en", "changelog-ru"]);
  });

  it("rejects a fragment with no content", () => {
    assert.throws(() => parseFragment("---\n---\n\n## changelog-en\n\n", "empty.md"), /nothing to collect/);
  });

  it("rejects an unknown section", () => {
    assert.throws(() => parseFragment("## change-log\n\n- x\n", "bad.md"), /unknown section/);
  });

  it("rejects non-table content in the divergence section", () => {
    assert.throws(
      () =>
        parseFragment(
          "---\ndivergence-section: X\n---\n\n## divergence\n\nnot a row\n",
          "bad.md",
        ),
      /only table rows/,
    );
  });

  it("requires divergence-section when divergence rows are present", () => {
    assert.throws(
      () => parseFragment("## divergence\n\n| A | b |\n", "bad.md"),
      /no "divergence-section"/,
    );
  });

  it("requires settings-section when settings rows are present", () => {
    assert.throws(
      () => parseFragment("## settings-en\n\n| A | b |\n", "bad.md"),
      /no "settings-section"/,
    );
  });

  it("rejects a stray top-level heading inside a section", () => {
    assert.throws(
      () => parseFragment("## changelog-en\n\n# Oops\n", "bad.md"),
      /unexpected heading/,
    );
  });
});

describe("listFragments", () => {
  it("lists markdown fragments, skips README.md, sorted", () => {
    const dir = sandbox({
      "docs/myrmidon/changes/b.md": "x",
      "docs/myrmidon/changes/a.md": "x",
      "docs/myrmidon/changes/README.md": "x",
    });
    assert.deepEqual(listFragments(dir), ["a.md", "b.md"]);
  });

  it("returns an empty list when the directory does not exist", () => {
    assert.deepEqual(listFragments(sandbox()), []);
  });
});

describe("foldChangelog", () => {
  it("renames Unreleased to the version, keeps entries, leaves an empty Unreleased", () => {
    const out = foldChangelog(CHANGELOG_EN, {
      version: "1.7.0",
      unreleasedHeading: "Unreleased",
      blocks: ["### New entry (FEAT-A)\n\n- A line."],
    });
    const unreleased = out.indexOf("## Unreleased");
    const version = out.indexOf("## 1.7.0");
    const old = out.indexOf("### Existing unreleased entry");
    const added = out.indexOf("### New entry (FEAT-A)");
    const shipped = out.indexOf("## 1.6.2");
    assert.ok(unreleased !== -1 && version !== -1 && shipped !== -1);
    assert.ok(unreleased < version, "Unreleased stays on top");
    assert.ok(version < old && old < added && added < shipped, "order: version, old entry, new entry, previous version");
    // The new Unreleased section is empty.
    const between = out.slice(unreleased, version);
    assert.doesNotMatch(between, /###/);
  });

  it("fails loudly when the Unreleased heading is missing", () => {
    assert.throws(
      () => foldChangelog("## 1.6.2\n", { version: "1.7.0", unreleasedHeading: "Unreleased", blocks: [] }),
      /no "## Unreleased" section/,
    );
  });
});

describe("foldTableRows", () => {
  it("appends rows to the named section only", () => {
    const out = foldTableRows(DIVERGENCE, {
      sectionHeading: "Трек 5 — эксплуатация",
      rows: "| NEW | New | `f.ts` | Why | `t.ts` | Never | [#3](https://example.com/3) |",
    });
    const track5 = out.indexOf("## Трек 5");
    const track6 = out.indexOf("## Трек 6");
    const row = out.indexOf("| NEW |");
    assert.ok(track5 < row && row < track6, "the row lands inside track 5");
    assert.equal(out.match(/\| NEW \|/g).length, 1);
  });

  it("names the known sections when the requested one is missing", () => {
    assert.throws(
      () => foldTableRows(DIVERGENCE, { sectionHeading: "Нет такого", rows: "| A |" }, { fileName: "f.md" }),
      /no "## Нет такого" section \(have: Трек 5 — эксплуатация \| Трек 6/,
    );
  });
});

describe("collect", () => {
  it("folds two fragments into all four documents and deletes the fragments", () => {
    const dir = fullTree();
    const result = collect(dir, { version: "1.7.0" });
    assert.deepEqual(result.deleted, [
      "docs/myrmidon/changes/feat-a.md",
      "docs/myrmidon/changes/feat-b.md",
    ]);
    assert.deepEqual([...result.changed].sort(), [
      "docs/myrmidon/CHANGELOG.md",
      "docs/myrmidon/CHANGELOG.ru.md",
      "docs/myrmidon/DIVERGENCE.md",
      "docs/myrmidon/SETTINGS.md",
      "docs/myrmidon/SETTINGS.ru.md",
    ]);
    const en = fs.readFileSync(path.join(dir, "docs/myrmidon/CHANGELOG.md"), "utf8");
    assert.match(en, /## 1\.7\.0\n\n### Existing unreleased entry \(OLD-1\)\n\n- A line\.\n\n### Feature A \(FEAT-A\)\n\n- New behaviour A\.\n\n### Feature B \(FEAT-B\)/);
    assert.match(en, /## Unreleased\n\n## 1\.7\.0/);
    const ru = fs.readFileSync(path.join(dir, "docs/myrmidon/CHANGELOG.ru.md"), "utf8");
    assert.match(ru, /## Без выпуска\n\n## 1\.7\.0/);
    assert.match(ru, /### Функция B \(FEAT-B\)/);
    const divergence = fs.readFileSync(path.join(dir, "docs/myrmidon/DIVERGENCE.md"), "utf8");
    assert.match(divergence, /\| FEAT-A \| Feature A \|/);
    const settings = fs.readFileSync(path.join(dir, "docs/myrmidon/SETTINGS.md"), "utf8");
    assert.match(settings, /\| `MYRMIDON_FEAT_A` \| FEAT-A \|/);
    const settingsRu = fs.readFileSync(path.join(dir, "docs/myrmidon/SETTINGS.ru.md"), "utf8");
    assert.match(settingsRu, /Ручка A/);
    assert.equal(fs.existsSync(path.join(dir, "docs/myrmidon/changes/feat-a.md")), false);
    assert.equal(fs.existsSync(path.join(dir, "docs/myrmidon/changes/feat-b.md")), false);
  });

  it("a one-sided changelog language fails loudly", () => {
    const dir = fullTree({
      "docs/myrmidon/changes/feat-b.md": "## changelog-en\n\n### Only EN\n\n- x\n",
    });
    assert.throws(() => collect(dir, { version: "1.7.0" }), /counts differ/);
  });

  it("with no fragments nothing changes and the run is green", () => {
    const dir = fullTree();
    fs.rmSync(path.join(dir, "docs/myrmidon/changes"), { recursive: true });
    const result = collect(dir, { version: "1.7.0" });
    assert.deepEqual(result, { changed: [], deleted: [], fragments: [] });
  });

  it("--dry-run writes nothing", () => {
    const dir = fullTree();
    collect(dir, { version: "1.7.0", dryRun: true });
    assert.ok(fs.existsSync(path.join(dir, "docs/myrmidon/changes/feat-a.md")));
    assert.match(fs.readFileSync(path.join(dir, "docs/myrmidon/CHANGELOG.md"), "utf8"), /## Unreleased\n\n### Existing/);
  });

  it("CLI: collects end to end and reports the count", () => {
    const dir = fullTree();
    const out = execFileSync("node", [SCRIPT, "--version", "1.7.0", "--root", dir], {
      encoding: "utf8",
    });
    assert.match(out, /collected 2 fragment\(s\) into 5 document\(s\)/);
  });

  it("CLI: a missing version is a usage error", () => {
    const res = spawnSync("node", [SCRIPT, "--root", os.tmpdir()], { encoding: "utf8" });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /usage: collect-fragments/);
  });

  it("CLI: an unknown section in a fragment is reported, exit 1", () => {
    const dir = fullTree({
      "docs/myrmidon/changes/feat-b.md": "## changlog-en\n\n- typo\n",
    });
    const res = spawnSync("node", [SCRIPT, "--version", "1.7.0", "--root", dir], {
      encoding: "utf8",
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /feat-b\.md: unknown section/);
    // A failed collect leaves the tree untouched.
    assert.ok(fs.existsSync(path.join(dir, "docs/myrmidon/changes/feat-a.md")));
  });
});
