// server/src/myrmidon/goal-judge/domain.myrmidon.test.ts
//
// Unit tests for goal-judge domain and prompts.
//
// Verifies:
// 1. Valid JSON -> parsed verdict.
// 2. Parser rejects non-JSON or invalid schema (does not accept non-JSON).
// 3. Invariant: complete=true when missing is non-empty is rejected as invalid.
// 4. Rule "заявлено, но не проверено = не сделано": claimed without proof in diff or tests -> missing + complete=false.
// 5. Non-JSON response produces a round error without process exception.
// 6. Round counting is strictly tracked and bounded by MAX_ROUNDS (3).

import { describe, expect, it } from "vitest";
import {
  MAX_ROUNDS,
  RULE_CLAIMED_NOT_VERIFIED,
  GoalJudgeSession,
  applyUnverifiedRule,
  extractCriterionKeywords,
  hasEvidenceForCriterion,
  parseGoalJudgeResponse,
  runGoalJudgeRounds,
  validateGoalJudgeVerdict,
  type GoalJudgeInput,
  type GoalJudgeVerdict,
} from "./domain.js";
import {
  GOAL_JUDGE_SYSTEM_PROMPT,
  buildGoalJudgeRetryPrompt,
  buildGoalJudgeUserPrompt,
} from "./prompts.js";

describe("Goal Judge Domain & Prompts", () => {
  describe("Constants and Invariants", () => {
    it("defines MAX_ROUNDS = 3", () => {
      expect(MAX_ROUNDS).toBe(3);
    });

    it("defines rule text for claimed but unverified", () => {
      expect(RULE_CLAIMED_NOT_VERIFIED).toBe("заявлено, но не проверено = не сделано");
    });

    it("rejects verdict validation if complete=true while missing has items", () => {
      const invalidVerdict: GoalJudgeVerdict = {
        score: 1.0,
        complete: true,
        missing: ["Criterion A not verified"],
      };

      const result = validateGoalJudgeVerdict(invalidVerdict);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/complete cannot be true when missing has items/i);
    });

    it("accepts valid verdict with complete=false and missing items", () => {
      const validVerdict: GoalJudgeVerdict = {
        score: 0.5,
        complete: false,
        missing: ["Criterion A not verified"],
      };

      const result = validateGoalJudgeVerdict(validVerdict);
      expect(result.valid).toBe(true);
    });

    it("accepts valid verdict with complete=true and empty missing", () => {
      const validVerdict: GoalJudgeVerdict = {
        score: 1.0,
        complete: true,
        missing: [],
      };

      const result = validateGoalJudgeVerdict(validVerdict);
      expect(result.valid).toBe(true);
    });
  });

  describe("Parser: parseGoalJudgeResponse", () => {
    it("parses valid JSON string into a GoalJudgeVerdict", () => {
      const raw = JSON.stringify({
        score: 1.0,
        complete: true,
        missing: [],
        summary: "All criteria verified with passing unit tests.",
      });

      const parsed = parseGoalJudgeResponse(raw);
      expect(parsed.ok).toBe(true);
      expect(parsed.verdict).toEqual({
        score: 1.0,
        complete: true,
        missing: [],
        summary: "All criteria verified with passing unit tests.",
      });
    });

    it("tolerates markdown code fences containing valid JSON", () => {
      const raw = "```json\n" + JSON.stringify({
        score: 0.8,
        complete: false,
        missing: ["Doc updates pending"],
        summary: "Implementation done, docs missing.",
      }) + "\n```";

      const parsed = parseGoalJudgeResponse(raw);
      expect(parsed.ok).toBe(true);
      expect(parsed.verdict?.complete).toBe(false);
      expect(parsed.verdict?.missing).toEqual(["Doc updates pending"]);
    });

    it("fails when parser receives non-JSON text (does not accept non-JSON)", () => {
      const nonJson = "The task appears to be completed, everything looks good!";
      const parsed = parseGoalJudgeResponse(nonJson);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/Non-JSON response/i);
      expect(parsed.verdict).toBeUndefined();
    });

    it("fails when parser receives empty or whitespace-only response", () => {
      const empty = "   ";
      const parsed = parseGoalJudgeResponse(empty);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/Empty response/i);
    });

    it("fails when JSON has complete=true with non-empty missing", () => {
      const raw = JSON.stringify({
        score: 1.0,
        complete: true,
        missing: ["Missing documentation"],
      });

      const parsed = parseGoalJudgeResponse(raw);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/complete cannot be true when missing has items/i);
    });

    it("fails when JSON violates schema types", () => {
      const badScore = JSON.stringify({ score: "high", complete: true, missing: [] });
      expect(parseGoalJudgeResponse(badScore).ok).toBe(false);

      const badComplete = JSON.stringify({ score: 1.0, complete: "yes", missing: [] });
      expect(parseGoalJudgeResponse(badComplete).ok).toBe(false);

      const badMissing = JSON.stringify({ score: 1.0, complete: true, missing: "none" });
      expect(parseGoalJudgeResponse(badMissing).ok).toBe(false);
    });
  });

  describe("Rule: «заявлено, но не проверено = не сделано»", () => {
    it("detects evidence presence for criterion when diff or tests contain keywords", () => {
      const criterion = "Create `GoalJudgeSession` controller with round limits";
      const diffWithCode = "export class GoalJudgeSession { ... }";
      const testPassed = "PASS src/goal-judge.test.ts (GoalJudgeSession tracks rounds)";

      expect(hasEvidenceForCriterion(criterion, diffWithCode, null)).toBe(true);
      expect(hasEvidenceForCriterion(criterion, null, testPassed)).toBe(true);
    });

    it("reports no evidence when diff and test output are empty or unrelated", () => {
      const criterion = "Add benchmark performance test with 10k items";
      const unrelatedDiff = "export const VERSION = '1.0';";
      const unrelatedTest = "PASS src/version.test.ts";

      expect(hasEvidenceForCriterion(criterion, null, null)).toBe(false);
      expect(hasEvidenceForCriterion(criterion, unrelatedDiff, unrelatedTest)).toBe(false);
    });

    it("reports no evidence when test output is skipped or failed", () => {
      const criterion = "Run database integration test";
      const failedTest = "FAIL src/db.test.ts: connection refused";
      const skippedTest = "SKIPPED src/db.test.ts (all tests skipped)";

      expect(hasEvidenceForCriterion(criterion, null, failedTest)).toBe(false);
      expect(hasEvidenceForCriterion(criterion, null, skippedTest)).toBe(false);
    });

    it("reports no evidence for a Cyrillic criterion against unrelated diff and tests", () => {
      // Reviewer case: Cyrillic keywords must survive normalization (\p{L}),
      // and a criterion with no matching keywords must not be "proven"
      // by the mere presence of any diff and any test output.
      const criterion = "Чужие блоки не трогать";
      const unrelatedDiff = "export const VERSION='1.0';";
      const unrelatedTest = "PASS src/version.test.ts";

      expect(extractCriterionKeywords(criterion)).toContain("чужие");
      expect(hasEvidenceForCriterion(criterion, unrelatedDiff, unrelatedTest)).toBe(false);
    });

    it("reports no evidence when test output mixes failures and passes", () => {
      // Reviewer case: real vitest-style summary "1 failed | 12 passed"
      // must not count as proof just because the word "passed" appears.
      const criterion = "Run database integration test";
      const mixedTest = "Tests  1 failed | 12 passed (13)";

      expect(hasEvidenceForCriterion(criterion, null, mixedTest)).toBe(false);
      expect(hasEvidenceForCriterion(criterion, "+ db connection code", mixedTest)).toBe(false);
    });

    it("reports no evidence for skipped-only tests even with a non-empty diff", () => {
      // Reviewer case: prompts.ts says skipped tests are not proof of
      // completion; a diff alone must not verify a criterion whose tests
      // were only skipped.
      const criterion = "Run database integration test";
      const skippedTest = "SKIPPED src/db.test.ts (all tests skipped)";
      const nonEmptyDiff = "+ db connection code";

      expect(hasEvidenceForCriterion(criterion, nonEmptyDiff, skippedTest)).toBe(false);
    });

    it("moves claimed criterion without evidence into missing and sets complete=false", () => {
      const input: GoalJudgeInput = {
        criteria: [
          "Add prompt templates in prompts.ts",
          "Run benchmark load test with 5000 concurrent agents",
        ],
        claims: [
          "Prompts are added",
          "Benchmark load test was executed and verified",
        ],
        diff: "export const GOAL_JUDGE_SYSTEM_PROMPT = '...';",
        testOutput: "PASS test/prompts.test.ts - 3 passed",
      };

      const initialVerdict: GoalJudgeVerdict = {
        score: 1.0,
        complete: true,
        missing: [],
      };

      const reconciled = applyUnverifiedRule(initialVerdict, input);

      expect(reconciled.complete).toBe(false);
      expect(reconciled.missing).toContain(
        "Run benchmark load test with 5000 concurrent agents",
      );
      expect(reconciled.score).toBeLessThan(1.0);
    });
  });

  describe("Round Management and Non-JSON Handling", () => {
    it("records non-JSON response as round error without throwing a process exception", () => {
      const session = new GoalJudgeSession();
      const nonJsonResponse = "I am an AI and I think this task is totally done!";

      // Must not throw
      let threw = false;
      try {
        const roundResult = session.step(nonJsonResponse);
        expect(roundResult.success).toBe(false);
        expect(roundResult.error).toMatch(/Non-JSON response/i);
        expect(roundResult.roundNumber).toBe(1);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);

      expect(session.currentRound).toBe(1);
      expect(session.rounds).toHaveLength(1);
      expect(session.rounds[0]!.success).toBe(false);
      expect(session.canContinue()).toBe(true);
    });

    it("tracks and increments round counter up to MAX_ROUNDS (3)", () => {
      const session = new GoalJudgeSession();
      expect(session.currentRound).toBe(0);
      expect(session.maxRounds).toBe(3);

      // Round 1: invalid response
      session.step("invalid response 1");
      expect(session.currentRound).toBe(1);
      expect(session.canContinue()).toBe(true);

      // Round 2: invalid response
      session.step("invalid response 2");
      expect(session.currentRound).toBe(2);
      expect(session.canContinue()).toBe(true);

      // Round 3: invalid response
      session.step("invalid response 3");
      expect(session.currentRound).toBe(3);
      expect(session.canContinue()).toBe(false);

      // Attempting round 4 should be refused / halted
      const overflowResult = session.step("attempt round 4");
      expect(overflowResult.success).toBe(false);
      expect(overflowResult.error).toMatch(/Max rounds limit reached/i);
      expect(session.currentRound).toBe(3);
    });

    it("completes on valid verdict with complete=true and stops further rounds", () => {
      const session = new GoalJudgeSession();
      const validCompleteJson = JSON.stringify({
        score: 1.0,
        complete: true,
        missing: [],
        summary: "Verified with tests.",
      });

      const result = session.step(validCompleteJson);
      expect(result.success).toBe(true);
      expect(session.isComplete).toBe(true);
      expect(session.finalVerdict?.complete).toBe(true);
      expect(session.canContinue()).toBe(false);
    });

    it("runs multi-round evaluation loop via runGoalJudgeRounds up to limit", async () => {
      const input: GoalJudgeInput = {
        criteria: "Implement goal judge domain",
        // Evidence must reference the criterion keywords ("goal judge domain"),
        // otherwise applyUnverifiedRule forces complete=false and the loop
        // correctly continues to the next round ("заявлено, но не проверено = не сделано").
        diff: "export const MAX_ROUNDS = 3; // goal judge domain",
        testOutput: "PASS 4 passed (goal judge domain)",
      };

      let callCount = 0;
      const fakeModel = async (_prompt: string, round: number) => {
        callCount++;
        if (round === 1) {
          // Round 1 returns non-JSON
          return "Plain text error";
        }
        // Round 2 returns valid JSON
        return JSON.stringify({
          score: 1.0,
          complete: true,
          missing: [],
          summary: "Done in round 2",
        });
      };

      const outcome = await runGoalJudgeRounds(input, fakeModel);

      expect(callCount).toBe(2);
      expect(outcome.session.currentRound).toBe(2);
      expect(outcome.verdict?.complete).toBe(true);
      expect(outcome.session.rounds[0]!.success).toBe(false);
      expect(outcome.session.rounds[1]!.success).toBe(true);
    });
  });

  describe("Prompts", () => {
    it("system prompt specifies the core rule and strict JSON format", () => {
      expect(GOAL_JUDGE_SYSTEM_PROMPT).toContain("Заявлено, но не проверено = не сделано");
      expect(GOAL_JUDGE_SYSTEM_PROMPT).toContain("JSON SCHEMA");
      expect(GOAL_JUDGE_SYSTEM_PROMPT).toContain("If \"missing\" is non-empty, \"complete\" MUST be false");
    });

    it("user prompt formats criteria, diff, testOutput and claims", () => {
      const input: GoalJudgeInput = {
        criteria: ["Check criterion 1", "Check criterion 2"],
        diff: "+ const x = 1;",
        testOutput: "PASS test.ts",
        claims: ["Fixed bug"],
      };

      const prompt = buildGoalJudgeUserPrompt(input, { round: 2, maxRounds: 3 });
      expect(prompt).toContain("Check criterion 1");
      expect(prompt).toContain("+ const x = 1;");
      expect(prompt).toContain("PASS test.ts");
      expect(prompt).toContain("Fixed bug");
      expect(prompt).toContain("EVALUATION ROUND: 2 of 3");
    });

    it("retry prompt reminds about strict JSON and missing/complete invariant", () => {
      const retry = buildGoalJudgeRetryPrompt("Non-JSON returned", 2);
      expect(retry).toContain("Round 2 output failed validation: Non-JSON returned");
      expect(retry).toContain("complete MUST be false");
    });
  });
});
