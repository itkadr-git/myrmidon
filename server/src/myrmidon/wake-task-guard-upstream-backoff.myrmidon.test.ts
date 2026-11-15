// myrmidon(OPE-12803): a streak of gateway upstream errors backs the automatic
// wakes of a task off; other infra codes (connect, rollout) stay exempt.
import { describe, expect, it } from "vitest";
import { resolveSwarmSettings } from "@myrmidon/shared";
import {
  GATEWAY_UPSTREAM_BACKOFF_CEILING_MS,
  decideIssueCooling,
  type CoolingRun,
  type TaskMovement,
} from "./wake-task-guard.js";

const agentId = "agent-1";
const settings = resolveSwarmSettings(undefined);
const now = new Date("2026-11-12T03:00:00Z");

/** Newest first: run i finished (i + 1) minutes ago. */
function runs(codes: Array<string | null>, status = "failed"): CoolingRun[] {
  return codes.map((errorCode, i) => {
    const finishedAt = new Date(now.getTime() - (i + 1) * 60_000);
    return {
      agentId,
      status: errorCode === "ok" ? "succeeded" : status,
      errorCode: errorCode === "ok" ? null : errorCode,
      livenessState: errorCode === "ok" ? "advanced" : null,
      finishedAt,
      startedAt: new Date(finishedAt.getTime() - 7_000),
      createdAt: new Date(finishedAt.getTime() - 7_000),
    };
  });
}
const UP = "hermes_gateway_upstream_error";

describe("OPE-12803 gateway upstream error backoff", () => {
  it("three upstream-error runs in a row (a pickup and its two retries) cool the task", () => {
    const res = decideIssueCooling({ issueStatus: "todo", runs: runs([UP, UP, UP]), moves: [], settings, now });
    expect(res.cooling).toBe(true);
    expect(res.reason).toBe("gateway_upstream_error");
    expect(res.cooldownMin).toBe(30);
  });

  it("two upstream-error runs do not cool", () => {
    expect(decideIssueCooling({ issueStatus: "todo", runs: runs([UP, UP]), moves: [], settings, now }).cooling).toBe(false);
  });

  it("the window grows with the streak and never exceeds the ceiling", () => {
    const four = decideIssueCooling({ issueStatus: "todo", runs: runs([UP, UP, UP, UP]), moves: [], settings, now });
    expect(four.cooldownMin).toBe(60);
    const many = decideIssueCooling({ issueStatus: "todo", runs: runs(Array(12).fill(UP)), moves: [], settings, now: new Date(now.getTime() - 3 * 60_000) });
    expect(many.cooldownMin * 60_000).toBeLessThanOrEqual(GATEWAY_UPSTREAM_BACKOFF_CEILING_MS);
  });

  it("a run with another outcome in front of the streak ends it", () => {
    expect(decideIssueCooling({ issueStatus: "todo", runs: runs(["ok", UP, UP, UP]), moves: [], settings, now }).cooling).toBe(false);
  });

  it("the window ends after its period", () => {
    const later = new Date(now.getTime() + 40 * 60_000);
    expect(decideIssueCooling({ issueStatus: "todo", runs: runs([UP, UP, UP]), moves: [], settings, now: later }).cooling).toBe(false);
  });

  it("task movement by a user after the last run lifts the backoff", () => {
    const moves: TaskMovement[] = [{ at: now.getTime() - 30_000, actorType: "user", actorId: "u1" }];
    expect(decideIssueCooling({ issueStatus: "todo", runs: runs([UP, UP, UP]), moves, settings, now }).cooling).toBe(false);
  });

  it("connect-failed streaks stay exempt (OPE-10784)", () => {
    const res = decideIssueCooling({ issueStatus: "todo", runs: runs(Array(6).fill("hermes_gateway_connect_failed")), moves: [], settings, now });
    expect(res.cooling).toBe(false);
  });
});
