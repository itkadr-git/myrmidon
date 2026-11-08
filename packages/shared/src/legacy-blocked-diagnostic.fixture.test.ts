import { describe, expect, it } from "vitest";
import fixture from "./legacy-blocked-diagnostic.fixture.json" with { type: "json" };
import {
  legacyBlockedReportRowSchema,
  createLegacyBlockedImportKey,
} from "./legacy-blocked.js";
import { issueBlockerMetadataSchema } from "./validators/issue.js";

const requiredRowFields = [
  "issueId",
  "identifier",
  "oldStatus",
  "oldBlockers",
  "class",
  "evidence",
  "importKey",
] as const;

describe("legacy blocked diagnostic import fixture", () => {
  it("contains complete report rows and stable import keys", () => {
    expect(fixture.tasks.length).toBeGreaterThanOrEqual(3);

    for (const task of fixture.tasks) {
      for (const field of requiredRowFields) {
        expect(task).toHaveProperty(field);
      }
      expect(task.importKey).toBe(createLegacyBlockedImportKey(task.issueId!));
      expect(legacyBlockedReportRowSchema.safeParse(task).success).toBe(true);
    }
  });

  it("maps every diagnostic blocker reason to valid blockerMetadata", () => {
    const reasons = new Set<string>();

    for (const task of fixture.tasks) {
      const metadata = issueBlockerMetadataSchema.safeParse(task.blockerMetadata);
      expect(metadata.success, `${task.identifier} has invalid blockerMetadata`).toBe(true);
      if (metadata.success && metadata.data && "blockReason" in metadata.data && typeof metadata.data.blockReason === "string") {
        reasons.add(metadata.data.blockReason);
        expect(metadata.data.blockReason).toBe(task.class);
      }
    }

    expect(reasons).toEqual(new Set(["dependency", "human_decision"]));
    expect(fixture.tasks.find((task) => task.class === "unknown")?.blockerMetadata)
      .toHaveProperty("issueRewakeFreeze");
  });
});
