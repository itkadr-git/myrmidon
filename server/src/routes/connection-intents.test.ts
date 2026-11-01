import { describe, expect, it, vi } from "vitest";
import {
  CONNECTION_REQUEST_TOOL_DESCRIPTION,
  CONNECTION_RUNTIME_TOOL_NAMES,
  CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
} from "@myrmidon/shared";
import {
  REPOSITORY_REGEX,
  RUNTIME_CONNECTION_TOOL_DEFINITIONS,
  wakeConnectionIntentAfterResolution,
} from "./connection-intents.js";

describe("runtime connection MCP contract", () => {
  it("advertises both canonical tools with the shared descriptions and narrow schemas", () => {
    expect(
      RUNTIME_CONNECTION_TOOL_DEFINITIONS.map((tool) => tool.name),
    ).toEqual(CONNECTION_RUNTIME_TOOL_NAMES);
    expect(RUNTIME_CONNECTION_TOOL_DEFINITIONS).toEqual([
      {
        name: "connections_search",
        description: CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "connection_request",
        description: CONNECTION_REQUEST_TOOL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: { service: { type: "string" } },
          required: ["service"],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("does not accept run identity, task identity, users, or credentials from tool input", () => {
    const serialized = JSON.stringify(
      RUNTIME_CONNECTION_TOOL_DEFINITIONS.map(
        (definition) => definition.inputSchema,
      ),
    );
    expect(serialized).not.toMatch(
      /companyId|agentId|runId|issueId|responsibleUserId|credential|token/i,
    );
  });
});

describe("connection intent continuation wake contract", () => {
  it.each([
    ["accepted", "connected"],
    ["rejected", "declined"],
  ])(
    "emits one idempotent continuation wake for %s intents",
    async (status) => {
      const wakeup = vi.fn().mockResolvedValue(undefined);

      await wakeConnectionIntentAfterResolution({ wakeup } as never, {
        loaded: {
          issue: {
            id: "issue-123",
            assigneeAgentId: "agent-123",
            status: "in_progress",
          },
          interaction: { id: "interaction-123" },
        },
        status,
        actorId: "user-123",
      });

      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(wakeup).toHaveBeenCalledWith(
        "agent-123",
        expect.objectContaining({
          idempotencyKey: `connection-intent:interaction-123:${status}`,
          requestedByActorType: "user",
          requestedByActorId: "user-123",
          contextSnapshot: expect.objectContaining({
            issueId: "issue-123",
            interactionId: "interaction-123",
            interactionStatus: status,
            forceFreshSession: true,
          }),
        }),
      );
    },
  );

  it.each(["backlog", "todo", "done", "blocked", "cancelled"])(
    "does not wake a parked or closed %s task",
    async (issueStatus) => {
      const wakeup = vi.fn().mockResolvedValue(undefined);

      await wakeConnectionIntentAfterResolution({ wakeup } as never, {
        loaded: {
          issue: {
            id: "issue-closed",
            assigneeAgentId: "agent-123",
            status: issueStatus,
          },
          interaction: { id: "interaction-123" },
        },
        status: "accepted",
        actorId: "user-123",
      });

      expect(wakeup).not.toHaveBeenCalled();
    },
  );

  describe("REPOSITORY_REGEX validation", () => {
    it("accepts valid owner/repo formats", () => {
      expect(REPOSITORY_REGEX.test("itkadr-git/myrmidon")).toBe(true);
      expect(REPOSITORY_REGEX.test("owner.name/repo_name.js")).toBe(true);
      expect(REPOSITORY_REGEX.test("org-1/my-repo-2")).toBe(true);
    });

    it("rejects invalid repository formats", () => {
      expect(REPOSITORY_REGEX.test("")).toBe(false);
      expect(REPOSITORY_REGEX.test("myrmidon")).toBe(false);
      expect(REPOSITORY_REGEX.test("owner/repo/extra")).toBe(false);
      expect(REPOSITORY_REGEX.test("/repo")).toBe(false);
      expect(REPOSITORY_REGEX.test("owner/")).toBe(false);
      expect(REPOSITORY_REGEX.test("owner/repo with spaces")).toBe(false);
      expect(REPOSITORY_REGEX.test("owner/repo$bad")).toBe(false);
    });
  });
});
