import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "./lib.mjs";

const headers = [
  "Conflicts",
  "Registry rows that may now be removable",
  "Workflows (.github/workflows)",
  "New database migrations",
  "Vendor changes in files with our `myrmidon(` markers",
  "Dependencies and image (package.json, pnpm-lock.yaml, Dockerfile)",
  "Vendor commits",
];

function sections(report) {
  const parts = report.trimEnd().split(/\n(?=## )/);
  return parts.slice(1).map((part) => {
    const [heading, ...body] = part.split("\n");
    return [heading.slice(3), body.join("\n").trim()];
  });
}

const fixture = {
  tag: "v2026.908.0",
  base: "v2026.901.0",
  baseBranch: "main",
  branch: "sync/v2026.908.0",
  commits: [],
  conflicts: ["server/alpha.ts", "ui/beta.ts"],
  conflictRows: [
    { file: "server/alpha.ts", row: { section: "Track 2", raw: "| P1 | server/alpha.ts |" } },
    { file: "ui/beta.ts", row: { section: "Track 3", raw: "| P2 | ui/beta.ts |" } },
  ],
  removable: [
    { row: { id: "vendor:abc1234", section: "Track 2" }, reasons: ["vendor #42 is in the range", "commit abc1234 is in the range"] },
    { row: { id: "P2", section: "Track 3" }, reasons: ["vendor #99 is in the range"] },
  ],
  classified: {
    workflows: [{ status: "A", path: ".github/workflows/release.yml" }],
    migrations: [{ status: "A", path: "packages/db/src/migrations/0300_new.sql" }],
    marked: [{ status: "M", path: "server/marked.ts" }],
    dependencies: [{ status: "M", path: "package.json" }, { status: "A", path: "Dockerfile" }],
  },
};

const sharedSections = [
  [headers[1], "The vendor PR or commit named in the row is in this range. Check the row's removal condition.\n\n- **vendor:abc1234** (Track 2): vendor #42 is in the range; commit abc1234 is in the range\n- **P2** (Track 3): vendor #99 is in the range"],
  [headers[2], "New or changed vendor workflows. The maintainer decides whether to disable them.\n\n- `.github/workflows/release.yml` — new"],
  [headers[3], "- `packages/db/src/migrations/0300_new.sql` — new"],
  [headers[4], "- `server/marked.ts` — changed"],
  [headers[5], "- `package.json` — changed\n- `Dockerfile` — new"],
  [headers[6], "none"],
];

describe("buildReport conflict and category contract", () => {
  it("isolates conflict details from merged output for identical inputs", () => {
    const conflict = buildReport({ ...fixture, outcome: "conflict" });
    const merged = buildReport({ ...fixture, outcome: "merged" });
    assert.match(conflict, /- Outcome: \*\*conflict\*\*/);
    assert.match(merged, /- Outcome: \*\*merged\*\*/);
    assert.deepEqual(sections(conflict), [
      [headers[0], "The merge was aborted. Files with conflicts:\n\n- `server/alpha.ts`\n- `ui/beta.ts`\n\nRegistry rows (DIVERGENCE.md) that name these files:\n\n- `server/alpha.ts`: Track 2 — | P1 | server/alpha.ts |\n- `ui/beta.ts`: Track 3 — | P2 | ui/beta.ts |"],
      ...sharedSections,
    ]);
    assert.deepEqual(sections(merged), sharedSections);
    for (const detail of ["## Conflicts", "The merge was aborted", "server/alpha.ts", "ui/beta.ts", "| P1 | server/alpha.ts |", "| P2 | ui/beta.ts |"]) {
      assert.equal(merged.includes(detail), false, detail);
      assert.equal(conflict.includes(detail), true, detail);
    }
    assert.notEqual(conflict, merged);
  });

  it("places none in each empty collection's own section", () => {
    const empty = {
      ...fixture,
      outcome: "conflict",
      conflicts: [],
      conflictRows: [],
      removable: [],
      classified: { workflows: [], migrations: [], marked: [], dependencies: [] },
    };
    assert.deepEqual(sections(buildReport(empty)), [
      [headers[0], "The merge was aborted. Files with conflicts:\n\nnone\n\nRegistry rows (DIVERGENCE.md) that name these files:\n\nnone"],
      [headers[1], "The vendor PR or commit named in the row is in this range. Check the row's removal condition.\n\nnone"],
      [headers[2], "New or changed vendor workflows. The maintainer decides whether to disable them.\n\nnone"],
      [headers[3], "none"],
      [headers[4], "none"],
      [headers[5], "none"],
      [headers[6], "none"],
    ]);
  });
});
