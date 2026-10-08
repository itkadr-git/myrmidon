// myrmidon(1.6.6-CORPUS-SHADOW A): unit tests of the corpus shadow runner and
// of the gateway decision helper (OPE-6166 part A, ticket OPE-6171).
//
// The ticket's three scenarios, verified without an embedded database:
//  - flag off: no module call, no row, and the hook returns before touching
//    anything (the zero-behavior-change requirement);
//  - flag on: one row lands with both answers, the bot response object is
//    never replaced or mutated (fire-and-forget);
//  - module failure: the error text goes to module_error only, the row still
//    writes, and nothing throws back toward the caller.
import { describe, expect, it, vi } from "vitest";
import {
  createCorpusShadowRunner,
  extractChunkIds,
  isShadowSearchTool,
  maybeRecordShadowSearchCall,
  noOpCorpusShadowSearch,
  parseShadowSearchCall,
  type CorpusShadowSearch,
} from "./corpus-shadow.js";

type FakeRow = Record<string, unknown>;

function fakeDb() {
  const rows: FakeRow[] = [];
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(async (row: FakeRow) => {
        rows.push(row);
      }),
    })),
  };
  return { db: db as unknown as Parameters<typeof createCorpusShadowRunner>[0]["db"], rows };
}

function makeRunner(overrides: {
  enabled?: boolean;
  search?: CorpusShadowSearch;
  db?: ReturnType<typeof fakeDb>["db"];
} = {}) {
  const fdb = fakeDb();
  const runner = createCorpusShadowRunner({
    db: overrides.db ?? fdb.db,
    isEnabled: () => overrides.enabled ?? false,
    search: overrides.search,
    timeoutMs: 500,
  });
  return { runner, rows: fdb.rows };
}

describe("isShadowSearchTool", () => {
  it("matches knowledge search tools on the ragflow connection", () => {
    expect(
      isShadowSearchTool({ name: "mcp.ragflow-abc123:chat_retrieval", upstreamToolName: "chat_retrieval" }),
    ).toBe(true);
    expect(
      isShadowSearchTool({ name: "mcp.ragflow-abc123:search_knowledge", upstreamToolName: "search_knowledge" }),
    ).toBe(true);
  });

  it("never matches non-knowledge connections or the OCR parse tool", () => {
    expect(isShadowSearchTool({ name: "mcp.github-1:create_issue", upstreamToolName: "create_issue" })).toBe(false);
    expect(isShadowSearchTool({ name: "mcp.ragflow-1:parse_document", upstreamToolName: "parse_document" })).toBe(false);
    expect(isShadowSearchTool({ name: "builtin.issue_list", upstreamToolName: null })).toBe(false);
  });
});

describe("parseShadowSearchCall", () => {
  it("extracts dataset and query from the usual argument shapes", () => {
    expect(parseShadowSearchCall({ query: "  pricing terms ", dataset_id: "kb-7" })).toEqual({
      dataset: "kb-7",
      query: "pricing terms",
    });
    expect(parseShadowSearchCall({ question: "x", dataset_name: "y" })).toEqual({ dataset: "y", query: "x" });
    expect(parseShadowSearchCall({ query: "only a query" })).toEqual({ dataset: null, query: "only a query" });
  });

  it("returns null without a usable query text", () => {
    expect(parseShadowSearchCall(null)).toBeNull();
    expect(parseShadowSearchCall("string")).toBeNull();
    expect(parseShadowSearchCall({ dataset: "kb" })).toBeNull();
    expect(parseShadowSearchCall({ query: "   " })).toBeNull();
  });
});

describe("extractChunkIds", () => {
  it("pulls ordered chunk ids out of MCP-shaped results, deduplicated", () => {
    const result = {
      content: [{ type: "text", text: JSON.stringify({ data: { chunks: [{ chunk_id: "c1" }, { chunk_id: "c2" }] } }) }],
      structuredContent: { chunks: [{ chunkId: "c2" }, { chunkId: "c3" }] },
    };
    expect(extractChunkIds(result)).toEqual(["c1", "c2", "c3"]);
  });

  it("survives non-JSON noise and returns [] when nothing matches", () => {
    expect(extractChunkIds({ content: [{ type: "text", text: "no json here" }] })).toEqual([]);
    expect(extractChunkIds(undefined)).toEqual([]);
  });
});

describe("createCorpusShadowRunner", () => {
  it("flag off: recordShadowCall is never reached by the helper and no rows are written", async () => {
    const search = { search: vi.fn(async () => [{ chunkId: "m1" }]) };
    const { runner, rows } = makeRunner({ enabled: false, search });
    // The decision point short-circuits on isEnabled — the module is not called.
    maybeRecordShadowSearchCall({
      runner,
      tool: { name: "mcp.ragflow-1:chat_retrieval", upstreamToolName: "chat_retrieval" },
      execution: { transport: "mcp_remote" },
      result: { content: [] },
      parameters: { query: "q" },
      botId: "bot-1",
      latencyMs: 12,
    });
    await runner.settle();
    expect(search.search).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("flag on: one row with both answers; the module leg is fire-and-forget", async () => {
    const search = { search: vi.fn(async () => [{ chunkId: "m1" }, { chunkId: "m2" }]) };
    const { runner, rows } = makeRunner({ enabled: true, search });
    const botResult = { content: [{ type: "text", text: "ragflow answer" }] };
    maybeRecordShadowSearchCall({
      runner,
      tool: { name: "mcp.ragflow-1:chat_retrieval", upstreamToolName: "chat_retrieval" },
      execution: { transport: "mcp_remote" },
      result: botResult,
      parameters: { query: "q", dataset: "kb-9" },
      botId: "bot-1",
      latencyMs: 40,
    });
    // Synchronous helper already returned; the bot response object is unchanged.
    expect(botResult).toEqual({ content: [{ type: "text", text: "ragflow answer" }] });
    await runner.settle();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      botId: "bot-1",
      dataset: "kb-9",
      query: "q",
      ragflowChunkIds: [],
      ragflowLatencyMs: 40,
      moduleChunkIds: ["m1", "m2"],
      moduleError: null,
    });
    expect(typeof row.moduleLatencyMs).toBe("number");
  });

  it("module error: recorded in module_error only, row still written, nothing rethrown", async () => {
    const search = { search: vi.fn(async () => { throw new Error("corpus down"); }) };
    const { runner, rows } = makeRunner({ enabled: true, search });
    await runner.recordShadowCall({
      plan: { dataset: "kb", query: "q" },
      botId: "bot-2",
      ragflowChunkIds: ["r1"],
      ragflowLatencyMs: 30,
    });
    await runner.settle();
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({
      ragflowChunkIds: ["r1"],
      moduleChunkIds: null,
      moduleError: "corpus down",
    });
  });

  it("a hanging module leg is cut by the shadow timeout, not by the bot path", async () => {
    const search = {
      search: () => new Promise<never>(() => { /* never settles */ }),
    };
    const fdb = fakeDb();
    const runner = createCorpusShadowRunner({ db: fdb.db, isEnabled: () => true, search, timeoutMs: 40 });
    runner.recordShadowCall({ plan: { dataset: null, query: "q" }, botId: null, ragflowChunkIds: [], ragflowLatencyMs: 5 });
    await runner.settle();
    expect(fdb.rows[0]!.moduleError).toContain("timed out");
    expect(fdb.rows[0]!.moduleChunkIds).toBeNull();
  });

  it("no-op default port answers empty chunk ids", async () => {
    expect(await noOpCorpusShadowSearch.search({ text: "q" })).toEqual([]);
  });

  it("insert failure never escapes the shadow leg", async () => {
    const rows: FakeRow[] = [];
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(async () => {
          rows.push({});
          throw new Error("db unreachable");
        }),
      })),
    } as unknown as Parameters<typeof createCorpusShadowRunner>[0]["db"];
    const warn = vi.fn();
    const runner = createCorpusShadowRunner({ db, isEnabled: () => true, timeoutMs: 100, logger: { warn } });
    expect(() =>
      runner.recordShadowCall({ plan: { dataset: null, query: "q" }, botId: null, ragflowChunkIds: [], ragflowLatencyMs: 1 }),
    ).not.toThrow();
    await runner.settle();
    expect(warn).toHaveBeenCalled();
  });
});

describe("maybeRecordShadowSearchCall decision gate", () => {
  it("skips without a remote MCP execution (builtin/plugin legs are never shadowed)", () => {
    const runner = makeRunner({ enabled: true }).runner;
    const record = vi.spyOn(runner, "recordShadowCall");
    maybeRecordShadowSearchCall({
      runner,
      tool: { name: "mcp.ragflow-1:chat_retrieval", upstreamToolName: "chat_retrieval" },
      execution: null,
      result: {},
      parameters: { query: "q" },
      botId: "b",
      latencyMs: 1,
    });
    expect(record).not.toHaveBeenCalled();
  });

  it("skips non-search tools and calls without query text even when enabled", () => {
    const runner = makeRunner({ enabled: true }).runner;
    const record = vi.spyOn(runner, "recordShadowCall");
    const base = {
      runner,
      execution: { transport: "mcp_remote" },
      result: {},
      botId: "b",
      latencyMs: 1,
    };
    maybeRecordShadowSearchCall({ ...base, tool: { name: "mcp.ragflow-1:parse_document", upstreamToolName: "parse_document" }, parameters: { query: "q" } });
    maybeRecordShadowSearchCall({ ...base, tool: { name: "mcp.ragflow-1:chat_retrieval", upstreamToolName: "chat_retrieval" }, parameters: { nothing: true } });
    expect(record).not.toHaveBeenCalled();
  });

  it("a throwing isEnabled cannot reach the bot", () => {
    const runner = { isEnabled: () => { throw new Error("store blown"); }, recordShadowCall: vi.fn(), settle: async () => {} };
    expect(() =>
      maybeRecordShadowSearchCall({
        runner,
        tool: { name: "mcp.ragflow-1:chat_retrieval", upstreamToolName: "chat_retrieval" },
        execution: { transport: "mcp_remote" },
        result: {},
        parameters: { query: "q" },
        botId: "b",
        latencyMs: 1,
      }),
    ).not.toThrow();
    expect(runner.recordShadowCall).not.toHaveBeenCalled();
  });
});
