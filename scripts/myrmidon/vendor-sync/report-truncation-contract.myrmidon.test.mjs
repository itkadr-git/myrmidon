import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "./lib.mjs";

const commits = [
  { sha: "123456789aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subject: "first vendor change" },
  { sha: "abcdef012bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", subject: "second vendor change" },
  { sha: "fedcba987ccccccccccccccccccccccccccccccc", subject: "third vendor change" },
];

function reportFor(count, commitLimit) {
  return buildReport({
    tag: "v2026.908.0",
    base: "v2026.901.0",
    baseBranch: "main",
    branch: "sync/v2026.908.0",
    outcome: "merged",
    commits: commits.slice(0, count),
    commitLimit,
    classified: { workflows: [], migrations: [], marked: [], dependencies: [] },
  });
}

describe("vendor sync report commit truncation", () => {
  const cases = [
    { count: 0, limit: 2, lines: ["none"] },
    { count: 1, limit: 2, lines: ["- `123456789` first vendor change"] },
    { count: 2, limit: 2, lines: ["- `123456789` first vendor change", "- `abcdef012` second vendor change"] },
    { count: 3, limit: 2, lines: ["- `123456789` first vendor change", "- `abcdef012` second vendor change", "", "…and 1 more (`git log --oneline main..v2026.908.0`)."] },
    { count: 3, limit: 0, lines: ["none", "", "…and 3 more (`git log --oneline main..v2026.908.0`)."] },
  ];

  for (const { count, limit, lines } of cases) {
    it(`reports ${count} commits with limit ${limit}`, () => {
      const report = reportFor(count, limit);
      assert.deepEqual(report.match(/^- Vendor commits in range: .*$/gm), [`- Vendor commits in range: ${count}`]);
      const sections = report.split("## Vendor commits\n\n");
      assert.equal(sections.length, 2);
      assert.deepEqual(sections[1].trimEnd().split("\n"), lines);
      for (const commit of commits.slice(Math.min(count, limit))) {
        assert.equal(report.includes(commit.subject), false);
      }
      assert.equal(report.endsWith("\n"), true);
      assert.equal(report.endsWith("\n\n"), false);
      assert.equal(report.includes("\n\n\n"), false);
    });
  }
});
