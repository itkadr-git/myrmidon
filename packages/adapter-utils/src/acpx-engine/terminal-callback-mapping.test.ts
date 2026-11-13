import { describe, expect, it } from "vitest";
import {
  TerminalCallbackRegistry,
  mapTerminalCallback,
  type TerminalCallbackInput,
} from "./terminal-callback-mapping.js";

// myrmidon(1.8 ACP / OPE-12942): each terminal callback maps exactly once,
// duplicate callbacks are idempotent, and malformed/unknown provider state
// never closes the issue. The completion gate: a "completed" callback with
// no evidence never maps to done.

function cb(overrides: Partial<TerminalCallbackInput> = {}): TerminalCallbackInput {
  return {
    provider: "hermes_gateway",
    providerJobId: "job-1",
    status: "completed",
    completionEvidence: { output: "final answer" },
    ...overrides,
  };
}

describe("mapTerminalCallback", () => {
  it("maps each terminal status exactly once to its board state", () => {
    expect(mapTerminalCallback(cb({ status: "completed" }))).toEqual({ kind: "terminal", boardState: "done" });
    expect(mapTerminalCallback(cb({ status: "failed" }))).toEqual({ kind: "terminal", boardState: "failed" });
    expect(mapTerminalCallback(cb({ status: "cancelled" }))).toEqual({ kind: "terminal", boardState: "cancelled" });
    expect(mapTerminalCallback(cb({ status: "succeeded" }))).toEqual({ kind: "terminal", boardState: "done" });
    expect(mapTerminalCallback(cb({ status: "error" }))).toEqual({ kind: "terminal", boardState: "failed" });
    expect(mapTerminalCallback(cb({ status: "canceled" }))).toEqual({ kind: "terminal", boardState: "cancelled" });
  });

  it("does not close the issue on a completed callback without completion evidence", () => {
    for (const evidence of [null, undefined, { output: null }, { output: "", result: "  " }]) {
      const mapping = mapTerminalCallback(cb({ completionEvidence: evidence }));
      expect(mapping).toEqual({ kind: "non_terminal", holdReason: "completion_evidence_missing" });
    }
  });

  it("accepts result text as completion evidence", () => {
    expect(mapTerminalCallback(cb({ completionEvidence: { output: null, result: "r" } }))).toEqual({
      kind: "terminal",
      boardState: "done",
    });
  });

  it("never closes the issue on malformed or unknown provider state", () => {
    expect(mapTerminalCallback(cb({ status: null }))).toEqual({ kind: "non_terminal", holdReason: "malformed_provider_status" });
    expect(mapTerminalCallback(cb({ status: undefined }))).toEqual({ kind: "non_terminal", holdReason: "malformed_provider_status" });
    expect(mapTerminalCallback(cb({ status: "" }))).toEqual({ kind: "non_terminal", holdReason: "malformed_provider_status" });
    expect(mapTerminalCallback(cb({ status: "   " }))).toEqual({ kind: "non_terminal", holdReason: "malformed_provider_status" });
    expect(mapTerminalCallback(cb({ status: 42 as unknown as string }))).toEqual({
      kind: "non_terminal",
      holdReason: "malformed_provider_status",
    });
    expect(mapTerminalCallback(cb({ status: "exploded_with_flair" }))).toEqual({
      kind: "non_terminal",
      holdReason: "unknown_provider_status",
    });
  });

  it("treats known in-flight statuses as progress holds, not verdicts", () => {
    expect(mapTerminalCallback(cb({ status: "running" }))).toEqual({ kind: "non_terminal", holdReason: "provider_status_in_flight" });
    expect(mapTerminalCallback(cb({ status: "QUEUED" }))).toEqual({ kind: "non_terminal", holdReason: "provider_status_in_flight" });
  });

  it("is case- and whitespace-tolerant for well-formed statuses", () => {
    expect(mapTerminalCallback(cb({ status: "  Completed " }))).toEqual({ kind: "terminal", boardState: "done" });
  });

  it("normalizes a missing job id to a stable reconciliation key", () => {
    expect(mapTerminalCallback(cb({ providerJobId: null }))).toEqual({ kind: "terminal", boardState: "done" });
  });
});

describe("TerminalCallbackRegistry", () => {
  it("applies the first terminal callback and replays it idempotently on duplicates", () => {
    const registry = new TerminalCallbackRegistry();
    const first = registry.apply(cb({ status: "completed" }));
    expect(first.applied).toBe(true);
    expect(first.mapping).toEqual({ kind: "terminal", boardState: "done" });

    // Same-status duplicate.
    const duplicateSame = registry.apply(cb({ status: "completed" }));
    expect(duplicateSame.applied).toBe(false);
    expect(duplicateSame.mapping).toEqual(first.mapping);

    // Late contradictory duplicate must not flip the recorded verdict.
    const duplicateContradictory = registry.apply(cb({ status: "failed" }));
    expect(duplicateContradictory.applied).toBe(false);
    expect(duplicateContradictory.mapping).toEqual(first.mapping);

    expect(registry.recordedMapping("job-1")).toEqual({ kind: "terminal", boardState: "done" });
  });

  it("keys idempotence by provider job id, not by provider or status", () => {
    const registry = new TerminalCallbackRegistry();
    registry.apply(cb({ providerJobId: "job-a", status: "failed" }));
    const otherJob = registry.apply(cb({ providerJobId: "job-b", status: "failed" }));
    expect(otherJob.applied).toBe(true);
  });

  it("does not record non-terminal mappings, so a later real verdict still settles", () => {
    const registry = new TerminalCallbackRegistry();
    const hold = registry.apply(cb({ status: "who_knows" }));
    expect(hold.applied).toBe(true);
    expect(hold.mapping).toEqual({ kind: "non_terminal", holdReason: "unknown_provider_status" });
    expect(registry.recordedMapping("job-1")).toBeNull();

    const verdict = registry.apply(cb({ status: "completed" }));
    expect(verdict.applied).toBe(true);
    expect(verdict.mapping).toEqual({ kind: "terminal", boardState: "done" });
    expect(registry.recordedMapping("job-1")).toEqual({ kind: "terminal", boardState: "done" });
  });

  it("never records done without evidence even across repeated callbacks", () => {
    const registry = new TerminalCallbackRegistry();
    for (let i = 0; i < 3; i++) {
      const outcome = registry.apply(cb({ completionEvidence: null }));
      expect(outcome.mapping).toEqual({ kind: "non_terminal", holdReason: "completion_evidence_missing" });
    }
    expect(registry.recordedMapping("job-1")).toBeNull();
  });
});
