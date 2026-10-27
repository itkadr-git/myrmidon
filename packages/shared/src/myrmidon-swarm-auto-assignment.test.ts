import { describe, expect, it } from "vitest";
import { DEFAULT_SWARM_MAX_ACTIVE_TASKS } from "./myrmidon-swarm-claim.js";

describe("automatic assignment capacity", () => {
  it("defaults to at most two concurrent tasks per agent", () => {
    expect(DEFAULT_SWARM_MAX_ACTIVE_TASKS).toBe(2);
  });
});
