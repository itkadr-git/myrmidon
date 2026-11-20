import assert from "node:assert/strict";
import { test } from "node:test";
import { condenseSection } from "./release-body.mjs";

const version = "1.7.0-rc.1";
const prefix = [
  "## 1.7.0-rc.1",
  "",
  'The full notes of this release are longer than a GitHub release allows; they are in [docs/myrmidon/CHANGELOG.md](docs/myrmidon/CHANGELOG.md) (section "1.7.0-rc.1", RU: docs/myrmidon/CHANGELOG.ru.md) at this tag. Entries:',
  "",
].join("\n");

test("empty section yields only the version and full-notes pointer", () => {
  assert.equal(condenseSection("", version), prefix);
});

test("text and non-entry headings do not become entries", () => {
  const section = [
    "ordinary text", "## Second level", "#### Fourth level", "  ### Nested",
    "- ### List heading", "inline ### Heading", "###No whitespace", "trailing text",
  ].join("\n");
  assert.equal(condenseSection(section, version), prefix);
});

test("third-level entries preserve order, multiplicity, whitespace and Unicode text", () => {
  const section = [
    "## Ignored", "### First entry", "body that must disappear", "###\tПривет мир",
    "#### Ignored", "###   Repeat   ", "### Repeat", " ### Nested", "###\t 日本語 ✨",
  ].join("\n");
  assert.equal(
    condenseSection(section, version),
    `${prefix}\n- First entry\n- Привет мир\n- Repeat\n- Repeat\n- 日本語 ✨`,
  );
});

test("repeated calls keep sections and notes versions isolated", () => {
  const first = condenseSection("### First", version);
  const second = condenseSection("### Second", "2.0.0");
  assert.equal(first, `${prefix}\n- First`);
  assert.equal(second, [
    "## 2.0.0", "",
    'The full notes of this release are longer than a GitHub release allows; they are in [docs/myrmidon/CHANGELOG.md](docs/myrmidon/CHANGELOG.md) (section "2.0.0", RU: docs/myrmidon/CHANGELOG.ru.md) at this tag. Entries:',
    "", "- Second",
  ].join("\n"));
  assert.equal(condenseSection("### First", version), first);
});
