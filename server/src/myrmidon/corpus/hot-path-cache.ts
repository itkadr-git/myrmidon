// server/src/myrmidon/corpus/hot-path-cache.ts
//
// OPE-12272 (1.6.7 CORPUS-LATENCY): two small in-process caches that keep slow work off the hot
// path of a corpus search.
//
//   * The query-vector cache. Embedding a question is a call to the embedder gateway (about 2 s on
//     a cold query). The same question asked again within the TTL reuses the vector. The key is the
//     company, the embedder (base URL, model, dimensions) and the exact text, so two companies or
//     two models never share a vector. The cache holds the promise: identical questions that are in
//     flight at the same time share one embedder call.
//   * The dataset-list cache. `listDatasets` counts the documents and the chunks of every dataset
//     (seconds on a corpus of hundreds of thousands of chunks). A search never needs those counts
//     (it uses `listDatasetNames`), but the `corpus_list_datasets` tool and the board screen do.
//     Their answer is kept per company for a short TTL and dropped at once when a write goes
//     through the same ports (dataset, document or chunk change).
//
//   * The embedder key cache (second hot-path change). Embedding a question needs the API key of
//     the company's embedder secret. Resolving it through the secrets service is several reads and a
//     write of an access event, on every cold question. The resolved key is kept for a short TTL,
//     under the id and the latest version of the secret: a rotated or replaced secret is seen on the
//     next question, because the (cheap) lookup of the secret row still runs every time.
//
// The caches live in the process, like the rest of the module's in-memory state. Port objects are
// created per request, so the caches are module-level singletons the port factory hands in. This
// file has no database, no HTTP and no clock of its own beyond `Date.now`, so the suite drives it
// with a fake clock and fake ports.

import type { CorpusDatasetRecord, CorpusPorts } from "./ports.js";

/** Seconds a question's vector is reused. `0` turns the cache off. */
export const CORPUS_QUERY_EMBED_CACHE_TTL_ENV = "MYRMIDON_CORPUS_QUERY_EMBED_CACHE_TTL_SEC";
export const DEFAULT_QUERY_EMBED_CACHE_TTL_SEC = 600;

/** Seconds the dataset list (with its counters) is reused. `0` turns the cache off. */
export const CORPUS_DATASET_LIST_CACHE_TTL_ENV = "MYRMIDON_CORPUS_DATASET_LIST_CACHE_TTL_SEC";
export const DEFAULT_DATASET_LIST_CACHE_TTL_SEC = 60;

/** Seconds the resolved embedder API key is reused. `0` turns the cache off. */
export const CORPUS_EMBED_KEY_CACHE_TTL_ENV = "MYRMIDON_CORPUS_EMBED_KEY_CACHE_TTL_SEC";
export const DEFAULT_EMBED_KEY_CACHE_TTL_SEC = 60;

/** Resolved embedder keys kept at most (one per company and secret version). */
const EMBED_KEY_CACHE_MAX_ENTRIES = 64;

/** A TTL above one day is a typo, not a wish: the cache never outlives a day. */
const MAX_CACHE_TTL_SEC = 86_400;

/** Vectors kept at most (1024 numbers each). Enough for a golden set run, small in memory. */
const QUERY_VECTOR_CACHE_MAX_ENTRIES = 512;

/** Companies whose dataset list is kept at most. */
const DATASET_LIST_CACHE_MAX_COMPANIES = 256;

/**
 * A TTL setting in seconds, as milliseconds. Unset, empty, non-numeric or negative reads as the
 * default (a typo must not switch a cache off or make it eternal); `0` is an explicit "off"; a
 * value above one day reads as one day.
 */
export function readCacheTtlMs(raw: string | undefined, defaultSeconds: number): number {
  const text = raw?.trim();
  if (!text) return defaultSeconds * 1000;
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds < 0) return defaultSeconds * 1000;
  return Math.round(Math.min(seconds, MAX_CACHE_TTL_SEC) * 1000);
}

/**
 * The cache key of a question's vector: the company, the embedder (base URL, model, dimensions)
 * and the exact text. Another model or another company never reads this vector.
 */
export function queryVectorKey(input: {
  companyId: string;
  embedderBaseUrl: string | null;
  embedderModel: string;
  embedderDimensions: number;
  query: string;
}): string {
  return JSON.stringify([input.companyId, input.embedderBaseUrl, input.embedderModel, input.embedderDimensions, input.query]);
}

export interface TtlPromiseCache<T> {
  /**
   * The value for `key`: the cached (or in-flight) one while it is younger than `ttlMs`, else the
   * result of `compute`, which is then kept. A `ttlMs` of 0 or less computes every time and keeps
   * nothing. A failed computation is never kept.
   */
  get(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T>;
  clear(): void;
  readonly size: number;
}

/** The vector cache is the generic one, holding vectors. */
export type QueryVectorCache = TtlPromiseCache<number[]>;

export function createTtlPromiseCache<T>(
  options: { maxEntries?: number; now?: () => number } = {},
): TtlPromiseCache<T> {
  const maxEntries = options.maxEntries ?? QUERY_VECTOR_CACHE_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { expiresAt: number; value: Promise<T> }>();
  return {
    get(key, ttlMs, compute) {
      if (ttlMs <= 0) return compute();
      const at = now();
      const cached = entries.get(key);
      if (cached && cached.expiresAt > at) return cached.value;
      if (cached) entries.delete(key);
      const value = compute();
      entries.set(key, { value, expiresAt: at + ttlMs });
      void value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
      return value;
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

export function createQueryVectorCache(
  options: { maxEntries?: number; now?: () => number } = {},
): QueryVectorCache {
  return createTtlPromiseCache<number[]>(options);
}

/** The cache of resolved embedder keys the port factory shares between requests. */
export function createEmbedderKeyCache(options: { now?: () => number } = {}): TtlPromiseCache<string> {
  return createTtlPromiseCache<string>({ maxEntries: EMBED_KEY_CACHE_MAX_ENTRIES, ...options });
}

/** The row of the embedder secret a key is resolved from: only what the cache key needs. */
export interface EmbedderSecretRef {
  id: string;
  latestVersion: number;
}

export interface EmbedderKeyResolver {
  /** The active embedder secret of the company, or null when there is none. One cheap read. */
  findSecret(companyId: string): Promise<EmbedderSecretRef | null>;
  /**
   * Whether the company has the secret, and its key. The key comes from the cache while it is
   * younger than `ttlMs`; otherwise the secrets service resolves it (which writes an access event)
   * and the cache keeps it. The lookup of the secret row runs every time, and the cache key holds
   * the secret id and its latest version, so a rotated, replaced or deactivated secret is never
   * served from an older entry. Nothing is kept for a company without the secret.
   */
  resolve(companyId: string, ttlMs: number): Promise<{ present: boolean; apiKey: string | undefined }>;
}

export function createEmbedderKeyResolver(deps: {
  cache: TtlPromiseCache<string>;
  findSecret(companyId: string): Promise<EmbedderSecretRef | null>;
  resolveValue(companyId: string, secretId: string): Promise<string>;
}): EmbedderKeyResolver {
  return {
    findSecret: deps.findSecret,
    async resolve(companyId, ttlMs) {
      const secret = await deps.findSecret(companyId);
      if (!secret) return { present: false, apiKey: undefined };
      const apiKey = await deps.cache.get(JSON.stringify([companyId, secret.id, secret.latestVersion]), ttlMs, () =>
        deps.resolveValue(companyId, secret.id),
      );
      return { present: true, apiKey };
    },
  };
}

export interface DatasetListCache {
  /**
   * The list for `companyId`: the cached one while it is younger than `ttlMs`, else the result of
   * `loader`, which is then kept. Concurrent loads of one company share one `loader` call. A `ttlMs`
   * of 0 or less always calls `loader` and keeps nothing. Callers get their own copy of the rows.
   */
  load(
    companyId: string,
    ttlMs: number,
    loader: () => Promise<CorpusDatasetRecord[]>,
  ): Promise<CorpusDatasetRecord[]>;
  /** A write changed the company's datasets, documents or chunks: forget its list. */
  invalidate(companyId: string): void;
  /** A write whose company is not known: forget every list. */
  clear(): void;
}

const copyRows = (rows: CorpusDatasetRecord[]): CorpusDatasetRecord[] => rows.map((row) => ({ ...row }));

export function createDatasetListCache(options: { now?: () => number } = {}): DatasetListCache {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { expiresAt: number; rows: CorpusDatasetRecord[] }>();
  // Bumped by every invalidation. A load that started before the bump read rows that may predate
  // the write, so its result is returned to its callers but never kept.
  const epochs = new Map<string, number>();
  let globalEpoch = 0;
  const epochOf = (companyId: string) => `${globalEpoch}:${epochs.get(companyId) ?? 0}`;
  const inflight = new Map<string, { epoch: string; promise: Promise<CorpusDatasetRecord[]> }>();

  return {
    async load(companyId, ttlMs, loader) {
      if (ttlMs <= 0) return loader();
      const at = now();
      const cached = entries.get(companyId);
      if (cached && cached.expiresAt > at) return copyRows(cached.rows);
      const epoch = epochOf(companyId);
      const running = inflight.get(companyId);
      if (running && running.epoch === epoch) return copyRows(await running.promise);

      const promise = Promise.resolve()
        .then(loader)
        .then((rows) => {
          if (epochOf(companyId) === epoch) {
            entries.set(companyId, { expiresAt: at + ttlMs, rows: copyRows(rows) });
            while (entries.size > DATASET_LIST_CACHE_MAX_COMPANIES) entries.delete(entries.keys().next().value!);
          }
          return rows;
        });
      const entry = { epoch, promise };
      inflight.set(companyId, entry);
      const settle = () => {
        if (inflight.get(companyId) === entry) inflight.delete(companyId);
      };
      promise.then(settle, settle);
      return copyRows(await promise);
    },
    invalidate(companyId) {
      epochs.set(companyId, (epochs.get(companyId) ?? 0) + 1);
      entries.delete(companyId);
    },
    clear() {
      globalEpoch += 1;
      entries.clear();
    },
  };
}

/** The process-wide dataset-list cache the port factory uses. */
export const sharedDatasetListCache: DatasetListCache = createDatasetListCache();

/**
 * Store methods that only read. Every other method of the store and of the index port is taken
 * for a write and drops the company's cached list: a method added later is covered by default,
 * the cost of a wrong guess is one extra load, not a stale list.
 */
const STORE_READ_METHODS: ReadonlySet<string> = new Set([
  "listDatasets",
  "listDatasetNames",
  "getDataset",
  "hasDataset",
  "listDocuments",
  "getDocument",
  "getDocumentNames",
  "listSourceDocuments",
  "countDocuments",
  "getJob",
  "counters",
]);
const INDEX_READ_METHODS: ReadonlySet<string> = new Set(["search", "countChunks", "assertEmbedderConfigured"]);

/** The tenant a call acts for: a `companyId` string, or the `companyId` of an input object. */
function companyIdOf(firstArgument: unknown): string | null {
  if (typeof firstArgument === "string") return firstArgument;
  if (firstArgument !== null && typeof firstArgument === "object") {
    const companyId = (firstArgument as { companyId?: unknown }).companyId;
    if (typeof companyId === "string") return companyId;
  }
  return null;
}

/** The port with every non-read method followed (success or failure) by `afterWrite(args)`. */
function notifyAfterWrites<P extends object>(
  port: P,
  reads: ReadonlySet<string>,
  afterWrite: (args: unknown[]) => void,
): P {
  const wrapped: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(port)) {
    if (typeof member !== "function" || reads.has(name)) {
      wrapped[name] = member;
      continue;
    }
    wrapped[name] = async (...args: unknown[]) => {
      try {
        return await (member as (...callArgs: unknown[]) => unknown).apply(port, args);
      } finally {
        afterWrite(args);
      }
    };
  }
  return wrapped as unknown as P;
}

/**
 * The ports with `store.listDatasets` served from the cache for `ttlMs`. A write through the
 * returned ports (dataset, document or chunk change) drops the company's list, also when it
 * fails: it may have changed a row before it failed. A `ttlMs` of 0 returns the ports as they are.
 *
 * The cache is per process. A write made by another process (an import script on its own
 * connection) is seen after at most `ttlMs`.
 */
export function withDatasetListCache(
  ports: CorpusPorts,
  options: { ttlMs: number; cache?: DatasetListCache },
): CorpusPorts {
  const { ttlMs } = options;
  if (ttlMs <= 0) return ports;
  const cache = options.cache ?? sharedDatasetListCache;
  const afterWrite = (args: unknown[]) => {
    const companyId = companyIdOf(args[0]);
    if (companyId) cache.invalidate(companyId);
    else cache.clear();
  };
  const store = notifyAfterWrites(ports.store, STORE_READ_METHODS, afterWrite);
  return {
    ...ports,
    store: {
      ...store,
      listDatasets: (companyId) => cache.load(companyId, ttlMs, () => ports.store.listDatasets(companyId)),
    },
    index: notifyAfterWrites(ports.index, INDEX_READ_METHODS, afterWrite),
  };
}
