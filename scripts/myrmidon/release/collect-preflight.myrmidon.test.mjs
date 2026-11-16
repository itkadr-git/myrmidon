import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collect } from "./collect-fragments.mjs";

const documents = {
  "docs/myrmidon/CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n### Existing\n\n- Existing entry.\n\n## 1.6.0\n\n- Released.\n",
  "docs/myrmidon/CHANGELOG.ru.md": "# Changelog RU\n\n## Без выпуска\n\n### Existing RU\n\n- Existing entry.\n\n## 1.6.0\n\n- Released.\n",
  "docs/myrmidon/DIVERGENCE.md": "# Divergence\n\n## Existing\n\n| ID | Description |\n|---|---|\n| OLD | Old |\n",
  "docs/myrmidon/SETTINGS.md": "# Settings\n\n## Existing\n\n| Key | Description |\n|---|---|\n| OLD | Old |\n",
  "docs/myrmidon/SETTINGS.ru.md": "# Settings RU\n\n## Existing\n\n| Key | Description |\n|---|---|\n| OLD | Old |\n",
};

const bilingual = "## changelog-en\n\n### Feature\n\n- English.\n\n## changelog-ru\n\n### Feature RU\n\n- Russian.\n";

function snapshot(root) {
  const files = {};
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else files[name] = fs.readFileSync(path.join(root, name));
    }
  }
  visit("");
  return files;
}

function assertPreflightPreservesTree(fragments, expectedError) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "collect-preflight-"));
  try {
    const files = { ...documents, ...fragments };
    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(root, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    const before = snapshot(root);
    assert.equal(Object.keys(before).length, Object.keys(files).length);
    assert.throws(() => collect(root, { version: "1.7.0" }), expectedError);
    assert.deepEqual(snapshot(root), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("unequal nonzero language counts leave every document and fragment unchanged", () => {
  assertPreflightPreservesTree({
    "docs/myrmidon/changes/a.md": bilingual,
    "docs/myrmidon/changes/b.md": "## changelog-en\n\n### Second feature\n\n- English only.\n",
  }, /changelog-en \(2\) and changelog-ru \(1\) fragment counts differ/);
});

test("missing registry section leaves already prepared changelogs and fragments unchanged", () => {
  assertPreflightPreservesTree({
    "docs/myrmidon/changes/a.md": "---\nsettings-section: Missing section\n---\n\n" + bilingual + "\n## settings-en\n\n| NEW | New setting |\n",
  }, /no "## Missing section" section/i);
});

test("invalid late fragment leaves documents and earlier valid fragment unchanged", () => {
  assertPreflightPreservesTree({
    "docs/myrmidon/changes/a.md": bilingual,
    "docs/myrmidon/changes/z.md": "---\nsettings-section: Existing\n\n## settings-en\n\n| NEW | New |\n",
  }, /z\.md: front matter opened but never closed/);
});
