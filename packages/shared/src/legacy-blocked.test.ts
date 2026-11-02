import { describe, expect, it } from "vitest";
import {
  createLegacyBlockedImportKey,
  legacyBlockedReportRowSchema,
} from "./legacy-blocked.js";

const baseRow = {
  issueId: "123e4567-e89b-42d3-a456-426614174000",
  identifier: "OPE-1",
  oldStatus: "blocked",
  oldBlockers: ["Waiting on upstream"],
  evidence: "Legacy blocked issue",
};

describe("legacy blocked report rows", () => {
  it("accepts the report schema and allows unknown without an owner", () => {
    expect(legacyBlockedReportRowSchema.safeParse({
      ...baseRow,
      class: "unknown",
      importKey: createLegacyBlockedImportKey(baseRow.issueId),
    }).success).toBe(true);
  });

  it("requires an owner for classified rows", () => {
    expect(legacyBlockedReportRowSchema.safeParse({
      ...baseRow,
      class: "dependency",
      importKey: createLegacyBlockedImportKey(baseRow.issueId),
    }).success).toBe(false);
  });

  it("produces a stable import key from issue ID and rule version", () => {
    expect(createLegacyBlockedImportKey(baseRow.issueId)).toBe(
      createLegacyBlockedImportKey(baseRow.issueId),
    );
    expect(createLegacyBlockedImportKey(baseRow.issueId)).not.toBe(
      createLegacyBlockedImportKey("123e4567-e89b-42d3-a456-426614174001"),
    );
  });
});