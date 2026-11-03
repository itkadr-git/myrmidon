import { describe, expect, it } from "vitest";
import { diffSchemaSnapshots } from "../commands/myrmidon-schema-diff.js";

describe("myrmidon:schema-diff", () => {
  const source = {
    tables: [{ name: "issues", columns: [{ name: "id", dataType: "bigint" }, { name: "title", dataType: "text" }] }],
  };

  it("returns success for matching schemas", () => {
    expect(diffSchemaSnapshots(source, source)).toMatchObject({ ok: true, issues: [] });
  });

  it("reports missing columns", () => {
    const report = diffSchemaSnapshots(source, { tables: [{ name: "issues", columns: [{ name: "id", dataType: "bigint" }] }] });
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual({ kind: "column-missing-in-target", table: "issues", column: "title" });
  });

  it("reports type mismatches", () => {
    const report = diffSchemaSnapshots(source, {
      tables: [{ name: "issues", columns: [{ name: "id", dataType: "integer" }, { name: "title", dataType: "text" }] }],
    });
    expect(report.issues).toContainEqual({
      kind: "column-type-mismatch",
      table: "issues",
      column: "id",
      sourceType: "bigint",
      targetType: "integer",
    });
  });
});
