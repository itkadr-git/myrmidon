import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunGuard, type RunGuardStopReason } from "@myrmidon/adapter-utils";
import {
  createOmpRunGuardFeed,
  OMP_STEER_EXTENSION_FILE,
  OMP_STEER_EXTENSION_SOURCE,
  OMP_STEER_FILE_ENV,
  ompGuardToolName,
  ompSteerFileName,
  writeOmpSteerExtension,
  type OmpRunGuardHint,
} from "./run-guard.js";

const TURN_START = JSON.stringify({ type: "turn_start" });

function toolStart(toolName: string, args: unknown): string {
  return JSON.stringify({ type: "tool_execution_start", toolCallId: `call-${toolName}`, toolName, args });
}

function makeFeed(guard: RunGuard) {
  const stops: RunGuardStopReason[] = [];
  const hints: OmpRunGuardHint[] = [];
  const feed = createOmpRunGuardFeed({
    guard,
    onStop: (reason) => {
      stops.push(reason);
    },
    onHint: (hint) => {
      hints.push(hint);
    },
  });
  return { feed, stops, hints };
}

async function feedTurns(feed: { observeLine(line: string): Promise<void> }, count: number) {
  for (let turn = 0; turn < count; turn += 1) await feed.observeLine(TURN_START);
}

describe("omp run guard feed", () => {
  it("counts one model call per turn_start and ignores every other line", async () => {
    const guard = new RunGuard();
    const { feed, stops, hints } = makeFeed(guard);

    await feed.observeLine(JSON.stringify({ type: "session", version: 3, id: "s-1", cwd: "/work" }));
    await feed.observeLine(JSON.stringify({ type: "agent_start" }));
    await feed.observeLine(TURN_START);
    // A streamed delta that only mentions the event name is not a model call.
    await feed.observeLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "turn_start" } }),
    );
    await feed.observeLine(JSON.stringify({ type: "turn_end", message: { role: "assistant" }, toolResults: [] }));
    await feed.observeLine('{"type":"turn_start"');
    await feed.observeLine("not json at all");
    await feed.observeLine("");
    await feed.observeLine(`  ${TURN_START}  `);

    expect(guard.stats().modelCalls).toBe(2);
    expect(stops).toEqual([]);
    expect(hints).toEqual([]);
  });

  it("passes the wrap-up hint once, 15 calls before the default limit of 150", async () => {
    const guard = new RunGuard();
    const { feed, stops, hints } = makeFeed(guard);

    await feedTurns(feed, 134);
    expect(hints).toEqual([]);

    await feed.observeLine(TURN_START);
    expect(hints).toEqual([{ reason: "model_call_limit", modelCalls: 135, remaining: 15 }]);

    await feedTurns(feed, 15);
    expect(guard.stats().modelCalls).toBe(150);
    expect(hints).toHaveLength(1);
    expect(stops).toEqual([]);
  });

  it("stops a run that made changes on the first call past the limit and reports the stop once", async () => {
    const guard = new RunGuard();
    const { feed, stops } = makeFeed(guard);

    await feed.observeLine(toolStart("edit", { path: "src/a.ts", oldText: "a", newText: "b" }));
    await feedTurns(feed, 150);
    expect(stops).toEqual([]);

    await feed.observeLine(TURN_START);
    expect(stops).toEqual(["model_call_limit"]);
    expect(guard.stopReason).toBe("model_call_limit");

    await feed.observeLine(TURN_START);
    await feed.observeLine(toolStart("bash", { command: "git status" }));
    expect(stops).toEqual(["model_call_limit"]);
    // What the board decides the continuation on: the calls made and the writes among them.
    expect(guard.stats()).toMatchObject({ modelCalls: 150, writeCalls: 1 });
  });

  it("gives a run without a single write the limit hint first and stops it on the next call", async () => {
    const guard = new RunGuard({ modelCallLimit: 3 });
    const { feed, stops, hints } = makeFeed(guard);

    await feedTurns(feed, 3);
    expect(hints).toEqual([]);

    await feed.observeLine(TURN_START);
    expect(hints).toEqual([{ reason: "model_call_limit", modelCalls: 3 }]);
    expect(stops).toEqual([]);

    await feed.observeLine(TURN_START);
    expect(stops).toEqual(["model_call_limit"]);
    expect(hints).toHaveLength(1);
  });

  it("classifies omp's tools: read, grep and read-only shell commands are reads, the rest are writes", async () => {
    const guard = new RunGuard({ noProgressLimit: 0, repeatedToolCallLimit: 0 });
    const { feed } = makeFeed(guard);

    await feed.observeLine(toolStart("bash", { command: "pnpm vitest run src/a.test.ts" }));
    await feed.observeLine(toolStart("edit", { path: "src/a.ts" }));
    await feed.observeLine(toolStart("write", { path: "src/b.ts", content: "x" }));
    expect(guard.stats()).toMatchObject({ toolCalls: 3, writeCalls: 3, readOnlyStreak: 0 });

    await feed.observeLine(toolStart("read", { path: "src/a.ts" }));
    await feed.observeLine(toolStart("grep", { pattern: "RunGuard", path: "src" }));
    await feed.observeLine(toolStart("bash", { command: "git status && git diff --stat" }));
    expect(guard.stats()).toMatchObject({ toolCalls: 6, writeCalls: 3, readOnlyStreak: 3 });

    // An event without a tool name says nothing and is not counted.
    await feed.observeLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "x", args: {} }));
    expect(guard.stats().toolCalls).toBe(6);
  });

  it("stops a run that only reads with no_progress_exploration", async () => {
    const guard = new RunGuard({ noProgressLimit: 4, repeatedToolCallLimit: 0 });
    const { feed, stops } = makeFeed(guard);

    await feed.observeLine(toolStart("read", { path: "a.ts" }));
    await feed.observeLine(toolStart("grep", { pattern: "a" }));
    await feed.observeLine(toolStart("bash", { command: "ls src" }));
    expect(stops).toEqual([]);

    await feed.observeLine(toolStart("read", { path: "b.ts" }));
    expect(stops).toEqual(["no_progress_exploration"]);
  });

  it("hints a repeated read under omp's own tool name, then stops the run", async () => {
    const guard = new RunGuard({ noProgressLimit: 0, repeatedToolCallLimit: 3 });
    const { feed, stops, hints } = makeFeed(guard);
    const sameRead = toolStart("read", { path: "src/a.ts", offset: 1, limit: 200 });

    await feed.observeLine(sameRead);
    await feed.observeLine(sameRead);
    expect(hints).toEqual([]);

    await feed.observeLine(sameRead);
    expect(hints).toEqual([{ reason: "repeated_tool_call", tool: "read", repeatCount: 3 }]);
    expect(stops).toEqual([]);

    await feed.observeLine(sameRead);
    expect(stops).toEqual(["repeated_tool_call"]);
  });

  it("maps omp tool names to the names the guard's classifier knows", () => {
    expect(ompGuardToolName("read")).toBe("read_file");
    expect(ompGuardToolName("grep")).toBe("search_files");
    expect(ompGuardToolName(" Bash ")).toBe("terminal");
    expect(ompGuardToolName("edit")).toBe("edit");
    expect(ompGuardToolName("constructor")).toBe("constructor");
  });

  it("builds a steer file name that stays inside its directory", () => {
    expect(ompSteerFileName("0f9c2f6e-7a1b-4c1d-9c55-1a2b3c4d5e6f")).toBe(
      "steer-0f9c2f6e-7a1b-4c1d-9c55-1a2b3c4d5e6f.txt",
    );
    expect(ompSteerFileName("../run 1/x")).toBe("steer-.._run_1_x.txt");
  });
});

describe("omp steer extension", () => {
  const cleanupDirs: string[] = [];
  const previousSteerFile = process.env[OMP_STEER_FILE_ENV];

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousSteerFile === undefined) delete process.env[OMP_STEER_FILE_ENV];
    else process.env[OMP_STEER_FILE_ENV] = previousSteerFile;
    while (cleanupDirs.length > 0) {
      await fs.rm(cleanupDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  type SteerExtension = { default: (pi: { on: unknown; sendUserMessage: unknown }) => void };

  // The loader of the test process takes the module kind from the extension, so
  // the same source is loaded from an .mjs copy; omp loads the .js file as is.
  async function loadExtension(dir: string): Promise<SteerExtension> {
    const modulePath = path.join(dir, `steer-under-test-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
    await fs.writeFile(modulePath, OMP_STEER_EXTENSION_SOURCE, "utf8");
    return (await import(/* @vite-ignore */ pathToFileURL(modulePath).href)) as SteerExtension;
  }

  it("is written under its own name with the source the adapter ships", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-omp-steer-"));
    cleanupDirs.push(dir);

    const extensionPath = await writeOmpSteerExtension(path.join(dir, "nested", "dir"));

    expect(extensionPath).toBe(path.join(dir, "nested", "dir", OMP_STEER_EXTENSION_FILE));
    expect(await fs.readFile(extensionPath, "utf8")).toBe(OMP_STEER_EXTENSION_SOURCE);
    // Nothing but the extension is left in the directory (no staging file).
    expect(await fs.readdir(path.dirname(extensionPath))).toEqual([OMP_STEER_EXTENSION_FILE]);
  });

  it("hands the text of the steer file to the session once, as an aside, and removes the file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-omp-steer-"));
    cleanupDirs.push(dir);
    const steerFile = path.join(dir, "steer-run-1.txt");
    process.env[OMP_STEER_FILE_ENV] = steerFile;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const handlers = new Map<string, () => void>();
    const sendUserMessage = vi.fn();

    const extension = await loadExtension(dir);
    extension.default({
      on: (event: string, handler: () => void) => {
        handlers.set(event, handler);
      },
      sendUserMessage,
    });

    expect([...handlers.keys()].sort()).toEqual(["tool_execution_end", "turn_end"]);

    // No message from the board yet: the session is left alone.
    handlers.get("turn_end")!();
    expect(sendUserMessage).not.toHaveBeenCalled();

    await fs.writeFile(steerFile, "Защита: до остановки прогона осталось 15 вызовов модели.\n", "utf8");
    handlers.get("tool_execution_end")!();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith("Защита: до остановки прогона осталось 15 вызовов модели.", {
      deliverAs: "aside",
    });
    await expect(fs.access(steerFile)).rejects.toThrow();

    // The same message is not delivered again on the following steps.
    handlers.get("turn_end")!();
    handlers.get("tool_execution_end")!();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("registers nothing when the run has no steer file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-omp-steer-"));
    cleanupDirs.push(dir);
    delete process.env[OMP_STEER_FILE_ENV];
    const on = vi.fn();

    const extension = await loadExtension(dir);
    extension.default({ on, sendUserMessage: vi.fn() });

    expect(on).not.toHaveBeenCalled();
  });
});
