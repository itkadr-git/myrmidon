import { describe, expect, it } from "vitest";
import { isAgentIdLike } from "../attention.js";

// A synthetic attention subject (the bot-disk lifecycle card) carries a key,
// not an agent id. Letting it into the agents.id IN (...) lookup made Postgres
// reject the uuid cast and the board failed to start.
describe("isAgentIdLike", () => {
  it("accepts a uuid", () => {
    expect(isAgentIdLike("10239057-2f10-49f6-9c8d-685a266fcff3")).toBe(true);
  });
  it("rejects a synthetic subject key and other non-uuid values", () => {
    expect(isAgentIdLike("bot-disk-lifecycle")).toBe(false);
    expect(isAgentIdLike("")).toBe(false);
    expect(isAgentIdLike(null)).toBe(false);
    expect(isAgentIdLike(undefined)).toBe(false);
    expect(isAgentIdLike(42)).toBe(false);
  });
});
