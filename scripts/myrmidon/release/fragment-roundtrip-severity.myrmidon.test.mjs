import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifyRoundTrip } from "./fragments-from-diff.mjs";

const rel = {
  en: "docs/myrmidon/CHANGELOG.md",
  ru: "docs/myrmidon/CHANGELOG.ru.md",
  divergence: "docs/myrmidon/DIVERGENCE.md",
  settings: "docs/myrmidon/SETTINGS.md",
  settingsRu: "docs/myrmidon/SETTINGS.ru.md",
};

const base = {
  [rel.en]: "# Changelog\n\n## Unreleased\n\n### Old\n\n- Old entry\n\n## 1.0\n\n- Released\n",
  [rel.ru]: "# Changelog RU\n\n## Без выпуска\n\n### Old RU\n\n- Old entry RU\n\n## 1.0\n\n- Released RU\n",
  [rel.divergence]: "# Divergence\n\n## Records\n\nFirst divergence\nSecond divergence\n",
  [rel.settings]: "# Settings\n\n## Options\n\nFirst option\nSecond option\n",
  [rel.settingsRu]: "# Settings RU\n\n## Options RU\n\nFirst option RU\nSecond option RU\n",
};
const fragment = "## changelog-en\n\n### New\n\n- New entry\n\n## changelog-ru\n\n### New RU\n\n- New entry RU\n";
const assembled = {
  ...base,
  [rel.en]: base[rel.en].replace("\n## 1.0", "\n### New\n\n- New entry\n\n## 1.0"),
  [rel.ru]: base[rel.ru].replace("\n## 1.0", "\n### New RU\n\n- New entry RU\n\n## 1.0"),
};

function verify(head, expected) {
  const beforeBase = structuredClone(base);
  const beforeHead = structuredClone(head);
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache", "fragment-roundtrip-tests");
  fs.mkdirSync(scratch, { recursive: true });
  const temp = fs.mkdtempSync(path.join(scratch, "severity-"));
  const previous = process.env.FRAGMENT_TMPDIR;
  try {
    process.env.FRAGMENT_TMPDIR = temp;
    for (let i = 0; i < 2; i += 1) {
      assert.deepEqual(verifyRoundTrip(base, head, fragment), expected);
      assert.deepEqual(base, beforeBase);
      assert.deepEqual(head, beforeHead);
      assert.deepEqual(fs.readdirSync(temp), []);
    }
  } finally {
    if (previous === undefined) delete process.env.FRAGMENT_TMPDIR;
    else process.env.FRAGMENT_TMPDIR = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test("exact assembly includes both fragment entries across five documents", () => {
  verify({ ...assembled }, { level: "exact", details: [] });
});

test("blank-only differences have blank severity", () => {
  verify({ ...assembled, [rel.en]: assembled[rel.en].replace("### New\n\n- New entry", "### New\n\n\n- New entry") },
    { level: "blank", details: [`${rel.en}: blank`] });
});

test("reordered lines have moved severity", () => {
  verify({ ...assembled, [rel.divergence]: assembled[rel.divergence].replace("First divergence\nSecond divergence", "Second divergence\nFirst divergence") },
    { level: "moved", details: [`${rel.divergence}: moved`] });
});

test("lost content has different severity", () => {
  verify({ ...assembled, [rel.ru]: assembled[rel.ru].replace("- New entry RU\n", "") },
    { level: "different", details: [`${rel.ru}: different`] });
});

test("worst severity wins and every changed document has its diagnostic", () => {
  verify({
    ...assembled,
    [rel.en]: assembled[rel.en].replace("### New\n\n- New entry", "### New\n\n\n- New entry"),
    [rel.ru]: assembled[rel.ru].replace("- New entry RU\n", ""),
    [rel.divergence]: assembled[rel.divergence].replace("First divergence\nSecond divergence", "Second divergence\nFirst divergence"),
    [rel.settings]: assembled[rel.settings].replace("First option\n", ""),
    [rel.settingsRu]: assembled[rel.settingsRu].replace("First option RU\nSecond option RU", "Second option RU\nFirst option RU"),
  }, {
    level: "different",
    details: [`${rel.en}: blank`, `${rel.ru}: different`, `${rel.divergence}: moved`, `${rel.settings}: different`, `${rel.settingsRu}: moved`],
  });
});
