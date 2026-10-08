// myrmidon(1.6.6-CORPUS-SHADOW A): the shadow-mode runner for the corpus
// module comparison (OPE-6166 part A, ticket OPE-6171).
//
// Contract (frozen by the ticket): with the instance flag `corpus.shadow` off
// — the default — nothing in this module runs: no corpus call, no shadow row,
// byte-for-byte the old behavior. With it on, every search call the bot
// runtime makes at the knowledge MCP tools (today RAGFlow, via
// `MYRMIDON_BOT_MCP_SERVERS`) is ALSO fired fire-and-forget at the corpus
// module behind the OPE-6165 `SearchIndex` port, and both answers land as one
// row in `corpus_shadow_log`. The bot always keeps receiving the RAGFlow
// answer: the shadow leg can never change the response, block it or time it
// out; its own failures are caught and recorded in `module_error` only.
//
// The corpus port is injected. The hybrid SearchIndex implementation ships in
// a later part of OPE-6165; until a real one is wired, the default
// implementation is a no-op returning [] — the shadow rows still prove the
// wiring, and p95 of the module leg reflects the no-op until then.
import { desc } from "drizzle-orm";
import { corpusShadowLog, type Db } from "@paperclipai/db";

/**
 * The retrieval port the shadow leg calls — structurally the `SearchIndex`
 * interface of OPE-6165 (`packages/corpus/src/ports.ts`), declared locally so
 * the server does not gain a package dependency before the MCP facade of the
 * corpus module wires it up (part B connects the real implementation here).
 */
export type CorpusShadowSearchHit = { chunkId: string };
export type CorpusShadowSearchQuery = { dataset?: string; text: string };
export interface CorpusShadowSearch {
  search(query: CorpusShadowSearchQuery): Promise<CorpusShadowSearchHit[]>;
}

/** The no-op default: part A must not block on the unmerged implementation. */
export const noOpCorpusShadowSearch: CorpusShadowSearch = {
  async search() {
    return [];
  },
};

export type ShadowSearchCallPlan = {
  /** Knowledge-base / dataset name the query was aimed at. */
  dataset: string | null;
  /** Raw query text of the search call. */
  query: string;
};

const DATASET_KEYS = ["dataset", "dataset_name", "dataset_id", "kb", "knowledge_base"];
const QUERY_KEYS = ["query", "question", "text"];

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstStringField(params: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const raw = params[key];
    if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
    if (Array.isArray(raw)) {
      const first = raw.find((item) => typeof item === "string" && item.trim() !== "");
      if (typeof first === "string") return first.trim();
    }
  }
  return null;
}

/**
 * Is this gateway descriptor a knowledge search call worth shadowing?
 * The bot runtime reaches RAGFlow only as an instance-wide MCP server named
 * `ragflow` (SETTINGS.md `MYRMIDON_BOT_MCP_SERVERS`), so the call is an
 * `mcp_remote_http` tool whose gateway name carries the connection segment
 * `ragflow`. A connection other than the knowledge one is never shadowed,
 * and `ocr` (DeepDOC parsing over the same server) is never a search.
 */
export function isShadowSearchTool(input: { name: string; upstreamToolName?: string | null }): boolean {
  const names = [input.name, input.upstreamToolName ?? ""].join("/").toLowerCase();
  if (!names.includes("ragflow")) return false;
  return /search|retriev|knowledge|\bqa\b/.test(names);
}

/**
 * Extract (dataset, query) from the tool arguments. Returns null when the
 * call has no usable query text — such a call is not shadowed.
 */
export function parseShadowSearchCall(parameters: unknown): ShadowSearchCallPlan | null {
  const params = recordOf(parameters);
  if (!params) return null;
  const query = firstStringField(params, QUERY_KEYS);
  if (!query) return null;
  return { dataset: firstStringField(params, DATASET_KEYS), query };
}

const CHUNK_ID_KEYS = ["chunk_id", "chunkId", "chunk_ids", "chunkIds"];

/**
 * Best-effort ordered chunk-id list out of a search result (RAGFlow answers
 * with a JSON document inside MCP content and, in newer versions, in
 * structuredContent). Deep-scans objects/arrays for chunk-id keys; strings
 * that parse as JSON are scanned as well. Deduplicated, order preserved.
 */
export function extractChunkIds(value: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    if (typeof raw === "number" && Number.isFinite(raw)) raw = String(raw);
    if (typeof raw !== "string" || raw === "") return;
    if (!seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  };
  const scan = (node: unknown, depth: number): void => {
    if (depth > 12 || node == null) return;
    if (typeof node === "string") {
      const text = node.trim();
      if (text.startsWith("{") || text.startsWith("[")) {
        try {
          scan(JSON.parse(text), depth + 1);
        } catch {
          /* not JSON — no chunk ids in prose */
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) scan(item, depth + 1);
      return;
    }
    const rec = recordOf(node);
    if (!rec) return;
    for (const [key, child] of Object.entries(rec)) {
      if (CHUNK_ID_KEYS.includes(key)) {
        if (Array.isArray(child)) for (const item of child) push(item);
        else push(child);
      } else {
        scan(child, depth + 1);
      }
    }
  };
  scan(value, 0);
  return out;
}

/** One shadow row, the part-B comparison contract. */
export type CorpusShadowRow = {
  botId: string | null;
  dataset: string | null;
  query: string;
  ragflowChunkIds: string[];
  ragflowLatencyMs: number;
  moduleChunkIds: string[] | null;
  moduleLatencyMs: number | null;
  moduleError: string | null;
};

export interface CorpusShadowRunner {
  /** Whether the shadow comparison runs right now (live flag, no restart). */
  isEnabled(): boolean;
  /**
   * Fire-and-forget: start the shadow leg and its row write. Never returns a
   * rejection, never throws synchronously, contributes no work to the await
   * path of the caller — the bot response is already decided by then.
   */
  recordShadowCall(input: {
    plan: ShadowSearchCallPlan;
    botId: string | null;
    ragflowChunkIds: string[];
    ragflowLatencyMs: number;
  }): void;
  /** Await the in-flight shadow legs (tests and graceful shutdown only). */
  settle(): Promise<void>;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

export function createCorpusShadowRunner(deps: {
  db: Db;
  /** Live-flag reader (a function so the process-wide store is injectable). */
  isEnabled: () => boolean;
  /** The corpus module behind the SearchIndex-shaped port. */
  search?: CorpusShadowSearch;
  /** Shadow-leg deadline; it bounds the row's module_latency_ms, never the bot. */
  timeoutMs?: number;
  logger?: Pick<Console, "warn">;
}): CorpusShadowRunner {
  const search = deps.search ?? noOpCorpusShadowSearch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const inFlight = new Set<Promise<void>>();

  async function writeRow(row: CorpusShadowRow): Promise<void> {
    await deps.db.insert(corpusShadowLog).values({
      botId: row.botId,
      dataset: row.dataset,
      query: row.query,
      ragflowChunkIds: row.ragflowChunkIds,
      ragflowLatencyMs: row.ragflowLatencyMs,
      moduleChunkIds: row.moduleChunkIds,
      moduleLatencyMs: row.moduleLatencyMs,
      moduleError: row.moduleError,
    });
  }

  async function leg(input: {
    plan: ShadowSearchCallPlan;
    botId: string | null;
    ragflowChunkIds: string[];
    ragflowLatencyMs: number;
  }): Promise<void> {
    const started = Date.now();
    let moduleChunkIds: string[] | null = null;
    let moduleError: string | null = null;
    try {
      const hits = await withTimeout(
        search.search({ dataset: input.plan.dataset ?? undefined, text: input.plan.query }),
        timeoutMs,
      );
      moduleChunkIds = hits.map((hit) => hit.chunkId);
    } catch (error) {
      moduleError = errorText(error);
    }
    const moduleLatencyMs = Date.now() - started;
    try {
      await writeRow({
        botId: input.botId,
        dataset: input.plan.dataset,
        query: input.plan.query,
        ragflowChunkIds: input.ragflowChunkIds,
        ragflowLatencyMs: input.ragflowLatencyMs,
        moduleChunkIds,
        moduleLatencyMs,
        moduleError,
      });
    } catch (error) {
      // The log is the deliverable of the shadow leg, not of the bot: a
      // failed insert is surfaced to the operator log and nothing else.
      deps.logger?.warn?.(
        { err: error, action: "myrmidon.corpus_shadow.insert_failed" },
        "corpus shadow row insert failed",
      );
    }
  }

  function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`corpus shadow search timed out after ${ms} ms`)), ms);
      timer.unref?.();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  return {
    isEnabled: () => deps.isEnabled(),
    recordShadowCall(input) {
      const task = leg(input).catch(() => undefined);
      inFlight.add(task);
      void task.finally(() => {
        inFlight.delete(task);
      });
    },
    async settle() {
      await Promise.allSettled([...inFlight]);
    },
  };
}

/**
 * The one-line decision used at the gateway success tail: flag off, non-remote
 * leg, non-search tool or a call without query text — nothing happens at all.
 * Synchronous, never throws: the bot response is already built by the caller
 * and cannot be touched from here.
 */
export function maybeRecordShadowSearchCall(deps: {
  runner: CorpusShadowRunner;
  tool: { name: string; upstreamToolName?: string | null };
  /** Non-null only on the remote MCP leg — the knowledge tools live there. */
  execution: unknown | null;
  /** The normalized tool result returned to the bot (same object, read-only). */
  result: unknown;
  parameters: unknown;
  botId: string | null;
  latencyMs: number;
}): void {
  try {
    if (!deps.execution) return;
    if (!deps.runner.isEnabled()) return;
    if (!isShadowSearchTool(deps.tool)) return;
    const plan = parseShadowSearchCall(deps.parameters);
    if (!plan) return;
    deps.runner.recordShadowCall({
      plan,
      botId: deps.botId,
      ragflowChunkIds: extractChunkIds(deps.result),
      ragflowLatencyMs: Math.max(0, Math.round(deps.latencyMs)),
    });
  } catch {
    /* the shadow leg must never reach the bot */
  }
}

/** Most recent shadow rows — the part-B comparison reads the same table. */
export async function readCorpusShadowRows(db: Db, limit = 50) {
  return db.select().from(corpusShadowLog).orderBy(desc(corpusShadowLog.ts)).limit(limit);
}
