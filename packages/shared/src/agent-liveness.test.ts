import { describe, expect, it } from "vitest";
import {
  AGENT_ANSWER_FRESH_WINDOW_MS,
  deriveAgentProbeStatus,
  isAgentResponseFresh,
  type AgentLivenessInput,
} from "./agent-liveness.js";

const NOW = new Date("2026-11-13T12:00:00.000Z");

function input(overrides: Partial<AgentLivenessInput> = {}): AgentLivenessInput {
  return {
    lastProbeAt: null,
    lastProbeOutcome: null,
    lastResponseAt: null,
    now: NOW,
    ...overrides,
  };
}

describe("deriveAgentProbeStatus", () => {
  it("reports unknown when nothing was ever probed or answered", () => {
    expect(deriveAgentProbeStatus(input())).toBeNull();
  });

  it("reports unreachable when the last probe failed, even after a fresh response", () => {
    const fresh = new Date(NOW.getTime() - 1_000);
    expect(
      deriveAgentProbeStatus(
        input({ lastProbeAt: new Date(NOW.getTime() - 30_000), lastProbeOutcome: "unreachable", lastResponseAt: fresh }),
      ),
    ).toBe("unreachable");
    expect(
      deriveAgentProbeStatus(input({ lastProbeOutcome: "unreachable", lastProbeAt: null })),
    ).toBe("unreachable");
  });

  it("reports answering when the probe passed and the model answered inside the fresh window", () => {
    const fresh = new Date(NOW.getTime() - AGENT_ANSWER_FRESH_WINDOW_MS + 1_000);
    expect(
      deriveAgentProbeStatus(
        input({ lastProbeAt: new Date(NOW.getTime() - 60_000), lastProbeOutcome: "ok", lastResponseAt: fresh }),
      ),
    ).toBe("answering");
  });

  it("reports alive_but_not_answering when the probe passed but the model went quiet", () => {
    const stale = new Date(NOW.getTime() - AGENT_ANSWER_FRESH_WINDOW_MS - 1_000);
    expect(
      deriveAgentProbeStatus(
        input({ lastProbeAt: new Date(NOW.getTime() - 60_000), lastProbeOutcome: "ok", lastResponseAt: stale }),
      ),
    ).toBe("alive_but_not_answering");
    // Probed but no model response ever: process alive, model silent.
    expect(
      deriveAgentProbeStatus(
        input({ lastProbeAt: new Date(NOW.getTime() - 60_000), lastProbeOutcome: "ok" }),
      ),
    ).toBe("alive_but_not_answering");
  });

  it("treats a probe timestamp without a stored outcome as an alive probe", () => {
    expect(
      deriveAgentProbeStatus(input({ lastProbeAt: new Date(NOW.getTime() - 60_000) })),
    ).toBe("alive_but_not_answering");
  });

  it("does not claim a status from a stale response when no probe exists", () => {
    const stale = new Date(NOW.getTime() - AGENT_ANSWER_FRESH_WINDOW_MS - 60_000);
    expect(deriveAgentProbeStatus(input({ lastResponseAt: stale }))).toBeNull();
  });
});

describe("isAgentResponseFresh", () => {
  it("is false without any response", () => {
    expect(isAgentResponseFresh(null, NOW)).toBe(false);
  });

  it("is true inside and at the window boundary, false past it", () => {
    const atEdge = new Date(NOW.getTime() - AGENT_ANSWER_FRESH_WINDOW_MS);
    const past = new Date(NOW.getTime() - AGENT_ANSWER_FRESH_WINDOW_MS - 1);
    const inside = new Date(NOW.getTime() - 1);
    expect(isAgentResponseFresh(atEdge, NOW)).toBe(true);
    expect(isAgentResponseFresh(past, NOW)).toBe(false);
    expect(isAgentResponseFresh(inside, NOW)).toBe(true);
  });
});
