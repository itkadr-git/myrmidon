import { describe, expect, it } from "vitest";
import { selectForagingCandidatePort } from "./candidate-routing.js";
import { skillKeyForRole } from "./domain.js";

describe("Foraging candidate routing", () => {
  it("routes a role-targeted finding to SKILL-LIFECYCLE", async () => {
    const seen: string[] = [];
    let knowledgeCalls = 0;
    const selected = selectForagingCandidatePort(
      { available: true, async createFindingCandidate(input) { seen.push(input.skillKey); return "skill-candidate-ref"; } },
      { available: true, async createFindingCandidate() { knowledgeCalls++; return "knowledge-proposal"; } },
    );
    const input = { companyId: "c", sourceId: "s", role: "smm", url: "https://example.com", skillKey: skillKeyForRole("smm"), summary: "finding", diff: { added: ["text"], removed: [] }, detectedAt: new Date() };

    await expect(selected.createFindingCandidate(input)).resolves.toBe("skill-candidate-ref");
    expect(seen).toEqual([input.skillKey]);
    expect(knowledgeCalls).toBe(0);
  });

  it("uses KNOWLEDGE when the finding is not role-targeted", async () => {
    let skillCalls = 0;
    let knowledgeCalls = 0;
    const selected = selectForagingCandidatePort(
      { available: true, async createFindingCandidate() { skillCalls++; return "skill-candidate-ref"; } },
      { available: true, async createFindingCandidate() { knowledgeCalls++; return "knowledge-proposal"; } },
    );
    const input = { companyId: "c", sourceId: "s", role: "smm", url: "https://example.com", skillKey: "unrelated", summary: "finding", diff: { added: ["text"], removed: [] }, detectedAt: new Date() };

    await expect(selected.createFindingCandidate(input)).resolves.toBe("knowledge-proposal");
    expect(skillCalls).toBe(0);
    expect(knowledgeCalls).toBe(1);
  });
});
