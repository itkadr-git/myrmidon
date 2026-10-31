import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  migrationNumber,
  checkMainCollisions,
  checkGeneratorCollisions,
  openPrWarnings,
} from "./migration-guard.mjs";

const sql = (name) => `packages/db/src/migrations/${name}.sql`;
const scriptPath = fileURLToPath(new URL("./migration-guard.mjs", import.meta.url));

test("migrationNumber extracts 4-digit number from paths", () => {
  assert.equal(migrationNumber("packages/db/src/migrations/0421_fixed_grim_reaper.sql"), "0421");
  assert.equal(migrationNumber("0422_interaction_routing.sql"), "0422");
  assert.equal(migrationNumber("packages/db/src/migrations/meta/0421_snapshot.json"), null);
  assert.equal(migrationNumber("packages/db/src/migrations/meta/_journal.json"), null);
  assert.equal(migrationNumber(null), null);
});

test("0421 already in main fails with the next free number", () => {
  const errors = checkMainCollisions(
    [sql("0420_old"), sql("0421_fixed_grim_reaper")],
    [sql("0421_other_change")],
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /0421 is already occupied in main by .*0421_fixed_grim_reaper/);
  assert.match(errors[0], /Next free number: 0422/);
  assert.match(errors[0], /snapshot and journal/);
});

test("one PR cannot introduce two SQL migrations with the same number", () => {
  const errors = checkMainCollisions([sql("0421_main")], [sql("0422_a"), sql("0422_b")]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /also used in this PR/);
});

test("an open PR collision warns but does not fail", () => {
  assert.deepEqual(openPrWarnings([sql("0422_ours")], [
    { number: 1802, files: [sql("0422_theirs"), sql("0423_other")] },
  ]), ["Migration number 0422 is also used by open PR #1802: " + sql("0422_theirs") + ". Coordinate renumbering before merge."]);
});

test("unrelated PRs and non-SQL files have no collision", () => {
  assert.deepEqual(checkMainCollisions([sql("0421_main")], ["packages/db/src/migrations/meta/0421_snapshot.json", sql("0422_new")]), []);
  assert.deepEqual(openPrWarnings([sql("0422_new")], [{ number: 1, files: [sql("0423_other")] }]), []);
});

test("generator collision check fails if local journal is behind main", () => {
  const mainFiles = [sql("0420_old"), sql("0421_grim_reaper"), sql("0422_interaction_routing")];
  const localFiles = [sql("0420_old")];
  const staleJournal = {
    entries: [
      { idx: 420, tag: "0420_old" },
    ],
  };

  const errors = checkGeneratorCollisions(mainFiles, localFiles, staleJournal);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Cannot generate migrations/);
  assert.match(errors[0], /origin\/main contains migration 0422/);
  assert.match(errors[0], /local migration journal only goes up to 0420/);
  assert.match(errors[0], /silently create duplicate migration numbers \(0421\)/);
  assert.match(errors[0], /next free number in main is 0423/);
});

test("generator collision check fails if local SQL has different file for same number in main", () => {
  const mainFiles = [sql("0421_main_version")];
  const localFiles = [sql("0421_local_diverged_version")];
  const journal = {
    entries: [
      { idx: 421, tag: "0421_local_diverged_version" },
    ],
  };

  const errors = checkGeneratorCollisions(mainFiles, localFiles, journal);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /is occupied in main by .*0421_main_version/);
  assert.match(errors[0], /Update main before generating/);
});

test("generator collision check passes when local checkout is up to date with main", () => {
  const mainFiles = [sql("0421_main"), sql("0422_main")];
  const localFiles = [sql("0421_main"), sql("0422_main")];
  const journal = {
    entries: [
      { idx: 421, tag: "0421_main" },
      { idx: 422, tag: "0422_main" },
    ],
  };

  const errors = checkGeneratorCollisions(mainFiles, localFiles, journal);
  assert.deepEqual(errors, []);
});

test("CLI rejects invalid mode or missing arguments", () => {
  assert.throws(
    () => execFileSync("node", [scriptPath, "unknown-mode"], { stdio: "pipe", encoding: "utf8" }),
    (err) => err.status === 1 && /Usage: migration-guard\.mjs/.test(err.stderr || err.stdout),
  );
  assert.throws(
    () => execFileSync("node", [scriptPath, "pr", "not-a-sha", "123"], { stdio: "pipe", encoding: "utf8" }),
    (err) => err.status === 1 && /Expected a 40-character head SHA/.test(err.stderr || err.stdout),
  );
});
