import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { promoteHeadings } from "./collect-fragments.mjs";

describe("heading promotion contract", () => {
  it("changes only unindented headings of level three or deeper followed by a space", () => {
    const input = "# One\n## Two\n### Three\n#### Four\n###### Six\nplain text\ninline ### hash\n ### Indented\n###No space\n###\tTab\n";
    const expected = "# One\n## Two\n## Three\n### Four\n##### Six\nplain text\ninline ### hash\n ### Indented\n###No space\n###\tTab\n";
    assert.equal(promoteHeadings(input), expected);
  });

  it("preserves headings inside separate backtick and tilde blocks and resumes outside", () => {
    const input = "### Before\n```markdown\n### Backtick three\n#### Backtick four\n```\n#### Between\n~~~markdown\n### Tilde three\n#### Tilde four\n~~~\n###### After";
    const expected = "## Before\n```markdown\n### Backtick three\n#### Backtick four\n```\n### Between\n~~~markdown\n### Tilde three\n#### Tilde four\n~~~\n##### After";
    assert.equal(promoteHeadings(input), expected);
  });

  it("handles empty input and isolates repeated calls", () => {
    assert.equal(promoteHeadings(""), "");
    const a = "### A\n";
    const b = "~~~\n#### B\n~~~\n#### C";
    assert.equal(promoteHeadings(a), "## A\n");
    assert.equal(promoteHeadings(b), "~~~\n#### B\n~~~\n### C");
    assert.equal(promoteHeadings(a), "## A\n");
  });
});
