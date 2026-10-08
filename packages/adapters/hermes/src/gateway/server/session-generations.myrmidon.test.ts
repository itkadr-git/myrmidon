// packages/adapters/hermes/src/gateway/server/session-generations.myrmidon.test.ts
//
// myrmidon(PERF-DIET-K): the gateway adapter's half of issue-scoped session
// generations — the `:g<N>` suffix of the session key and the run body the
// board's `sessionGeneration` produces.
//
// Watchdog: the key changes once the board raises the generation (and the whole
// request follows it), while the first generation and every other strategy keep
// the exact key the vendor builds.

import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute, readSessionGeneration, resolveSessionKey } from "./execute.js";

const ISSUE_KEY = "paperclip:company:company-a:agent:agent-a:issue:issue-a";

function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function makeCtx(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "run-a",
    agent: {
      id: "agent-a",
      companyId: "company-a",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: config,
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config,
    context: {
      issueId: "issue-a",
      wakeReason: "manual",
      paperclipWake: { issue: { identifier: "TASK-1", title: "Do the thing" } },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  };
}

function stubGateway(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/runs")) {
      return new Response(JSON.stringify({ run_id: "hermes-run-a", status: "started" }), { status: 200 });
    }
    if (url.endsWith("/events")) {
      return new Response(
        sseStream(
          [
            'event: run.completed',
            `data: {"status":"completed","output":"done","session_id":"${ISSUE_KEY}"}`,
            "",
          ].join("\n"),
        ),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("readSessionGeneration", () => {
  it("reads a generation number and treats everything unusable as the first one", () => {
    expect(readSessionGeneration(3)).toBe(3);
    expect(readSessionGeneration("4")).toBe(4);
    expect(readSessionGeneration(2.7)).toBe(2);
    for (const value of [undefined, null, 1, 0, -5, "", "  ", "g3", Number.NaN, {}, []]) {
      expect(readSessionGeneration(value), `value=${JSON.stringify(value)}`).toBe(1);
    }
  });
});

describe("resolveSessionKey with a session generation", () => {
  const base = { companyId: "company-a", agentId: "agent-a", runId: "run-a", issueId: "issue-a" } as const;

  it("keeps the vendor key for the first generation and for a missing value", () => {
    expect(resolveSessionKey({ strategy: "issue", ...base })).toBe(ISSUE_KEY);
    expect(resolveSessionKey({ strategy: "issue", ...base, generation: 1 })).toBe(ISSUE_KEY);
    expect(resolveSessionKey({ strategy: "issue", ...base, generation: null })).toBe(ISSUE_KEY);
    expect(resolveSessionKey({ strategy: "issue", ...base, generation: Number.NaN })).toBe(ISSUE_KEY);
  });

  it("appends the generation from the second generation on", () => {
    expect(resolveSessionKey({ strategy: "issue", ...base, generation: 2 })).toBe(`${ISSUE_KEY}:g2`);
    expect(resolveSessionKey({ strategy: "issue", ...base, generation: 12 })).toBe(`${ISSUE_KEY}:g12`);
  });

  it("leaves none, agent and run strategies exactly as they were", () => {
    expect(resolveSessionKey({ strategy: "none", ...base, generation: 5 })).toBeNull();
    expect(resolveSessionKey({ strategy: "agent", ...base, generation: 5 })).toBe(
      "paperclip:company:company-a:agent:agent-a",
    );
    expect(resolveSessionKey({ strategy: "run", ...base, generation: 5 })).toBe("paperclip:run:run-a");
  });

  it("leaves the per-attempt run fallback unsuffixed, and does not suffix an agent key", () => {
    expect(resolveSessionKey({ strategy: "issue", ...base, issueId: null, generation: 5 })).toBe(
      "paperclip:company:company-a:agent:agent-a:run:run-a",
    );
  });
});

describe("execute with a session generation", () => {
  it("sends the generation in the session key of the request", async () => {
    const fetchMock = stubGateway();
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5, sessionGeneration: 3 });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const createCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    expect(createCall).toBeTruthy();
    const init = createCall?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ "X-Hermes-Session-Key": `${ISSUE_KEY}:g3` });
    expect(JSON.parse(String(init.body)).session_id).toBe(`${ISSUE_KEY}:g3`);
  });

  it("reports the generation in the run log and the adapter meta", async () => {
    stubGateway();
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5, sessionGeneration: "2" });

    await execute(ctx);

    const logged = (ctx.onLog as unknown as { mock: { calls: Array<[string, string]> } }).mock.calls
      .map(([, line]) => line)
      .join("");
    expect(logged).toContain("generation=g2");
    expect((ctx.onMeta as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls[0]?.[0])
      .toMatchObject({ context: { sessionGeneration: 2 } });
  });

  it("sends the plain vendor key when the board computes no generation", async () => {
    const fetchMock = stubGateway();
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const init = calls.find(([input]) => String(input).endsWith("/v1/runs"))?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ "X-Hermes-Session-Key": ISSUE_KEY });
    expect(JSON.parse(String(init.body)).session_id).toBe(ISSUE_KEY);
    const logged = (ctx.onLog as unknown as { mock: { calls: Array<[string, string]> } }).mock.calls
      .map(([, line]) => line)
      .join("");
    expect(logged).not.toContain("generation=");
  });

  it("redacts the generation suffix together with the session key", async () => {
    stubGateway();
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5, sessionGeneration: 2 });

    const result = await execute(ctx);

    // The gateway answered with the generation-suffixed key; the mapped result
    // must not carry it in the clear.
    expect(result.sessionId).toBe("[redacted-session-key]");
    expect(result.resultJson?.session_id).toBe("[redacted-session-key]");
  });
});