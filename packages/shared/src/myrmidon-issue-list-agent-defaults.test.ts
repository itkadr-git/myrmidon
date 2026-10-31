import { describe, expect, it } from "vitest";
import {
  ISSUE_LIST_AGENT_DEFAULT_LIMIT,
  ISSUE_LIST_AGENT_FULL_VIEW_MAX_LIMIT,
  ISSUE_LIST_AGENT_MAX_LIMIT,
  issueListAgentDefaultsEnabled,
  normalizeIssueListAgentDefaults,
  shouldApplyIssueListAgentDefaults,
} from "./myrmidon-issue-list-agent-defaults.js";

describe("myrmidon-issue-list-agent-defaults", () => {
  it("normalizes absent / empty settings to enabled", () => {
    expect(normalizeIssueListAgentDefaults(undefined)).toEqual({ enabled: true });
    expect(normalizeIssueListAgentDefaults(null)).toEqual({ enabled: true });
    expect(normalizeIssueListAgentDefaults({})).toEqual({ enabled: true });
    expect(issueListAgentDefaultsEnabled(undefined)).toBe(true);
    expect(issueListAgentDefaultsEnabled({ enabled: false })).toBe(false);
  });

  it("exports contract constants", () => {
    expect(ISSUE_LIST_AGENT_DEFAULT_LIMIT).toBe(200);
    expect(ISSUE_LIST_AGENT_MAX_LIMIT).toBe(500);
    expect(ISSUE_LIST_AGENT_FULL_VIEW_MAX_LIMIT).toBe(100);
  });

  it("applies agent defaults to agents and integration board keys (OPE-9997)", () => {
    // Agents
    expect(shouldApplyIssueListAgentDefaults({ type: "agent" }, undefined)).toBe(true);
    expect(shouldApplyIssueListAgentDefaults({ type: "agent", source: "agent_session" }, undefined)).toBe(true);

    // Non-agent integration board keys
    expect(shouldApplyIssueListAgentDefaults({ type: "board", source: "board_key" }, undefined)).toBe(true);

    // Regular board users / sessions do NOT get agent defaults
    expect(shouldApplyIssueListAgentDefaults({ type: "board", source: "session" }, undefined)).toBe(false);
    expect(shouldApplyIssueListAgentDefaults({ type: "board", source: null }, undefined)).toBe(false);
    expect(shouldApplyIssueListAgentDefaults({ type: "board" }, undefined)).toBe(false);
    expect(shouldApplyIssueListAgentDefaults(null, undefined)).toBe(false);

    // Respects explicit disabled setting for both
    expect(shouldApplyIssueListAgentDefaults({ type: "agent" }, { enabled: false })).toBe(false);
    expect(shouldApplyIssueListAgentDefaults({ type: "board", source: "board_key" }, { enabled: false })).toBe(false);
  });
});
