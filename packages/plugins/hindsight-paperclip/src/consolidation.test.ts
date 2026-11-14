import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { HindsightClient, type FetchLike } from "./client.js";
import { runConsolidationPass, type ConsolidationCheckpoint } from "./consolidation.js";

// Synthetic data only: a mock fetch over an in-memory "hindsight service"
// with the same paging surface the consolidation pass relies on. No network.

const API_URL = "http://hindsight.invalid";
const BANK = "nightly-bank";

interface MockDoc {
  id: string;
  content_hash: string | null;
  text_length: number;
  memory_unit_count: number;
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface MockModel {
  id: string;
  name: string;
  is_stale: boolean | null;
  last_refreshed_at: string | null;
  refreshes: number;
}

interface MockCall {
  method: string;
  path: string;
}

interface MockHindsight {
  calls: MockCall[];
  documents: MockDoc[];
  models: MockModel[];
  consolidations: number;
  /** When true, POST /consolidate answers deduplicated=true (op already pending). */
  pendingConsolidation: boolean;
  fetch: FetchLike;
}

function mockHindsight(seed?: { documents?: number; models?: Array<Partial<MockModel>> }): MockHindsight {
  const calls: MockCall[] = [];
  const documents: MockDoc[] = Array.from({ length: seed?.documents ?? 0 }, (_, i) => ({
    id: `doc-${i + 1}`,
    content_hash: `hash-${i + 1}`,
    text_length: 500 + i,
    memory_unit_count: 2 + (i % 3),
    tags: ["paperclip"],
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  }));
  const models: MockModel[] = (seed?.models ?? []).map((partial, i) => ({
    id: partial.id ?? `model-${i + 1}`,
    name: partial.name ?? `Model ${i + 1}`,
    is_stale: partial.is_stale ?? false,
    last_refreshed_at: partial.last_refreshed_at ?? null,
    refreshes: 0,
  }));
  const hindsight: MockHindsight = {
    calls,
    documents,
    models,
    consolidations: 0,
    pendingConsolidation: false,
    fetch: async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = url.slice(API_URL.length);
      calls.push({ method, path });
      const documentsMatch = path.match(/^\/v1\/default\/banks\/[^/]+\/documents\?limit=(\d+)&offset=(\d+)$/);
      if (method === "GET" && documentsMatch) {
        const limit = Number(documentsMatch[1]);
        const offset = Number(documentsMatch[2]);
        const page = documents.slice(offset, offset + limit);
        return jsonResponse({
          items: page,
          total: documents.length,
          limit,
          offset,
        });
      }
      const modelsMatch = path.match(/^\/v1\/default\/banks\/[^/]+\/mental-models\?limit=(\d+)&offset=(\d+)$/);
      if (method === "GET" && modelsMatch) {
        const limit = Number(modelsMatch[1]);
        const offset = Number(modelsMatch[2]);
        const page = models.slice(offset, offset + limit).map((model) => ({
          id: model.id,
          name: model.name,
          is_stale: model.is_stale,
          last_refreshed_at: model.last_refreshed_at,
        }));
        return jsonResponse({ items: page, total: models.length, limit, offset });
      }
      if (method === "POST" && path === `/v1/default/banks/${BANK}/consolidate`) {
        hindsight.consolidations += 1;
        return jsonResponse({ operation_id: `op-consolidate-${hindsight.consolidations}`, deduplicated: hindsight.pendingConsolidation });
      }
      const refreshMatch = path.match(/^\/v1\/default\/banks\/[^/]+\/mental-models\/([^/]+)\/refresh$/);
      if (method === "POST" && refreshMatch) {
        const model = models.find((candidate) => candidate.id === decodeURIComponent(refreshMatch[1]));
        if (!model) return jsonResponse({ error: "unknown model" }, 404);
        model.refreshes += 1;
        model.is_stale = false;
        model.last_refreshed_at = "2026-11-13T03:00:00Z";
        return jsonResponse({ operation_id: `op-refresh-${model.id}`, status: "queued" });
      }
      if (path === "/health") return jsonResponse({ ok: true });
      return jsonResponse({ error: "unhandled" }, 404);
    },
  };
  return hindsight;
}

function client(hindsight: MockHindsight): HindsightClient {
  return new HindsightClient(API_URL, undefined, hindsight.fetch, 5_000);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

/** A clock that advances by `stepMs` on every read, starting at `startMs`. */
function tickingClock(startMs: number, stepMs: number): () => number {
  let current = startMs;
  return () => {
    const value = current;
    current += stepMs;
    return value;
  };
}

describe("hindsight client paging endpoints", () => {
  it("lists documents and mental models with bounded pages", async () => {
    const hindsight = mockHindsight({ documents: 3, models: [{ id: "m1", is_stale: true }] });
    const c = client(hindsight);

    const docs = await c.listDocuments(BANK, 2, 0);
    assert.equal(docs.items.length, 2);
    assert.equal(docs.total, 3);
    assert.equal(docs.items[0]!.id, "doc-1");
    assert.equal(docs.items[0]!.contentHash, "hash-1");

    const models = await c.listMentalModels(BANK, 10, 0);
    assert.equal(models.items.length, 1);
    assert.equal(models.items[0]!.isStale, true);
  });
});

describe("consolidation pass", () => {
  it("completes on an empty bank: walk ends immediately, no records created", async () => {
    const hindsight = mockHindsight({ documents: 0, models: [] });
    const before = hindsight.calls.length;

    const result = await runConsolidationPass(client(hindsight), {
      bankId: BANK,
      timeBudgetMs: 10_000,
      now: tickingClock(1_000, 1),
    });

    // The single list page of an empty bank completes the walk; one
    // consolidation is triggered; no model refreshes.
    assert.equal(result.completed, true);
    assert.equal(result.documentsProcessed, 0);
    assert.equal(result.consolidationsTriggered, 1);
    assert.equal(result.modelsRefreshed, 0);
    assert.equal(result.checkpoint.documentOffset, 0);
    assert.equal(result.checkpoint.documentTotal, 0);
    // No retain/memories write happened — the pass never creates records.
    assert.ok(!hindsight.calls.slice(before).some((call) => call.path.endsWith("/memories")));
  });

  it("walks several pages without duplicating anything and reports exact counts", async () => {
    const hindsight = mockHindsight({ documents: 7, models: [] });

    const result = await runConsolidationPass(client(hindsight), {
      bankId: BANK,
      timeBudgetMs: 10_000,
      pageSize: 3,
      now: tickingClock(1_000, 1),
    });

    assert.equal(result.completed, true);
    assert.equal(result.documentsProcessed, 7);
    assert.equal(result.checkpoint.documentOffset, 7);
    assert.equal(result.checkpoint.documentTotal, 7);
    // Three bounded list pages (3+3+1) and one consolidation trigger.
    const listPages = hindsight.calls.filter((call) => call.path.includes("/documents?")).length;
    assert.equal(listPages, 3);
    assert.equal(hindsight.consolidations, 1);
    // Nothing was written back: the pass only reads source records.
    assert.ok(!hindsight.calls.some((call) => call.path.endsWith("/memories")));
  });

  it("a repeat pass does not duplicate refreshes: only stale models are refreshed once", async () => {
    const hindsight = mockHindsight({
      documents: 2,
      models: [
        { id: "stale-a", is_stale: true },
        { id: "fresh-b", is_stale: false },
        { id: "stale-c", is_stale: true },
      ],
    });

    const first = await runConsolidationPass(client(hindsight), {
      bankId: BANK,
      timeBudgetMs: 10_000,
      now: tickingClock(1_000, 1),
    });
    assert.equal(first.modelsRefreshed, 2);
    assert.equal(first.modelsSkippedFresh, 1);
    assert.equal(hindsight.models.find((m) => m.id === "stale-a")!.refreshes, 1);
    assert.equal(hindsight.models.find((m) => m.id === "fresh-b")!.refreshes, 0);

    // Second pass over the same bank: the refreshed models are no longer
    // stale, so nothing is refreshed again — no duplicates.
    const second = await runConsolidationPass(client(hindsight), {
      bankId: BANK,
      timeBudgetMs: 10_000,
      now: tickingClock(2_000, 1),
    });
    assert.equal(second.modelsRefreshed, 0);
    assert.equal(second.modelsSkippedFresh, 3);
    assert.equal(hindsight.models.find((m) => m.id === "stale-a")!.refreshes, 1);
    assert.equal(hindsight.models.find((m) => m.id === "fresh-b")!.refreshes, 0);
    assert.equal(hindsight.models.find((m) => m.id === "stale-c")!.refreshes, 1);
    // Two passes trigger two consolidations; with the server deduplicating
    // the pending operation the second is reported as deduplicated.
    assert.equal(hindsight.consolidations, 2);
    assert.equal(first.consolidationDeduplicated, false);
  });

  it("a repeated pass over a completed checkpoint re-reads records without creating duplicates", async () => {
    const hindsight = mockHindsight({ documents: 4, models: [] });
    const checkpoint: ConsolidationCheckpoint = { documentOffset: 4, documentTotal: 4 };

    const first = await runConsolidationPass(client(hindsight), {
      bankId: BANK,
      timeBudgetMs: 10_000,
      now: tickingClock(1_000, 1),
    });
    assert.equal(first.completed, true);

    // Re-run with the finished checkpoint: the walk re-reads from the end of
    // the list and still completes; no record is created or lost.
    const repeat = await runConsolidationPass(client(hindsight), {
      bankId: BANK,
      timeBudgetMs: 10_000,
      checkpoint,
      now: tickingClock(5_000, 1),
    });
    assert.equal(repeat.completed, true);
    assert.equal(repeat.documentsProcessed, 0);
    assert.equal(hindsight.documents.length, 4);
    assert.ok(!hindsight.calls.some((call) => call.path.endsWith("/memories")));
    // Both passes asked for consolidation once; the repeat hit the pending op.
    assert.equal(hindsight.consolidations, 2);
  });

  it("stops mid-walk when the budget expires and returns the exact checkpoint and counters", async () => {
    const hindsight = mockHindsight({ documents: 10, models: [{ id: "stale-x", is_stale: true }] });

    // The clock advances 5 ms per read; the walk's first list call consumes
    // the whole 10 ms budget (reads at 0: start, 5: while, 10: post-walk).
    const result = await runConsolidationPass(client(hindsight), {
      bankId: BANK,
      timeBudgetMs: 10,
      pageSize: 4,
      now: tickingClock(0, 5),
    });

    assert.equal(result.completed, false);
    assert.equal(result.documentsProcessed, 4);
    assert.deepEqual(result.checkpoint, { documentOffset: 4, documentTotal: 10 });
    // Budget ran out right after the first page: no consolidation, no refresh.
    assert.equal(result.consolidationsTriggered, 0);
    assert.equal(result.modelsRefreshed, 0);
    assert.equal(hindsight.consolidations, 0);
    assert.equal(result.finishedAtMs, 10);
  });

  it("spends the remaining budget on the refresh cap, not on endless refreshes", async () => {
    const hindsight = mockHindsight({
      documents: 1,
      models: Array.from({ length: 5 }, (_, i) => ({ id: `stale-${i}`, is_stale: true })),
    });

    const result = await runConsolidationPass(client(hindsight), {
      bankId: BANK,
      timeBudgetMs: 60_000,
      maxModelRefreshes: 2,
      now: tickingClock(0, 1),
    });

    assert.equal(result.completed, true);
    assert.equal(result.modelsRefreshed, 2);
    assert.equal(result.modelsSkippedFresh, 0);
    assert.equal(hindsight.models.filter((m) => m.refreshes > 0).length, 2);
  });

  it("rejects a pass without a bank or with a non-positive budget", async () => {
    const hindsight = mockHindsight();
    await assert.rejects(
      runConsolidationPass(client(hindsight), { bankId: "", timeBudgetMs: 1_000 }),
      /bankId is required/,
    );
    await assert.rejects(
      runConsolidationPass(client(hindsight), { bankId: BANK, timeBudgetMs: 0 }),
      /timeBudgetMs must be a positive number/,
    );
  });

  it("a failed consolidation trigger does not lose the walk or the checkpoint", async () => {
    const hindsight = mockHindsight({ documents: 2, models: [] });
    // Break only the consolidate endpoint: the pass must still complete.
    const realFetch = hindsight.fetch;
    hindsight.fetch = async (url, init) => {
      const path = url.slice(API_URL.length);
      if ((init?.method ?? "GET") === "POST" && path.endsWith("/consolidate")) {
        return jsonResponse({ error: "consolidation worker down" }, 503);
      }
      return realFetch(url, init);
    };

    const result = await runConsolidationPass(client(hindsight), {
      bankId: BANK,
      timeBudgetMs: 10_000,
      now: tickingClock(1_000, 1),
    });

    assert.equal(result.completed, true);
    assert.equal(result.documentsProcessed, 2);
    assert.equal(result.consolidationsTriggered, 0);
    assert.deepEqual(result.checkpoint, { documentOffset: 2, documentTotal: 2 });
  });

  it("stops mid-walk and returns saved checkpoint with exact counters when an HTTP listDocuments call hangs", async () => {
    const hindsight = mockHindsight({ documents: 5, models: [] });
    const realFetch = hindsight.fetch;

    // Page 1 (offset 0, limit 2) succeeds normally.
    // Page 2 (offset 2, limit 2) hangs indefinitely until aborted.
    hindsight.fetch = async (url, init) => {
      if (url.includes("offset=2")) {
        return new Promise<Response>((_, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      }
      return realFetch(url, init);
    };

    const started = Date.now();
    const result = await runConsolidationPass(client(hindsight), {
      bankId: BANK,
      timeBudgetMs: 50,
      pageSize: 2,
    });
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 35 && elapsed < 2000, `Elapsed ${elapsed}ms was not within budget`);
    assert.equal(result.completed, false);
    assert.equal(result.documentsProcessed, 2);
    assert.deepEqual(result.checkpoint, { documentOffset: 2, documentTotal: 5 });
    assert.equal(result.consolidationsTriggered, 0);
    assert.equal(result.modelsRefreshed, 0);
    assert.ok(result.finishedAtMs >= started + 40);
  });

  it("aborts hanging triggerConsolidation within time budget and preserves checkpoint of completed walk", async () => {
    const hindsight = mockHindsight({ documents: 2, models: [{ id: "m1", is_stale: true }] });
    const realFetch = hindsight.fetch;

    // Document walk succeeds, but POST /consolidate hangs indefinitely until aborted.
    hindsight.fetch = async (url, init) => {
      const path = url.slice(API_URL.length);
      if ((init?.method ?? "GET") === "POST" && path.endsWith("/consolidate")) {
        return new Promise<Response>((_, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      }
      return realFetch(url, init);
    };

    const started = Date.now();
    const result = await runConsolidationPass(client(hindsight), {
      bankId: BANK,
      timeBudgetMs: 50,
      pageSize: 2,
    });
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 35 && elapsed < 2000, `Elapsed ${elapsed}ms was not within budget`);
    assert.equal(result.completed, true);
    assert.equal(result.documentsProcessed, 2);
    assert.deepEqual(result.checkpoint, { documentOffset: 2, documentTotal: 2 });
    assert.equal(result.consolidationsTriggered, 0);
    assert.equal(result.modelsRefreshed, 0);
    assert.ok(result.finishedAtMs >= started + 40);
  });

  it("aborts hanging refreshMentalModel within time budget and preserves earlier refreshed models", async () => {
    const hindsight = mockHindsight({
      documents: 1,
      models: [
        { id: "model-1", is_stale: true },
        { id: "model-2", is_stale: true },
      ],
    });
    const realFetch = hindsight.fetch;

    // First model refreshes, second model refresh hangs indefinitely until aborted.
    hindsight.fetch = async (url, init) => {
      const path = url.slice(API_URL.length);
      if ((init?.method ?? "GET") === "POST" && path.includes("model-2/refresh")) {
        return new Promise<Response>((_, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      }
      return realFetch(url, init);
    };

    const started = Date.now();
    const result = await runConsolidationPass(client(hindsight), {
      bankId: BANK,
      timeBudgetMs: 50,
      pageSize: 2,
    });
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 35 && elapsed < 2000, `Elapsed ${elapsed}ms was not within budget`);
    assert.equal(result.completed, true);
    assert.equal(result.documentsProcessed, 1);
    assert.equal(result.consolidationsTriggered, 1);
    assert.equal(result.modelsRefreshed, 1);
    assert.equal(hindsight.models.find((m) => m.id === "model-1")!.refreshes, 1);
    assert.equal(hindsight.models.find((m) => m.id === "model-2")!.refreshes, 0);
    assert.ok(result.finishedAtMs >= started + 40);
  });

  it("aborts hanging transport even if fetch completely ignores signal via Promise.race", async () => {
    const hindsight = mockHindsight({ documents: 5, models: [] });
    // This mock fetch returns an unresolving promise that never checks signal
    hindsight.fetch = () => new Promise<Response>(() => {});

    const started = Date.now();
    const result = await runConsolidationPass(client(hindsight), {
      bankId: BANK,
      timeBudgetMs: 50,
      pageSize: 2,
    });
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 35 && elapsed < 2000, `Elapsed ${elapsed}ms was not within budget`);
    assert.equal(result.completed, false);
    assert.equal(result.documentsProcessed, 0);
    assert.deepEqual(result.checkpoint, { documentOffset: 0, documentTotal: null });
    assert.equal(result.consolidationsTriggered, 0);
    assert.equal(result.modelsRefreshed, 0);
  });

  it("terminates early when caller abort signal fires", async () => {
    const hindsight = mockHindsight({ documents: 10, models: [] });
    const controller = new AbortController();

    const realFetch = hindsight.fetch;
    hindsight.fetch = async (url, init) => {
      // Abort caller signal on second page
      if (url.includes("offset=2")) {
        controller.abort();
      }
      return realFetch(url, init);
    };

    const result = await runConsolidationPass(client(hindsight), {
      bankId: BANK,
      timeBudgetMs: 10_000,
      pageSize: 2,
      signal: controller.signal,
    });

    assert.equal(result.completed, false);
    assert.equal(result.documentsProcessed, 2);
    assert.deepEqual(result.checkpoint, { documentOffset: 2, documentTotal: 10 });
  });
});
