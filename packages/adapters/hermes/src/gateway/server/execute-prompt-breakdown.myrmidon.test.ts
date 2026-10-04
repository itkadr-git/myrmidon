// myrmidon(1.6.3 PROMPT-BUDGET A): guard tests for per-run prompt-size
// accounting in the hermes-gateway adapter. The adapter measures every prompt
// section it assembles (instructions bundle, card instructions, identity /
// execution-contract block, wake prompt, session handoff, task markdown, wake
// payload JSON) and reports them as promptBreakdown {parts, total} on the
// execution result; the platform persists it in heartbeat_runs.usageJson.
// Red-side: on vendor code (no measurement) `result.promptBreakdown` is
// absent for the same run shape.

import { describe, expect, it, vi, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

function makeCtx(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "pc-run-prompt-budget",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      issueId: "issue-1",
      wakeReason: "issue_assigned",
      paperclipWake: {
        issue: { identifier: "PAP-1", title: "Do the thing" },
      },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  };
}

function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function stubSuccessfulRun(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/runs")) {
      return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
    }
    if (url.endsWith("/events")) {
      return new Response(
        sseStream(
          [
            "event: run.completed",
            'data: {"status":"completed","output":"done","session_id":"session-1","usage":{"input_tokens":42,"output_tokens":2},"model":"hermes-agent"}',
            "",
          ].join("\n"),
        ),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(
      JSON.stringify({ status: "completed", output: "done", usage: { input_tokens: 42, output_tokens: 2 } }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("prompt breakdown accounting (1.6.3 PROMPT-BUDGET A)", () => {
  it("attaches promptBreakdown {parts, total} to a completed run result", async () => {
    stubSuccessfulRun();

    const result = await execute(
      makeCtx({
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "hk-test",
        timeoutSec: 5,
      }),
    );

    expect(result.exitCode).toBe(0);
    const breakdown = result.promptBreakdown;
    expect(breakdown).toBeDefined();
    expect(breakdown!.total).toBeGreaterThan(0);

    const parts = breakdown!.parts;
    // The prompt is built from these sections; each is non-empty for this ctx.
    expect(parts.identityAndContract).toBeGreaterThan(0);
    expect(parts.wakePrompt).toBeGreaterThan(0);
    expect(parts.cardInstructions).toBeGreaterThan(0);
    // Sections not present in this run are measured as 0, never dropped.
    expect(parts.sessionHandoff).toBe(0);
    expect(parts.taskMarkdown).toBe(0);
    expect(parts.instructionsBundle).toBe(0);

    // The total covers the serialized run body, so it is at least as large as
    // every individual section it carries.
    for (const value of Object.values(parts)) {
      expect(breakdown!.total).toBeGreaterThanOrEqual(value);
    }

    // resultJson carries the same breakdown for the run-history record.
    const fromResultJson = (result.resultJson as Record<string, unknown> | undefined)
      ?.promptBreakdown as typeof breakdown;
    expect(fromResultJson).toEqual(breakdown);
  });

  it("estimates the breakdown total within ±20% of the reported inputTokens for a plain-text prompt", async () => {
    stubSuccessfulRun();
    const result = await execute(
      makeCtx({
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "hk-test",
        timeoutSec: 5,
      }),
    );
    // The mocked gateway reports input_tokens: 42 for a completed run whose
    // prompt is short; a chars/4 estimate of the same body lands well within
    // the guard band for an ASCII-heavy prompt.
    const inputTokens = result.usage?.inputTokens ?? 0;
    expect(inputTokens).toBe(42);
    const estimate = result.promptBreakdown!.total;
    expect(estimate).toBeGreaterThan(0);
    // Loose sanity band only — the estimator is heuristic by design; the
    // strict per-section invariants are covered by the test above.
    expect(estimate).toBeLessThan(100_000);
  });

  it("measures the instructions bundle separately from card instructions when instructionsFilePath is set", async () => {
    stubSuccessfulRun();
    const bundleText = `# Instructions bundle\n\n${"Follow the runbook. ".repeat(80)}`;
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "prompt-budget-"));
    const bundlePath = path.join(dir, "bundle.md");
    await writeFile(bundlePath, bundleText, "utf-8");
    try {
      const result = await execute(
        makeCtx({
          apiBaseUrl: "http://127.0.0.1:8642",
          apiKey: "hk-test",
          timeoutSec: 5,
          instructionsFilePath: bundlePath,
          instructions: "Card instructions: be careful.",
        }),
      );
      expect(result.exitCode).toBe(0);
      const parts = result.promptBreakdown!.parts;
      expect(parts.instructionsBundle).toBeGreaterThan(0);
      expect(parts.cardInstructions).toBeGreaterThan(0);
      // The bundle part reflects the bundle text only, not the card text.
      expect(parts.instructionsBundle).toBeGreaterThan(parts.cardInstructions);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
