import { describe, expect, it } from "vitest";
import {
  ensureJournalMatchesFiles,
  ensureNoDuplicateIndices,
  ensureNoDuplicates,
  ensureStrictlyOrdered,
  migrationNumber,
  validateMigrationNumbering,
} from "./check-migration-numbering.js";

describe("check-migration-numbering", () => {
  it("extracts 4-digit migration number prefix", () => {
    expect(migrationNumber("0422_interaction_routing.sql")).toBe("0422");
    expect(migrationNumber("0422_interaction_routing")).toBe("0422");
    expect(migrationNumber("not_a_migration.sql")).toBeNull();
  });

  it("accepts a clean migration files and journal sequence", () => {
    const files = ["0001_initial.sql", "0002_add_users.sql", "0003_add_roles.sql"];
    const journal = {
      entries: [
        { idx: 1, tag: "0001_initial" },
        { idx: 2, tag: "0002_add_users" },
        { idx: 3, tag: "0003_add_roles" },
      ],
    };
    expect(() => validateMigrationNumbering(files, journal)).not.toThrow();
  });

  it("RED: flags duplicate migration number in files (collision between parallel branches)", () => {
    const files = [
      "0001_initial.sql",
      "0002_branch_a.sql",
      "0002_branch_b.sql",
    ];
    const journal = {
      entries: [
        { idx: 1, tag: "0001_initial" },
        { idx: 2, tag: "0002_branch_a" },
        { idx: 3, tag: "0002_branch_b" },
      ],
    };
    expect(() => validateMigrationNumbering(files, journal)).toThrow(
      /Duplicate migration number 0002 in migration files: 0002_branch_a\.sql, 0002_branch_b\.sql/,
    );
  });

  it("RED: flags duplicate migration number in journal tags", () => {
    const files = ["0001_initial.sql", "0002_branch_a.sql"];
    const journal = {
      entries: [
        { idx: 1, tag: "0001_initial" },
        { idx: 2, tag: "0002_branch_a" },
        { idx: 3, tag: "0002_branch_a" },
      ],
    };
    expect(() => validateMigrationNumbering(files, journal)).toThrow(
      /Duplicate migration number 0002 in migration journal/,
    );
  });

  it("RED: flags duplicate idx in journal entries", () => {
    const entries = [
      { idx: 1, tag: "0001_initial" },
      { idx: 2, tag: "0002_branch_a" },
      { idx: 2, tag: "0003_branch_b" },
    ];
    expect(() => ensureNoDuplicateIndices(entries)).toThrow(
      /Duplicate migration idx 2 in migration journal: 0002_branch_a, 0003_branch_b/,
    );
  });

  it("RED: flags mismatch between journal idx and tag 4-digit prefix", () => {
    const entries = [
      { idx: 1, tag: "0001_initial" },
      { idx: 5, tag: "0002_branch_a" },
    ];
    expect(() => ensureNoDuplicateIndices(entries)).toThrow(
      /entry 1 idx \(5\) does not match tag number \(0002\)/,
    );
  });

  it("RED: flags out-of-order migration files", () => {
    const files = ["0002_add_users.sql", "0001_initial.sql"];
    expect(() => ensureStrictlyOrdered(files, "migration files")).toThrow(
      /migration files are out of order at position 0: expected 0001_initial\.sql, found 0002_add_users\.sql/,
    );
  });

  it("RED: flags journal and file count mismatch", () => {
    const files = ["0001_initial.sql", "0002_add_users.sql"];
    const journalTags = ["0001_initial"];
    expect(() => ensureJournalMatchesFiles(files, journalTags)).toThrow(
      /Migration journal\/file count mismatch: journal has 1, files have 2/,
    );
  });

  it("RED: flags journal and file order mismatch", () => {
    const files = ["0001_initial.sql", "0002_add_users.sql"];
    const journalTags = ["0002_add_users", "0001_initial"];
    expect(() => ensureJournalMatchesFiles(files, journalTags)).toThrow(
      /Migration journal\/file order mismatch at position 0: journal has 0002_add_users\.sql, files have 0001_initial\.sql/,
    );
  });
});
