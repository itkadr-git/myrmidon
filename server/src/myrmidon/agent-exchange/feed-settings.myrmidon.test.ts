// server/src/myrmidon/agent-exchange/feed-settings.myrmidon.test.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-B): the resolution of the two feed settings,
// with no database — the reader is a deps object, exactly as the route uses it.
//
// The rules the tests pin down are the same the other myrmidon settings
// follow: stored settings win when they parse, the environment is a forced
// override for an instance that never saved them, a stored blob that fails the
// strict schema is ignored whole (never half-applied), an unreadable
// environment value falls through to the default, and a partial PATCH keeps
// the values the screen showed.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_EXCHANGE_FEED_LIMIT,
  type AgentExchangeFeedSettings,
} from "@paperclipai/shared";
import {
  mergeAgentExchangeFeedSettingsPatch,
  readAgentExchangeFeedSettings,
} from "./feed-settings.js";
import { AgentExchangeFeedError } from "./feed.js";

describe("readAgentExchangeFeedSettings", () => {
  it("answers the defaults when nothing is stored and nothing is forced", async () => {
    const resolved = await readAgentExchangeFeedSettings({
      getGeneral: async () => ({}),
      env: {},
    });
    expect(resolved.settings).toEqual({
      feedLimit: DEFAULT_AGENT_EXCHANGE_FEED_LIMIT,
      skillCandidateEnabled: true,
    });
    expect(resolved.sources).toEqual({ feedLimit: "default", skillCandidateEnabled: "default" });
  });

  it("prefers the stored settings and says so per key", async () => {
    const resolved = await readAgentExchangeFeedSettings({
      getGeneral: async () => ({ agentExchangeFeed: { feedLimit: 120, skillCandidateEnabled: false } }),
      env: {
        MYRMIDON_AGENT_EXCHANGE_FEED_LIMIT: "10",
        MYRMIDON_AGENT_EXCHANGE_SKILL_CANDIDATE_ENABLED: "1",
      },
    });
    expect(resolved.settings).toEqual({ feedLimit: 120, skillCandidateEnabled: false });
    expect(resolved.sources).toEqual({ feedLimit: "settings", skillCandidateEnabled: "settings" });
  });

  it("takes the environment for an instance that never saved its settings", async () => {
    const resolved = await readAgentExchangeFeedSettings({
      getGeneral: async () => ({}),
      env: {
        MYRMIDON_AGENT_EXCHANGE_FEED_LIMIT: "10",
        MYRMIDON_AGENT_EXCHANGE_SKILL_CANDIDATE_ENABLED: "off",
      },
    });
    expect(resolved.settings).toEqual({ feedLimit: 10, skillCandidateEnabled: true });
    expect(resolved.sources).toEqual({ feedLimit: "env", skillCandidateEnabled: "default" });
  });

  it("ignores a stored blob that fails the strict schema as a whole", async () => {
    const resolved = await readAgentExchangeFeedSettings({
      getGeneral: async () => ({ agentExchangeFeed: { feedLimit: 999 } }),
      env: {},
    });
    expect(resolved.settings.feedLimit).toBe(DEFAULT_AGENT_EXCHANGE_FEED_LIMIT);
    expect(resolved.sources.feedLimit).toBe("default");
  });

  it("falls through to the default when the environment value is unreadable", async () => {
    const resolved = await readAgentExchangeFeedSettings({
      getGeneral: async () => ({}),
      env: {
        MYRMIDON_AGENT_EXCHANGE_FEED_LIMIT: "not-a-number",
        MYRMIDON_AGENT_EXCHANGE_SKILL_CANDIDATE_ENABLED: "maybe",
      },
    });
    expect(resolved.settings.feedLimit).toBe(DEFAULT_AGENT_EXCHANGE_FEED_LIMIT);
    expect(resolved.sources).toEqual({ feedLimit: "default", skillCandidateEnabled: "default" });
  });

  it("survives a failing settings read by answering the defaults", async () => {
    const resolved = await readAgentExchangeFeedSettings({
      getGeneral: async () => {
        throw new Error("settings row unreadable");
      },
      env: {},
    });
    expect(resolved.settings.skillCandidateEnabled).toBe(true);
    expect(resolved.sources.skillCandidateEnabled).toBe("default");
  });
});

describe("mergeAgentExchangeFeedSettingsPatch", () => {
  const current: AgentExchangeFeedSettings = { feedLimit: 120, skillCandidateEnabled: true };

  it("keeps the untouched keys as the screen showed them", () => {
    expect(mergeAgentExchangeFeedSettingsPatch(current, { skillCandidateEnabled: false })).toEqual({
      feedLimit: 120,
      skillCandidateEnabled: false,
    });
    expect(mergeAgentExchangeFeedSettingsPatch(current, {})).toEqual(current);
  });

  it("refuses a value outside the contract", () => {
    expect(() => mergeAgentExchangeFeedSettingsPatch(current, { feedLimit: 1 })).toThrow();
  });
});

describe("AgentExchangeFeedError", () => {
  it("carries the stable code the routes translate", () => {
    const error = new AgentExchangeFeedError("room_not_found", "no room");
    expect(error.code).toBe("room_not_found");
    expect(error.name).toBe("AgentExchangeFeedError");
    expect(error).toBeInstanceOf(Error);
  });
});