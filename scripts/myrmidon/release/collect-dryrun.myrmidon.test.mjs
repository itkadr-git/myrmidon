import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collect } from "./collect-fragments.mjs";

const base = "docs/myrmidon/";
const files = {
  [`${base}CHANGELOG.md`]: "# Changelog\n\n## Unreleased\n\n### Previous\n\n- Existing.\n\n## 1.6.0\n\n- Released.\n",
  [`${base}CHANGELOG.ru.md`]: "# Changelog RU\n\n## Без выпуска\n\n### Previous RU\n\n- Existing RU.\n\n## 1.6.0\n\n- Released RU.\n",
  [`${base}DIVERGENCE.md`]: "# Registry\n\n## Track 5 - operations\n\n| ID | Description |\n|---|---|\n| OLD | Existing |\n",
  [`${base}SETTINGS.md`]: "# Settings\n\n## Track 5 - operations\n\n| Variable | Description |\n|---|---|\n| OLD | Existing |\n",
  [`${base}SETTINGS.ru.md`]: "# Settings RU\n\n## Track 5 - operations\n\n| Variable | Description |\n|---|---|\n| OLD | Existing RU |\n",
  [`${base}changes/README.md`]: "# Keep this file\n",
  [`${base}changes/a.md`]: "---\ndivergence-section: Track 5 - operations\nsettings-section: Track 5 - operations\n---\n\n## changelog-en\n\n### Feature A\n\n- Added A.\n\n## changelog-ru\n\n### Feature A RU\n\n- Added A RU.\n\n## divergence\n\n| FEATURE-A | Added |\n\n## settings-en\n\n| FEATURE_A | Enabled |\n\n## settings-ru\n\n| FEATURE_A | Enabled RU |\n",
  [`${base}changes/b.md`]: "## changelog-en\n\n### Feature B\n\n- Added B.\n\n## changelog-ru\n\n### Feature B RU\n\n- Added B RU.\n",
  "unrelated.bin": Buffer.from([0, 255, 1, 10]),
};

function snapshot(root) {
  const entries = {};
  function visit(dir, relative = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        entries[`${name}/`] = null;
        visit(path.join(dir, entry.name), name);
      } else {
        entries[name] = fs.readFileSync(path.join(dir, entry.name));
      }
    }
  }
  visit(root);
  return entries;
}

test("release dry-run is repeatable, preserves every byte and predicts the real collection", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "collect-dryrun-"));
  try {
    const dry = path.join(scratch, "dry");
    const real = path.join(scratch, "real");
    for (const root of [dry, real]) {
      for (const [name, contents] of Object.entries(files)) {
        const target = path.join(root, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
      }
    }
    const before = snapshot(dry);
    assert.deepEqual(snapshot(real), before);
    const expected = {
      changed: ["CHANGELOG.md", "CHANGELOG.ru.md", "DIVERGENCE.md", "SETTINGS.md", "SETTINGS.ru.md"].map((name) => base + name),
      deleted: [base + "changes/a.md", base + "changes/b.md"],
      fragments: [base + "changes/a.md", base + "changes/b.md"],
    };
    const first = collect(dry, { version: "1.7.0", dryRun: true });
    assert.deepEqual(first, expected);
    assert.deepEqual(snapshot(dry), before);
    const second = collect(dry, { version: "1.7.0", dryRun: true });
    assert.deepEqual(second, first);
    assert.deepEqual(snapshot(dry), before);

    const actual = collect(real, { version: "1.7.0" });
    assert.deepEqual(actual, expected);
    const after = snapshot(real);
    const changed = Object.keys(before).filter((name) => before[name] !== null && after[name] !== undefined && !before[name].equals(after[name])).sort();
    const deleted = Object.keys(before).filter((name) => !(name in after)).sort();
    const added = Object.keys(after).filter((name) => !(name in before)).sort();
    assert.deepEqual(changed, [...first.changed].sort());
    assert.deepEqual(deleted, [...first.deleted].sort());
    assert.deepEqual(added, []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
