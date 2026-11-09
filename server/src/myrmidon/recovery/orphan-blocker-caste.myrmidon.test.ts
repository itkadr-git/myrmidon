import { describe, expect, it } from "vitest";
import { orphanBlockerFitsCreator } from "./orphan-blocker-caste.js";

describe("orphanBlockerFitsCreator (OPE-12220)", () => {
  it("keeps the vendor behaviour for an issue without a caste", () => {
    expect(orphanBlockerFitsCreator({ issueCasteKey: null, creatorRole: "lead" })).toBe(true);
    expect(orphanBlockerFitsCreator({ issueCasteKey: "", creatorRole: "lead" })).toBe(true);
  });
  it("assigns back to a creator of the same caste", () => {
    expect(orphanBlockerFitsCreator({ issueCasteKey: "engineer", creatorRole: "engineer" })).toBe(true);
  });
  it("does not hand an engineer subtask to the lead that sliced it", () => {
    expect(orphanBlockerFitsCreator({ issueCasteKey: "engineer", creatorRole: "lead" })).toBe(false);
    expect(orphanBlockerFitsCreator({ issueCasteKey: "engineer", creatorRole: null })).toBe(false);
  });
});
