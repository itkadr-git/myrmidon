/**
 * Hindsight API client (fork of the upstream 0.3.0 client).
 *
 * The transport is injectable so the plugin's unit tests never talk to a real
 * Hindsight service: tests pass a mock fetch, the worker passes nothing and
 * gets the global fetch. No addresses are built into this file.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RetainMetadata {
  [key: string]: unknown;
}

/** One entry of `GET /banks/{id}/documents` (ListDocumentsResponse items). */
export interface BankDocumentItem {
  id: string;
  contentHash?: string | null;
  textLength?: number;
  memoryUnitCount?: number;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

/** One page of the bank's document list. */
export interface BankDocumentsPage {
  items: BankDocumentItem[];
  total: number;
  limit: number;
  offset: number;
}

/** One entry of `GET /banks/{id}/mental-models`. */
export interface BankMentalModelItem {
  id: string;
  name: string;
  /** Server-computed: in-scope memories were written since the last refresh. */
  isStale?: boolean | null;
  lastRefreshedAt?: string | null;
}

/** One page of the bank's mental-model list. */
export interface BankMentalModelsPage {
  items: BankMentalModelItem[];
  total: number;
  limit: number;
  offset: number;
}

/** `POST /banks/{id}/consolidate` — the server deduplicates pending operations. */
export interface ConsolidationTriggerResult {
  operationId: string;
  /** True when an equivalent consolidation was already pending and was reused. */
  deduplicated: boolean;
}

/** Submit receipt of an async operation (`consolidate`, model refresh). */
export interface AsyncOperationTicket {
  operationId: string;
  status?: string;
}

/** Per-request tuning: override timeout or link an external AbortSignal. */
export interface RequestOptions {
  /** Maximum time (ms) to wait for this request. Overrides client default. */
  timeoutMs?: number;
  /** Caller-supplied abort signal. */
  signal?: AbortSignal;
}

export function createTimeoutError(message = "The operation timed out"): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException(message, "TimeoutError");
  }
  const err = new Error(message);
  err.name = "TimeoutError";
  return err;
}

export function createAbortError(message = "The operation was aborted"): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException(message, "AbortError");
  }
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export const DEFAULT_TIMEOUT_MS = 60_000;

export class HindsightClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: FetchLike;
  readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    token?: string,
    fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    const url = baseUrl.trim();
    if (!url) throw new Error("hindsightApiUrl is required");
    this.baseUrl = url.replace(/\/$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    return headers;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<unknown> {
    const controller = new AbortController();
    const effectiveTimeout = options?.timeoutMs !== undefined
      ? options.timeoutMs
      : this.timeoutMs;

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (effectiveTimeout <= 0) {
      controller.abort(createAbortError("The operation was aborted"));
    } else if (effectiveTimeout < Infinity) {
      timer = setTimeout(() => {
        controller.abort(createAbortError("The operation was aborted"));
      }, effectiveTimeout);
    }

    const onCallerAbort = () => {
      controller.abort(options?.signal?.reason ?? createAbortError("The operation was aborted"));
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort(options.signal.reason ?? createAbortError("The operation was aborted"));
      } else {
        options.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    try {
      const fetchPromise = this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (fetchPromise && typeof fetchPromise.catch === "function") {
        fetchPromise.catch(() => {});
      }

      const abortPromise = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) {
          reject(controller.signal.reason ?? createAbortError("The operation was aborted"));
          return;
        }
        controller.signal.addEventListener("abort", () => {
          reject(controller.signal.reason ?? createAbortError("The operation was aborted"));
        }, { once: true });
      });

      const response = await Promise.race([fetchPromise, abortPromise]);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} from ${path}: ${text}`);
      }

      const jsonPromise = response.json();
      if (jsonPromise && typeof jsonPromise.catch === "function") {
        jsonPromise.catch(() => {});
      }
      return await Promise.race([jsonPromise, abortPromise]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (options?.signal) {
        options.signal.removeEventListener("abort", onCallerAbort);
      }
    }
  }

  async recall(
    bankId: string,
    query: string,
    budget: string = "mid",
    options?: RequestOptions,
  ): Promise<{ results: Array<{ text: string }> }> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`;
    const response = await this.request("POST", path, {
      query,
      budget,
      max_tokens: 1024,
    }, options);
    return (response ?? { results: [] }) as { results: Array<{ text: string }> };
  }

  async retain(
    bankId: string,
    content: string,
    documentId: string | undefined,
    metadata: RetainMetadata | undefined,
    options?: RequestOptions,
  ): Promise<void> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories`;
    const item: Record<string, unknown> = {
      content,
      context: "paperclip",
    };
    if (documentId) item["document_id"] = documentId;
    if (metadata) item["metadata"] = metadata;
    await this.request("POST", path, { items: [item], async: true }, options);
  }

  /** One bounded page of the bank's stored documents. */
  async listDocuments(
    bankId: string,
    limit: number,
    offset: number,
    options?: RequestOptions,
  ): Promise<BankDocumentsPage> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/documents`
      + `?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`;
    const response = (await this.request("GET", path, undefined, options)) ?? {};
    const raw = response as { items?: unknown; total?: unknown; limit?: unknown; offset?: unknown };
    const items = Array.isArray(raw.items) ? raw.items : [];
    return {
      items: items
        .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
        .map((record) => {
          const snake = (key: string): unknown => record[key];
          return {
            id: typeof record["id"] === "string" ? record["id"] : String(record["id"] ?? ""),
            contentHash: typeof record["content_hash"] === "string"
              ? record["content_hash"]
              : typeof snake("contentHash") === "string"
                ? (snake("contentHash") as string)
                : null,
            textLength: typeof record["text_length"] === "number" ? record["text_length"] : undefined,
            memoryUnitCount: typeof record["memory_unit_count"] === "number" ? record["memory_unit_count"] : undefined,
            tags: Array.isArray(record["tags"]) ? (record["tags"] as string[]) : undefined,
            createdAt: typeof record["created_at"] === "string" ? record["created_at"] : undefined,
            updatedAt: typeof record["updated_at"] === "string" ? record["updated_at"] : undefined,
          };
        })
        .filter((item) => item.id.length > 0),
      total: typeof raw.total === "number" ? raw.total : items.length,
      limit: typeof raw.limit === "number" ? raw.limit : limit,
      offset: typeof raw.offset === "number" ? raw.offset : offset,
    };
  }

  /** One bounded page of the bank's mental models (freshness flags included). */
  async listMentalModels(
    bankId: string,
    limit: number,
    offset: number,
    options?: RequestOptions,
  ): Promise<BankMentalModelsPage> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/mental-models`
      + `?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`;
    const response = (await this.request("GET", path, undefined, options)) ?? {};
    const raw = response as { items?: unknown; total?: unknown; limit?: unknown; offset?: unknown };
    const items = Array.isArray(raw.items) ? raw.items : [];
    return {
      items: items
        .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
        .map((record) => {
          return {
            id: typeof record["id"] === "string" ? record["id"] : String(record["id"] ?? ""),
            name: typeof record["name"] === "string" ? record["name"] : String(record["name"] ?? ""),
            isStale: typeof record["is_stale"] === "boolean" ? record["is_stale"] : null,
            lastRefreshedAt: typeof record["last_refreshed_at"] === "string" ? record["last_refreshed_at"] : null,
          };
        })
        .filter((item) => item.id.length > 0),
      total: typeof raw.total === "number" ? raw.total : items.length,
      limit: typeof raw.limit === "number" ? raw.limit : limit,
      offset: typeof raw.offset === "number" ? raw.offset : offset,
    };
  }

  /**
   * Trigger the bank's consolidation. Hindsight deduplicates: when an
   * equivalent operation is already pending, it is reused (`deduplicated`).
   */
  async triggerConsolidation(
    bankId: string,
    options?: RequestOptions,
  ): Promise<ConsolidationTriggerResult> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/consolidate`;
    const response = (await this.request("POST", path, { deduplicated: true }, options)) as { operation_id?: unknown; deduplicated?: unknown };
    const operationId = typeof response?.["operation_id"] === "string" ? response["operation_id"] : "";
    if (!operationId) throw new Error(`consolidate returned no operation_id for bank ${bankId}`);
    return { operationId, deduplicated: response["deduplicated"] === true };
  }

  /** Ask Hindsight to refresh one mental model (async operation). */
  async refreshMentalModel(
    bankId: string,
    mentalModelId: string,
    options?: RequestOptions,
  ): Promise<AsyncOperationTicket> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/mental-models`
      + `/${encodeURIComponent(mentalModelId)}/refresh`;
    const response = (await this.request("POST", path, {}, options)) as { operation_id?: unknown; status?: unknown };
    const operationId = typeof response?.["operation_id"] === "string" ? response["operation_id"] : "";
    if (!operationId) throw new Error(`refresh returned no operation_id for model ${mentalModelId}`);
    return {
      operationId,
      status: typeof response["status"] === "string" ? response["status"] : undefined,
    };
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export function formatMemories(memories: Array<{ text: string }>): string {
  if (memories.length === 0) return "";
  return memories.map((memory) => `- ${memory.text}`).join("\n");
}
