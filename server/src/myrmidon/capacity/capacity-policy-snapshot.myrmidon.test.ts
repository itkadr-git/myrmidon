import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CapacityPolicySnapshot,
  calculateReadyIssuesCount,
  serializeDeterministicSnapshot,
  validateSnapshot,
} from "./capacity-snapshot.js";

const FIXTURE_PATH = resolve(
  __dirname,
  "../swarm-claim/__fixtures__/capacity-policy-snapshot-1.6.6.json"
);

describe("capacity policy simulation snapshot (OPE-9199)", () => {
  const rawText = readFileSync(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(rawText) as CapacityPolicySnapshot;

  it("fixture adheres strictly to the schema without text or secrets", () => {
    expect(() => validateSnapshot(fixture)).not.toThrow();
  });

  it("contains exactly 276 open issues and ~26 ready issues", () => {
    expect(fixture.issues.length).toBe(276);
    expect(fixture.metrics.totalOpenIssues).toBe(276);
    expect(fixture.metrics.readyIssuesCount).toBe(26);

    const calculatedReady = calculateReadyIssuesCount(
      fixture.issues,
      fixture.issueRelations
    );
    expect(calculatedReady).toBe(26);
  });

  it("verifies absence of any task text, comments, notes, or secrets", () => {
    const forbiddenPatterns = [
      "title",
      "description",
      "comment",
      "comments",
      "secret",
      "token",
      "password",
      "notes",
      "raw",
    ];

    for (const issue of fixture.issues) {
      const keys = Object.keys(issue);
      for (const forbidden of forbiddenPatterns) {
        expect(keys).not.toContain(forbidden);
      }
    }

    for (const rel of fixture.issueRelations) {
      const keys = Object.keys(rel);
      for (const forbidden of forbiddenPatterns) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });

  it("re-export is strictly deterministic across repeated serialization calls", () => {
    const serialized1 = serializeDeterministicSnapshot(fixture);
    const serialized2 = serializeDeterministicSnapshot(fixture);
    expect(serialized1).toBe(serialized2);

    // Verify ordering is independent of input array ordering
    const reversedIssues = [...fixture.issues].reverse();
    const reversedRelations = [...fixture.issueRelations].reverse();
    const shuffled: CapacityPolicySnapshot = {
      ...fixture,
      issues: reversedIssues,
      issueRelations: reversedRelations,
    };

    const serializedShuffled = serializeDeterministicSnapshot(shuffled);
    expect(serializedShuffled).toBe(serialized1);
  });

  describe("schema validation contract enforcement", () => {
    it("rejects non-object or null snapshots", () => {
      expect(() => validateSnapshot(null as any)).toThrow(/must be an object/);
      expect(() => validateSnapshot("string" as any)).toThrow(/must be an object/);
    });

    it("rejects invalid snapshot version", () => {
      expect(() =>
        validateSnapshot({ ...fixture, version: 2 as any })
      ).toThrow(/version must be 1/);
    });

    it("rejects invalid scope", () => {
      expect(() =>
        validateSnapshot({ ...fixture, scope: null as any })
      ).toThrow(/scope must be an object/);
      expect(() =>
        validateSnapshot({
          ...fixture,
          scope: { release: "", companyId: fixture.scope.companyId },
        })
      ).toThrow(/scope.release must be a non-empty string/);
      expect(() =>
        validateSnapshot({
          ...fixture,
          scope: { release: "1.6.6", companyId: "invalid-uuid" },
        })
      ).toThrow(/scope.companyId must be a valid UUID/);
    });

    it("rejects invalid issue identifiers and UUIDs", () => {
      const invalidId = {
        ...fixture,
        issues: [{ ...fixture.issues[0], id: "bad-id" }],
      };
      expect(() => validateSnapshot(invalidId)).toThrow(/valid UUID/);

      const invalidIdentifier = {
        ...fixture,
        issues: [{ ...fixture.issues[0], identifier: "lowercase-1" }],
      };
      expect(() => validateSnapshot(invalidIdentifier)).toThrow(/valid identifier/);
    });

    it("rejects invalid issue status or priority", () => {
      const invalidStatus = {
        ...fixture,
        issues: [{ ...fixture.issues[0], status: "invalid_status" as any }],
      };
      expect(() => validateSnapshot(invalidStatus)).toThrow(/valid status/);

      const invalidPriority = {
        ...fixture,
        issues: [{ ...fixture.issues[0], priority: "urgent" as any }],
      };
      expect(() => validateSnapshot(invalidPriority)).toThrow(/valid priority/);
    });

    it("rejects invalid pheromoneStrength", () => {
      const negativePheromone = {
        ...fixture,
        issues: [{ ...fixture.issues[0], pheromoneStrength: -5 }],
      };
      expect(() => validateSnapshot(negativePheromone)).toThrow(/pheromoneStrength/);

      const floatPheromone = {
        ...fixture,
        issues: [{ ...fixture.issues[0], pheromoneStrength: 1.5 }],
      };
      expect(() => validateSnapshot(floatPheromone)).toThrow(/pheromoneStrength/);
    });

    it("rejects injection of forbidden text or secret keys", () => {
      const injectedTitle = {
        ...fixture,
        issues: [{ ...fixture.issues[0], title: "Injected task title" } as any],
      };
      expect(() => validateSnapshot(injectedTitle)).toThrow(/Forbidden text\/secret field "title"/);

      const injectedSecret = {
        ...fixture,
        issues: [{ ...fixture.issues[0], secret: "leak" } as any],
      };
      expect(() => validateSnapshot(injectedSecret)).toThrow(/Forbidden text\/secret field "secret"/);
    });

    it("rejects invalid relation type or relation UUIDs", () => {
      const invalidRelationType = {
        ...fixture,
        issueRelations: [
          { ...fixture.issueRelations[0], type: "relates_to" as any },
        ],
      };
      expect(() => validateSnapshot(invalidRelationType)).toThrow(/type must be "blocks"/);

      const invalidRelationId = {
        ...fixture,
        issueRelations: [
          { ...fixture.issueRelations[0], id: "not-a-uuid" },
        ],
      };
      expect(() => validateSnapshot(invalidRelationId)).toThrow(/valid UUID/);
    });

    it("rejects mismatch between metrics and actual array contents", () => {
      const mismatchedTotal = {
        ...fixture,
        metrics: { ...fixture.metrics, totalOpenIssues: 999 },
      };
      expect(() => validateSnapshot(mismatchedTotal)).toThrow(
        /totalOpenIssues \(999\) does not match issues\.length \(276\)/
      );

      const mismatchedReady = {
        ...fixture,
        metrics: { ...fixture.metrics, readyIssuesCount: 0 },
      };
      expect(() => validateSnapshot(mismatchedReady)).toThrow(
        /readyIssuesCount \(0\) does not match calculated ready count \(26\)/
      );
    });
  });
});
