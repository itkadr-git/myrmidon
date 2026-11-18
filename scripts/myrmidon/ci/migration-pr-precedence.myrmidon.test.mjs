import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkOpenPrCollisions } from "./migration-guard.mjs";

describe("open PR migration precedence", () => {
  const added = ["packages/db/src/migrations/0007_ours.sql"];
  const pulls = [{ number: 20, files: ["packages/db/src/migrations/0007_theirs.sql"] }];
  const collision = "Migration number 0007 is already reserved in open PR #20: packages/db/src/migrations/0007_theirs.sql. Next free number: 0008. Renumber using: pnpm db:renumber 0007 0008";

  it("reserves for the lower PR, excludes self, and accepts numeric or string current IDs", () => {
    assert.deepEqual(checkOpenPrCollisions(added, pulls, 19), []);
    assert.deepEqual(checkOpenPrCollisions(added, pulls, "19"), []);
    assert.deepEqual(checkOpenPrCollisions(added, pulls, 20), []);
    assert.deepEqual(checkOpenPrCollisions(added, pulls, "20"), []);
    assert.deepEqual(checkOpenPrCollisions(added, pulls, 21), [collision]);
    assert.deepEqual(checkOpenPrCollisions(added, pulls, "21"), [collision]);
    assert.deepEqual(checkOpenPrCollisions(added, pulls), [collision]);
  });

  it("reports every matching file in pull and file order, ignoring non-SQL and missing files", () => {
    const files = ["packages/db/src/migrations/0001_ours.sql", ...added];
    const competitors = [
      { number: 10 },
      { number: 11, files: ["packages/db/src/migrations/9999_note.json", "packages/db/src/migrations/0007_first.sql", "packages/db/src/migrations/0001_first.sql"] },
      { number: 12, files: ["packages/db/src/migrations/0007_second.sql", "docs/0001_note.txt"] },
      { number: 30, files: ["packages/db/src/migrations/0012_later.sql", "packages/db/src/migrations/0007_later.sql"] },
      { number: 20, files: ["packages/db/src/migrations/0012_self.sql", "packages/db/src/migrations/0007_ours.sql"] },
    ];
    assert.deepEqual(checkOpenPrCollisions(files, competitors, 20), [
      "Migration number 0007 is already reserved in open PR #11: packages/db/src/migrations/0007_first.sql. Next free number: 0013. Renumber using: pnpm db:renumber 0007 0013",
      "Migration number 0001 is already reserved in open PR #11: packages/db/src/migrations/0001_first.sql. Next free number: 0013. Renumber using: pnpm db:renumber 0001 0013",
      "Migration number 0007 is already reserved in open PR #12: packages/db/src/migrations/0007_second.sql. Next free number: 0013. Renumber using: pnpm db:renumber 0007 0013",
    ]);
  });

  it("includes self and newer PR reservations independently in the next number", () => {
    assert.deepEqual(checkOpenPrCollisions(added, [
      { number: 10, files: ["packages/db/src/migrations/0007_old.sql"] },
      { number: 20, files: ["packages/db/src/migrations/0012_self.sql"] },
    ], 20), ["Migration number 0007 is already reserved in open PR #10: packages/db/src/migrations/0007_old.sql. Next free number: 0013. Renumber using: pnpm db:renumber 0007 0013"]);
    assert.deepEqual(checkOpenPrCollisions(added, [
      { number: 10, files: ["packages/db/src/migrations/0007_old.sql"] },
      { number: 30, files: ["packages/db/src/migrations/0012_new.sql"] },
    ], 20), ["Migration number 0007 is already reserved in open PR #10: packages/db/src/migrations/0007_old.sql. Next free number: 0013. Renumber using: pnpm db:renumber 0007 0013"]);
  });

  it("does not mutate inputs or retain reservations between calls", () => {
    const files = ["packages/db/src/migrations/0007_ours.sql"];
    const competitors = [
      { number: 10, files: ["packages/db/src/migrations/0007_other.sql", "packages/db/src/migrations/0012_other.sql"] },
      { number: 20, files: ["packages/db/src/migrations/0007_self.sql"] },
    ];
    const original = structuredClone({ files, competitors });
    assert.deepEqual(checkOpenPrCollisions(files, competitors, 20), ["Migration number 0007 is already reserved in open PR #10: packages/db/src/migrations/0007_other.sql. Next free number: 0013. Renumber using: pnpm db:renumber 0007 0013"]);
    assert.deepEqual(checkOpenPrCollisions(files, competitors, 10), []);
    assert.deepEqual(checkOpenPrCollisions(files, [{ number: 5, files: ["packages/db/src/migrations/0007_new.sql"] }], 10), ["Migration number 0007 is already reserved in open PR #5: packages/db/src/migrations/0007_new.sql. Next free number: 0008. Renumber using: pnpm db:renumber 0007 0008"]);
    assert.deepEqual({ files, competitors }, original);
  });

  it("returns no collisions for unrelated SQL or non-SQL inputs", () => {
    assert.deepEqual(checkOpenPrCollisions(["packages/db/src/migrations/0007_ours.sql", "notes/0001_readme.txt"], [
      { number: 1 },
      { number: 2, files: ["packages/db/src/migrations/0001_other.sql", "packages/db/src/migrations/0007_snapshot.json"] },
    ], 3), []);
    assert.deepEqual(checkOpenPrCollisions([], pulls, 21), []);
  });
});
