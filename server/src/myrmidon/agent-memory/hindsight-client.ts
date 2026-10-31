// server/src/myrmidon/agent-memory/hindsight-client.ts
//
// myrmidon(MEMORY-UI): the board server's thin client for the memory bank
// service. The memory plugin's client (packages/plugins/hindsight-paperclip)
// only knows recall/retain — the card needs the curation surface instead:
// list, invalidate and clear. Transport is injectable so tests never reach a
// real service; no addresses live in this file.

import type {
  HindsightAsyncOperation,
  HindsightBankConfig,
  HindsightBankSummary,
} from "@myrmidon/shared";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 15_000;

/** One memory unit as the card shows it. Unknown fields are kept out. */
export interface HindsightMemoryItem {
  id: string;
  text: string;
  factType: string | null;
  state: string | null;
  occurredAt: string | null;
  createdAt: string | null;
  documentId: string | null;
  tags: string[];
}

export interface HindsightMemoryPage {
  items: HindsightMemoryItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface HindsightClientDeps {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** A memory the service refused to invalidate (e.g. a derived observation). */
export class HindsightCurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HindsightCurationError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parse one row of /memories/list; unknown shapes drop to a bare text row. */
export function parseMemoryItem(raw: unknown): HindsightMemoryItem | null {
  const row = asRecord(raw);
  if (!row) return null;
  const id = asString(row.id ?? row.memory_id);
  const text = typeof row.text === "string" ? row.text : "";
  if (!id) return null;
  const tags = Array.isArray(row.tags)
    ? row.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  return {
    id,
    text,
    factType: asString(row.fact_type ?? row.type),
    state: asString(row.state),
    occurredAt: asString(row.occurred_start ?? row.occurred_at),
    createdAt: asString(row.created_at),
    documentId: asString(row.document_id),
    tags,
  };
}

/** Parse a /memories/list body: `{ items: [...], total, limit, offset }`. */
export function parseMemoryPage(payload: unknown): HindsightMemoryPage | null {
  const body = asRecord(payload);
  if (!body || !Array.isArray(body.items)) return null;
  const items = body.items.map(parseMemoryItem).filter((item): item is HindsightMemoryItem => item !== null);
  return {
    items,
    total: typeof body.total === "number" ? body.total : items.length,
    limit: typeof body.limit === "number" ? body.limit : items.length,
    offset: typeof body.offset === "number" ? body.offset : 0,
  };
}

export type CreateMemoryHindsightClientOptions = {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

export function createMemoryHindsightClient(
  baseUrlOrOptions: string | CreateMemoryHindsightClientOptions,
  apiKey?: string,
  deps: HindsightClientDeps = {},
): HindsightControlClient {
  const options: CreateMemoryHindsightClientOptions =
    typeof baseUrlOrOptions === "string"
      ? { baseUrl: baseUrlOrOptions, apiKey, ...deps }
      : baseUrlOrOptions;
  const baseUrl = options.baseUrl;
  const key = options.apiKey;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const root = baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${root}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        const err = new HindsightCurationError(`HTTP ${response.status} from ${path}: ${text.slice(0, 200)}`);
        // 400 on PATCH is the service's "cannot curate this unit" answer.
        (err as HindsightCurationError & { status?: number }).status = response.status;
        throw err;
      }
      return text ? (JSON.parse(text) as unknown) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  const bankPath = (bankId: string, suffix: string) =>
    `/v1/default/banks/${encodeURIComponent(bankId)}/memories${suffix}`;

  return {
    async list(bankId: string, opts: { limit?: number; offset?: number; state?: string } = {}) {
      const limit = opts.limit ?? 50;
      const offset = opts.offset ?? 0;
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (opts.state) params.set("state", opts.state);
      const payload = await request("GET", `${bankPath(bankId, "/list")}?${params.toString()}`);
      const page = parseMemoryPage(payload);
      if (!page) throw new Error("memory service answered in an unexpected shape");
      return page;
    },
    async invalidate(bankId: string, memoryId: string, reason: string) {
      await request("PATCH", bankPath(bankId, `/${encodeURIComponent(memoryId)}`), {
        state: "invalidated",
        reason,
      });
    },
    async clear(bankId: string) {
      const payload = await request("DELETE", bankPath(bankId, ""));
      const body = asRecord(payload);
      const deletedCount = body && typeof body.deleted_count === "number" ? body.deleted_count : null;
      return { deletedCount };
    },
    async listBanks(): Promise<HindsightBankSummary[]> {
      const payload = await request("GET", "/v1/default/banks");
      const body = asRecord(payload);
      const rawList = Array.isArray(payload) ? payload : (Array.isArray(body?.banks) ? body.banks : []);
      return rawList.map((entry): HindsightBankSummary => {
        if (typeof entry === "string") {
          return { id: entry, name: entry };
        }
        const rec = asRecord(entry) ?? {};
        const id = asString(rec.id ?? rec.bank_id ?? rec.name) ?? "unknown";
        return {
          id,
          name: asString(rec.name) ?? id,
          description: asString(rec.description),
          memoriesCount: typeof rec.memories_count === "number" ? rec.memories_count : null,
          pendingConsolidations: typeof rec.pending_consolidations === "number" ? rec.pending_consolidations : null,
          failedConsolidations: typeof rec.failed_consolidations === "number" ? rec.failed_consolidations : null,
        };
      });
    },
    async getBankConfig(bankId: string): Promise<HindsightBankConfig> {
      const payload = await request("GET", `/v1/default/banks/${encodeURIComponent(bankId)}/config`);
      const body = asRecord(payload);
      const configObj = asRecord(body?.config) ?? body ?? {};
      return configObj as HindsightBankConfig;
    },
    async updateBankConfig(bankId: string, patch: Record<string, unknown>): Promise<HindsightBankConfig> {
      const payload = await request("PATCH", `/v1/default/banks/${encodeURIComponent(bankId)}/config`, patch);
      const body = asRecord(payload);
      const configObj = asRecord(body?.config) ?? body ?? {};
      return configObj as HindsightBankConfig;
    },
    async getBankStats(bankId: string): Promise<{ memoriesCount: number; pendingConsolidations: number; failedConsolidations: number }> {
      try {
        const payload = await request("GET", `/v1/default/banks/${encodeURIComponent(bankId)}/stats`);
        const body = asRecord(payload);
        return {
          memoriesCount: typeof body?.total_memories === "number" ? body.total_memories : 0,
          pendingConsolidations: typeof body?.pending_consolidation === "number" ? body.pending_consolidation : 0,
          failedConsolidations: typeof body?.failed_consolidation === "number" ? body.failed_consolidation : 0,
        };
      } catch {
        return { memoriesCount: 0, pendingConsolidations: 0, failedConsolidations: 0 };
      }
    },
    async getOperations(bankId: string, opts: { limit?: number; status?: string } = {}): Promise<HindsightAsyncOperation[]> {
      const params = new URLSearchParams();
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.status) params.set("status", opts.status);
      const query = params.toString() ? `?${params.toString()}` : "";
      try {
        const payload = await request("GET", `/v1/default/banks/${encodeURIComponent(bankId)}/operations${query}`);
        const body = asRecord(payload);
        const list = Array.isArray(body?.operations) ? body.operations : (Array.isArray(payload) ? payload : []);
        return list.map((item): HindsightAsyncOperation => {
          const rec = asRecord(item) ?? {};
          return {
            id: asString(rec.id ?? rec.operation_id) ?? "unknown",
            operation_type: asString(rec.operation_type ?? rec.type) ?? "consolidation",
            status: asString(rec.status) ?? "pending",
            created_at: asString(rec.created_at),
            error: asString(rec.error ?? rec.message),
          };
        });
      } catch {
        return [];
      }
    },
    async retryOperation(bankId: string, operationId: string): Promise<{ success: boolean; id: string }> {
      await request("POST", `/v1/default/banks/${encodeURIComponent(bankId)}/operations/${encodeURIComponent(operationId)}/retry`);
      return { success: true, id: operationId };
    },
    async recall(bankId: string, query: string, budget = "mid"): Promise<{ results: Array<{ text: string; score?: number }>; durationMs: number }> {
      const start = Date.now();
      const payload = await request("POST", `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`, {
        query,
        budget,
      });
      const durationMs = Date.now() - start;
      const body = asRecord(payload);
      const resultsRaw = Array.isArray(body?.results) ? body.results : [];
      const results = resultsRaw.map((entry) => {
        if (typeof entry === "string") return { text: entry };
        const rec = asRecord(entry) ?? {};
        return {
          text: typeof rec.text === "string" ? rec.text : JSON.stringify(rec),
          score: typeof rec.score === "number" ? rec.score : undefined,
        };
      });
      return { results, durationMs };
    },
  };
}

export interface MemoryHindsightClient {
  list(bankId: string, opts?: { limit?: number; offset?: number; state?: string }): Promise<HindsightMemoryPage>;
  invalidate(bankId: string, memoryId: string, reason: string): Promise<void>;
  clear(bankId: string): Promise<{ deletedCount: number | null }>;
  listBanks?(): Promise<HindsightBankSummary[]>;
  getBankConfig?(bankId: string): Promise<HindsightBankConfig>;
  updateBankConfig?(bankId: string, patch: Record<string, unknown>): Promise<HindsightBankConfig>;
  getBankStats?(bankId: string): Promise<{ memoriesCount: number; pendingConsolidations: number; failedConsolidations: number }>;
  getOperations?(bankId: string, opts?: { limit?: number; status?: string }): Promise<HindsightAsyncOperation[]>;
  retryOperation?(bankId: string, operationId: string): Promise<{ success: boolean; id: string }>;
  recall?(bankId: string, query: string, budget?: string): Promise<{ results: Array<{ text: string; score?: number }>; durationMs: number }>;
}

export interface HindsightControlClient extends MemoryHindsightClient {
  listBanks(): Promise<HindsightBankSummary[]>;
  getBankConfig(bankId: string): Promise<HindsightBankConfig>;
  updateBankConfig(bankId: string, patch: Record<string, unknown>): Promise<HindsightBankConfig>;
  getBankStats(bankId: string): Promise<{ memoriesCount: number; pendingConsolidations: number; failedConsolidations: number }>;
  getOperations(bankId: string, opts?: { limit?: number; status?: string }): Promise<HindsightAsyncOperation[]>;
  retryOperation(bankId: string, operationId: string): Promise<{ success: boolean; id: string }>;
  recall(bankId: string, query: string, budget?: string): Promise<{ results: Array<{ text: string; score?: number }>; durationMs: number }>;
}
