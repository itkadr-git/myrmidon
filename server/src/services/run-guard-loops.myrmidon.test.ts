// myrmidon(RUN-GUARD-LOOPS): the hermes gateway adapter feeds every tool.started
// event to the run guard; a long read-only streak or a repeated read stops the run.
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunGuard, type AdapterExecutionContext } from "@myrmidon/adapter-utils";
import { execute as executeHermesGateway } from "@myrmidon/hermes-paperclip-adapter/gateway/server";

type Frame = readonly [event: string, data: Record<string, unknown>];

const read = (path: string): Frame => ["tool.started", { tool: "read_file", preview: path }];
const search = (pattern: string): Frame => ["tool.started", { tool: "search_files", preview: pattern }];
const terminal = (command: string): Frame => ["tool.started", { tool: "terminal", preview: command }];
const patch = (path: string): Frame => ["tool.started", { tool: "patch", preview: path }];

/** Every tool.started is followed by its tool.completed, like on the real wire. */
function withCompletions(starts: Frame[]): Frame[] {
  return starts.flatMap((start) => [start, ["tool.completed", { tool: start[1].tool, duration: 0.01 }] as Frame]);
}

async function runFrames(frames: Frame[], guard: RunGuard) {
  const newline = String.fromCharCode(10);
  const sse = [...frames, ["run.completed", { status: "completed", output: "done" }] as Frame]
    .map(([event, data]) => [`event: ${event}`, `data: ${JSON.stringify(data)}`, "", ""].join(newline))
    .join("");
  const onRunGuardStop = vi.fn(async () => undefined);
  const ctx: AdapterExecutionContext = {
    runId: "guard-loops-run",
    agent: { id: "agent-a", companyId: "company-a", name: "agent-a", adapterType: "hermes_gateway", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "issue-a" },
    config: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "test-only", timeoutSec: 10, sessionKeyStrategy: "run" },
    context: { issueId: "issue-a" },
    runGuard: guard,
    onRunGuardStop,
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "guard-loops-gateway-run", status: "started" }), { status: 200 });
      }
      if (url.includes("/events")) {
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    }),
  );
  await executeHermesGateway(ctx);
  return { onRunGuardStop };
}

const files = (count: number, prefix = "src/file") => Array.from({ length: count }, (_, index) => `${prefix}-${index}.ts`);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hermes gateway feeds tool events to the run guard (read-only loops)", () => {
  it("stops the run at the 40th consecutive read-only tool call, once", async () => {
    const guard = new RunGuard();
    const starts = files(45).map((path, index) => (index % 2 === 0 ? read(path) : search(path)));
    const { onRunGuardStop } = await runFrames(withCompletions(starts), guard);
    expect(guard.stopReason).toBe("no_progress_exploration");
    expect(guard.stats().toolCalls).toBe(40);
    expect(onRunGuardStop).toHaveBeenCalledTimes(1);
    expect(onRunGuardStop).toHaveBeenCalledWith("no_progress_exploration");
  });

  it("counts read-only terminal commands and does not stop at 39", async () => {
    const guard39 = new RunGuard();
    const commands39 = files(39).map((path) => terminal(`sed -n '1,20p' ${path}`));
    const first = await runFrames(withCompletions(commands39), guard39);
    expect(guard39.stopped).toBe(false);
    expect(first.onRunGuardStop).not.toHaveBeenCalled();

    const guard40 = new RunGuard();
    const commands40 = files(40).map((path) => terminal(`grep -n needle ${path}`));
    const second = await runFrames(withCompletions(commands40), guard40);
    expect(second.onRunGuardStop).toHaveBeenCalledWith("no_progress_exploration");
  });

  it("does not stop a run that writes in between (a patch resets the streak)", async () => {
    const guard = new RunGuard();
    const starts = [...files(39).map(read), patch("src/file-0.ts"), ...files(39, "src/other").map(read)];
    const { onRunGuardStop } = await runFrames(withCompletions(starts), guard);
    expect(guard.stopped).toBe(false);
    expect(onRunGuardStop).not.toHaveBeenCalled();
  });

  it("does not stop a run whose terminal call commits (a write command resets the streak)", async () => {
    const guard = new RunGuard();
    const starts = [...files(39).map(read), terminal("git commit -am 'step'"), ...files(39, "src/other").map(read)];
    const { onRunGuardStop } = await runFrames(withCompletions(starts), guard);
    expect(guard.stopped).toBe(false);
    expect(onRunGuardStop).not.toHaveBeenCalled();
  });

  it("stops the run when the same read is made for the 3rd time", async () => {
    const guard = new RunGuard();
    const starts = [read("src/a.ts"), read("src/b.ts"), read("src/a.ts"), search("needle"), read("src/a.ts"), read("src/c.ts")];
    const { onRunGuardStop } = await runFrames(withCompletions(starts), guard);
    expect(guard.stopReason).toBe("repeated_tool_call");
    expect(onRunGuardStop).toHaveBeenCalledTimes(1);
    expect(onRunGuardStop).toHaveBeenCalledWith("repeated_tool_call");
  });

  it("honours limits resolved from the agent card", async () => {
    const guard = new RunGuard({ noProgressLimit: 5, repeatedToolCallLimit: 0 });
    const { onRunGuardStop } = await runFrames(withCompletions(files(8).map(read)), guard);
    expect(onRunGuardStop).toHaveBeenCalledTimes(1);
    expect(onRunGuardStop).toHaveBeenCalledWith("no_progress_exploration");
    expect(guard.stats().toolCalls).toBe(5);
  });
});
