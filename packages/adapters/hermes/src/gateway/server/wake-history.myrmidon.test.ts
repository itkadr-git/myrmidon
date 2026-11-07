import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@myrmidon/adapter-utils";
import { execute } from "./execute.js";

// WAKE-HISTORY: one gateway request carries the task history once, in the mode
// the card asks for, and its structured JSON copy never repeats it.

const MESSAGE_COUNT = 30;
const marker = (index: number) => `HISTORY-MARKER-${String(index).padStart(2, "0")}-END`;
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

function wakePayload() {
  const messages = Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
    id: `message-${index}`,
    authorType: "user",
    authorId: "user-a",
    createdByRunId: null,
    body: `${marker(index)} ${"context ".repeat(115)}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deleted: false,
    sourceTrust: { kind: "authenticated_user" },
  }));
  return {
    reason: "issue_continuation_needed",
    issue: { id: "issue-a", identifier: "TEST-1", title: "Example task", status: "in_progress" },
    executionContinuation: {
      version: 1,
      companyId: "company-a",
      issueId: "issue-a",
      trigger: { reason: "issue_continuation_needed", interactionId: null, sourceRunId: "run-previous" },
      originCommentIds: ["message-3"],
      objective: "Finish the example task.",
      messages,
      resumeDelta: { baseRunId: "run-previous", messages },
      interactionOutcomes: [],
      previousRun: { runId: "run-previous", status: "succeeded" },
      completedWork: "Opened the branch and wrote the first half of the change.",
      unresolvedInteractionIds: [],
      coverage: { kind: "full_task_history", throughCommentId: "message-29", summaryThroughCommentId: null },
    },
    comments: [],
    commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
    fallbackFetchNeeded: false,
  };
}

function makeCtx(config: Record<string, unknown>, wakeOverrides: Record<string, unknown> = {}): AdapterExecutionContext {
  const fullConfig = { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "example-key", timeoutSec: 5, ...config };
  return {
    runId: "run-current",
    agent: { id: "agent-a", companyId: "company-a", name: "Agent A", adapterType: "hermes_gateway", adapterConfig: fullConfig },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: fullConfig,
    context: {
      issueId: "issue-a",
      wakeReason: "issue_continuation_needed",
      paperclipWake: { ...wakePayload(), ...wakeOverrides },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  };
}

async function sentInput(config: Record<string, unknown>, wakeOverrides: Record<string, unknown> = {}): Promise<string> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
    String(input).endsWith("/v1/runs")
      ? { run_id: "run-gateway-1", status: "started" }
      : { status: "completed", output: "done" },
  ), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await execute(makeCtx(config, wakeOverrides));
  expect(result.exitCode).toBe(0);
  const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
  const createCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
  return (JSON.parse(String((createCall?.[1] as RequestInit).body)) as { input: string }).input;
}

function structuredJsonOf(input: string): Record<string, any> {
  const block = input.split("Structured wake payload JSON:\n```json\n")[1];
  expect(block).toBeDefined();
  return JSON.parse(block!.split("\n```")[0]!);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hermes gateway wake history", () => {
  it.each(["run", "none"])("sends the summary only for sessionKeyStrategy=%s", async (strategy) => {
    const input = await sentInput({ sessionKeyStrategy: strategy });
    for (let index = 0; index < MESSAGE_COUNT; index++) {
      expect(input).not.toContain(marker(index));
    }
    expect(input).toContain("wake history: summary");
    expect(input).toContain('"previousRun":{"runId":"run-previous","status":"succeeded"}');
    expect(input).toContain("Opened the branch and wrote the first half of the change.");
    expect(input.length).toBeLessThan(15_000);
    const json = structuredJsonOf(input);
    expect(json.executionContinuation.messages).toEqual([]);
    expect(json.executionContinuation.resumeDelta.messages).toEqual([]);
  });

  it.each([{}, { sessionKeyStrategy: "issue" }, { sessionKeyStrategy: "agent" }])(
    "sends the newest 8 messages once for %j",
    async (config) => {
      const input = await sentInput(config);
      const present = Array.from({ length: MESSAGE_COUNT }, (_, index) => index).filter((index) =>
        input.includes(marker(index)),
      );
      expect(present).toEqual([3, 23, 24, 25, 26, 27, 28, 29]);
      for (const index of present) expect(occurrences(input, marker(index))).toBe(1);
      expect(input).toContain("wake history: recent");
    },
  );

  it("lets the card override the strategy default", async () => {
    const recent = await sentInput({ sessionKeyStrategy: "run", wakeHistory: "recent" });
    expect(recent).toContain(marker(29));
    expect(recent).not.toContain(marker(10));

    const full = await sentInput({ sessionKeyStrategy: "run", wakeHistory: "full" });
    for (let index = 0; index < MESSAGE_COUNT; index++) {
      expect(occurrences(full, marker(index))).toBe(1);
    }

    const summary = await sentInput({ sessionKeyStrategy: "issue", wakeHistory: "summary" });
    expect(summary).not.toContain(marker(29));
  });

  it("keeps the structured JSON block within 12000 characters", async () => {
    const comments = Array.from({ length: 12 }, (_, index) => ({
      id: `comment-${index}`,
      body: `comment ${index} ${"y".repeat(2_000)}`,
      author: { type: "user", id: "user-a" },
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    const input = await sentInput(
      { sessionKeyStrategy: "issue" },
      { comments, commentWindow: { requestedCount: 12, includedCount: 12, missingCount: 0 } },
    );
    const block = input.split("Structured wake payload JSON:\n```json\n")[1]!.split("\n```")[0]!;
    expect(block.length).toBeLessThanOrEqual(12_000);
    expect(JSON.parse(block).jsonTruncation.droppedKeys).toContain("comments");
    // The wake comments still reach the model through the rendered prompt.
    expect(input).toContain("comment 11 ");
  });
});
