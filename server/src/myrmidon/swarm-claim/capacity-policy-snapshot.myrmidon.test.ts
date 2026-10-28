import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  calculateReadyIssuesCount,
  FORBIDDEN_CONTENT_KEYS,
  serializeDeterministicSnapshot,
  validateSnapshot,
  type CapacityPolicySnapshot,
} from "./capacity-snapshot.js";

const fixtureUrl = new URL("./__fixtures__/capacity-policy-snapshot-1.6.6.json", import.meta.url);
const rawFixture = readFileSync(fixtureUrl, "utf8");
const fixtureData = JSON.parse(rawFixture) as CapacityPolicySnapshot;

describe("capacity policy snapshot (1.6.6 P2.12 / OPE-9199)", () => {
  it("conforms to the structural snapshot schema", () => {
    const validated = validateSnapshot(fixtureData);
    expect(validated.version).toBe(1);
    expect(validated.scope.release).toBe("1.6.6");
    expect(validated.metrics.totalOpenIssues).toBe(276);
    expect(validated.metrics.readyIssuesCount).toBe(26);
    expect(validated.issues).toHaveLength(276);
    expect(validated.issueRelations.length).toBeGreaterThan(0);
  });

  it("produces deterministic re-export output", () => {
    const serializedFirst = serializeDeterministicSnapshot(fixtureData);
    expect(serializedFirst).toBe(rawFixture);

    const reparsed = JSON.parse(serializedFirst) as CapacityPolicySnapshot;
    const serializedSecond = serializeDeterministicSnapshot(reparsed);
    expect(serializedSecond).toBe(rawFixture);
  });

  it("strictly excludes task texts, comments, and secrets", () => {
    for (const issue of fixtureData.issues) {
      for (const key of Object.keys(issue)) {
        expect(FORBIDDEN_CONTENT_KEYS.has(key.toLowerCase())).toBe(false);
      }
      expect(issue).not.toHaveProperty("title");
      expect(issue).not.toHaveProperty("description");
      expect(issue).not.toHaveProperty("comment");
      expect(issue).not.toHaveProperty("comments");
      expect(issue).not.toHaveProperty("body");
      expect(issue).not.toHaveProperty("text");
    }

    for (const rel of fixtureData.issueRelations) {
      for (const key of Object.keys(rel)) {
        expect(FORBIDDEN_CONTENT_KEYS.has(key.toLowerCase())).toBe(false);
      }
      expect(rel).not.toHaveProperty("title");
      expect(rel).not.toHaveProperty("description");
      expect(rel).not.toHaveProperty("comment");
      expect(rel).not.toHaveProperty("comments");
    }

    expect(rawFixture).not.toMatch(/"title"\s*:/i);
    expect(rawFixture).not.toMatch(/"description"\s*:/i);
    expect(rawFixture).not.toMatch(/"comment"\s*:/i);
    expect(rawFixture).not.toMatch(/"comments"\s*:/i);
  });

  it("verifies ready issue counts match simulation baseline (276 open, 26 ready)", () => {
    const readyCount = calculateReadyIssuesCount(fixtureData.issues, fixtureData.issueRelations);
    expect(readyCount).toBe(26);
    expect(fixtureData.issues.length).toBe(276);
  });
});
