import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertChangelogVersion } from "./collect-fragments.mjs";

const version = "1.7.0";

for (const { language, unreleasedHeading, fileName } of [
  { language: "EN", unreleasedHeading: "Unreleased", fileName: "docs/myrmidon/CHANGELOG.md" },
  { language: "RU", unreleasedHeading: "Без выпуска", fileName: "docs/myrmidon/CHANGELOG.ru.md" },
]) {
  describe(`${language} publish gate diagnostics`, () => {
    const options = { version, unreleasedHeading, fileName };
    const valid = `# Changelog\n\n## ${unreleasedHeading}\n \t\n\n## ${version}\n\n- Release note.\n`;

    it("accepts a version with notes and whitespace-only unreleased", () => {
      assert.equal(assertChangelogVersion(valid, options), undefined);
    });

    it("identifies the missing unreleased heading", () => {
      assert.throws(() => assertChangelogVersion(`## ${version}\n- Note\n`, options), {
        message: `${fileName}: no "## ${unreleasedHeading}" section — the release cut must leave an empty one on top`,
      });
    });

    it("identifies unreleased entries and the requested destination", () => {
      const doc = `## ${unreleasedHeading}\n\n- Pending\n\n## ${version}\n- Shipped\n`;
      assert.throws(() => assertChangelogVersion(doc, options), {
        message: `${fileName}: "## ${unreleasedHeading}" is not empty — leftover entries never reach the release body; move them under "## ${version}" or drop them`,
      });
    });

    it("does not substitute neighboring versions for the missing target", () => {
      const doc = `## ${unreleasedHeading}\n\n## 1.7.1\n- Newer\n\n## 1.6.9\n- Older\n`;
      assert.throws(() => assertChangelogVersion(doc, options), {
        message: `${fileName}: no "## ${version}" section — the release cut must rename the collected entries before the tag`,
      });
    });

    it("does not count notes after the next H2 as target notes", () => {
      const doc = `## ${unreleasedHeading}\n\n## ${version}\n \t\n\n## 1.6.9\n- Older notes\n`;
      assert.throws(() => assertChangelogVersion(doc, options), {
        message: `${fileName}: "## ${version}" is empty — a release without notes is a defect`,
      });
    });

    it("accepts a valid document after a failed check", () => {
      assert.throws(() => assertChangelogVersion(`## ${unreleasedHeading}\n`, options), {
        message: `${fileName}: no "## ${version}" section — the release cut must rename the collected entries before the tag`,
      });
      assert.equal(assertChangelogVersion(valid, options), undefined);
    });
  });
}
