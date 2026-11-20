import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { collect } from "./collect-fragments.mjs";

const CHANGELOG_EN = `# Myrmidon changelog

## Unreleased

### Existing entry (OLD)

- Already here.

## 1.6.2

- Shipped.
`;

const CHANGELOG_RU = `# Журнал изменений Myrmidon

## Без выпуска

### Старая запись (OLD)

- Уже здесь.

## 1.6.2

- Вышло.
`;

const FRAGMENT = `## changelog-en

### Preview entry (PREVIEW-1)

- This is collected during preview.

## changelog-ru

### Запись preview (PREVIEW-1)

- Собирается во время preview.
`;

function makeTree({ withFragment = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "collect-preview-"));
  const files = {
    "docs/myrmidon/CHANGELOG.md": CHANGELOG_EN,
    "docs/myrmidon/CHANGELOG.ru.md": CHANGELOG_RU,
  };
  fs.mkdirSync(path.join(root, "docs/myrmidon/changes"), { recursive: true });
  if (withFragment) files["docs/myrmidon/changes/preview.md"] = FRAGMENT;
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return root;
}

function snapshot(root) {
  return {
    en: fs.readFileSync(path.join(root, "docs/myrmidon/CHANGELOG.md"), "utf8"),
    ru: fs.readFileSync(path.join(root, "docs/myrmidon/CHANGELOG.ru.md"), "utf8"),
    fragment: fs.readFileSync(path.join(root, "docs/myrmidon/changes/preview.md"), "utf8"),
  };
}

function removeTree(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

describe("collect preview", () => {
  it("folds into both Unreleased sections, keeps fragments, and is deterministic", () => {
    const first = makeTree();
    const second = makeTree();
    try {
      const firstResult = collect(first, { version: null });
      const secondResult = collect(second, { version: null });

      assert.deepEqual(firstResult, {
        changed: ["docs/myrmidon/CHANGELOG.md", "docs/myrmidon/CHANGELOG.ru.md"],
        deleted: [],
        fragments: ["docs/myrmidon/changes/preview.md"],
      });
      assert.deepEqual(secondResult, firstResult);
      assert.deepEqual(snapshot(second), snapshot(first));
      assert.equal(snapshot(first).en, CHANGELOG_EN.replace("\n## 1.6.2", "\n### Preview entry (PREVIEW-1)\n\n- This is collected during preview.\n\n## 1.6.2"));
      assert.equal(snapshot(first).ru, CHANGELOG_RU.replace("\n## 1.6.2", "\n### Запись preview (PREVIEW-1)\n\n- Собирается во время preview.\n\n## 1.6.2"));
      assert.equal(snapshot(first).fragment, FRAGMENT);
      assert.equal(fs.existsSync(path.join(first, "docs/myrmidon/changes/preview.md")), true);
    } finally {
      removeTree(first);
      removeTree(second);
    }
  });

  it("returns an empty plan and leaves documents unchanged with no changes", () => {
    const root = makeTree({ withFragment: false });
    try {
      const before = {
        en: fs.readFileSync(path.join(root, "docs/myrmidon/CHANGELOG.md"), "utf8"),
        ru: fs.readFileSync(path.join(root, "docs/myrmidon/CHANGELOG.ru.md"), "utf8"),
      };
      assert.deepEqual(collect(root, { version: null }), { changed: [], deleted: [], fragments: [] });
      assert.deepEqual(
        {
          en: fs.readFileSync(path.join(root, "docs/myrmidon/CHANGELOG.md"), "utf8"),
          ru: fs.readFileSync(path.join(root, "docs/myrmidon/CHANGELOG.ru.md"), "utf8"),
        },
        before,
      );
    } finally {
      removeTree(root);
    }
  });
});
