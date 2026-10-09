// myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the pure half of the per-caste
// counters — the roster by role, the queue by caste (a task without a caste
// belongs to the company default), and who is free right now.

import { describe, expect, it } from "vitest";
import { casteCounts } from "./casteCounts";
import type { CasteView } from "./castesApi";

function caste(key: string, overrides: Partial<CasteView> = {}): CasteView {
  return {
    key,
    nameEn: key,
    nameRu: key,
    description: "",
    color: "var(--hex-3b82f6)",
    icon: "bot",
    defaultModel: null,
    swarmEligible: true,
    maxActiveTasks: null,
    builtIn: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("casteCounts", () => {
  const castes = [caste("engineer", { isDefault: true }), caste("reviewer")];

  it("counts the roster per caste and drops terminated agents", () => {
    const counts = casteCounts(
      castes,
      [
        { id: "a1", role: "engineer", status: "idle" },
        { id: "a2", role: "engineer", status: "running" },
        { id: "a3", role: "reviewer", status: "active" },
        { id: "a4", role: "engineer", status: "terminated" },
      ],
      [],
    );
    expect(counts.engineer?.agents).toBe(2);
    expect(counts.reviewer?.agents).toBe(1);
  });

  it("puts a queued task without a caste on the company default", () => {
    const counts = casteCounts(
      castes,
      [],
      [
        { assigneeAgentId: null, casteKey: null },
        { assigneeAgentId: null, casteKey: "reviewer" },
        { assigneeAgentId: null },
      ],
    );
    expect(counts.engineer?.queued).toBe(2);
    expect(counts.reviewer?.queued).toBe(1);
  });

  it("does not count a task somebody already holds", () => {
    const counts = casteCounts(castes, [], [
      { assigneeAgentId: "a1", casteKey: "engineer" },
    ]);
    expect(counts.engineer?.queued).toBe(0);
  });

  it("reads a running agent as busy and an idle one as free", () => {
    const counts = casteCounts(
      castes,
      [
        { id: "a1", role: "engineer", status: "running" },
        { id: "a2", role: "engineer", status: "idle" },
        { id: "a3", role: "engineer", status: "paused" },
      ],
      [],
    );
    expect(counts.engineer?.free).toBe(1);
  });

  it("counts nothing on a company without a default flag", () => {
    const counts = casteCounts([caste("engineer"), caste("reviewer")], [], [
      { assigneeAgentId: null },
    ]);
    expect(counts.engineer?.queued).toBe(0);
    expect(counts.reviewer?.queued).toBe(0);
  });
});