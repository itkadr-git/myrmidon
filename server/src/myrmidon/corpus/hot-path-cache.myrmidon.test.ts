// server/src/myrmidon/corpus/hot-path-cache.myrmidon.test.ts
//
// OPE-12272: the two caches that keep slow work off the hot path of a corpus search.
// No database and no embedder: a fake clock and fake ports drive the real cache code.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DATASET_LIST_CACHE_TTL_SEC,
  DEFAULT_QUERY_EMBED_CACHE_TTL_SEC,
  createDatasetListCache,
  createQueryVectorCache,
  queryVectorKey,
  readCacheTtlMs,
  withDatasetListCache,
} from "./hot-path-cache.js";
import type { CorpusDatasetRecord, CorpusPorts } from "./ports.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";

function clock(start = 1_000) {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function dataset(id: string, companyId = COMPANY, documentCount = 1): CorpusDatasetRecord {
  return {
    id, companyId, name: `name-${id}`, description: null, createdAt: "2026-11-08T00:00:00.000Z", updatedAt: "2026-11-08T00:00:00.000Z",
    documentCount, readyCount: documentCount, failedCount: 0, chunkCount: documentCount * 10,
  };
}

describe("readCacheTtlMs", () => {
  it("reads unset, empty and blank as the default", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(readCacheTtlMs(raw, 600)).toBe(600_000);
    }
  });

  it("reads a number of seconds as milliseconds, and 0 as off", () => {
    expect(readCacheTtlMs("30", 600)).toBe(30_000);
    expect(readCacheTtlMs(" 45 ", 600)).toBe(45_000);
    expect(readCacheTtlMs("1.5", 600)).toBe(1_500);
    expect(readCacheTtlMs("0", 600)).toBe(0);
  });

  it("falls back to the default for a typo or a negative number, never to off", () => {
    for (const raw of ["abc", "-5", "NaN", "Infinity", "10s", "1,5"]) {
      expect(readCacheTtlMs(raw, 60), JSON.stringify(raw)).toBe(60_000);
    }
  });

  it("caps a value above one day", () => {
    expect(readCacheTtlMs("999999", 60)).toBe(86_400_000);
  });

  it("documents the defaults the settings table promises", () => {
    expect(DEFAULT_QUERY_EMBED_CACHE_TTL_SEC).toBe(600);
    expect(DEFAULT_DATASET_LIST_CACHE_TTL_SEC).toBe(60);
  });
});

describe("queryVectorKey", () => {
  const base = { companyId: COMPANY, embedderBaseUrl: null, embedderModel: "model-a", embedderDimensions: 1024, query: "how long to rest a brisket" };

  it("is the same for the same company, embedder and text", () => {
    expect(queryVectorKey({ ...base })).toBe(queryVectorKey({ ...base }));
  });

  it("differs by model, dimensions, base URL, company and exact text", () => {
    const key = queryVectorKey(base);
    expect(queryVectorKey({ ...base, embedderModel: "model-b" })).not.toBe(key);
    expect(queryVectorKey({ ...base, embedderDimensions: 768 })).not.toBe(key);
    expect(queryVectorKey({ ...base, embedderBaseUrl: "http://gateway.invalid/v1" })).not.toBe(key);
    expect(queryVectorKey({ ...base, companyId: OTHER_COMPANY })).not.toBe(key);
    expect(queryVectorKey({ ...base, query: `${base.query} ` })).not.toBe(key);
  });
});

describe("query vector cache", () => {
  it("reuses a vector within the TTL and computes again after it", async () => {
    const time = clock();
    const cache = createQueryVectorCache({ now: time.now });
    let computed = 0;
    const compute = async () => { computed += 1; return [computed]; };

    expect(await cache.get("q", 600_000, compute)).toEqual([1]);
    time.advance(599_000);
    expect(await cache.get("q", 600_000, compute)).toEqual([1]);
    expect(computed).toBe(1);

    time.advance(2_000);
    expect(await cache.get("q", 600_000, compute)).toEqual([2]);
    expect(computed).toBe(2);
  });

  it("shares one computation between identical questions in flight", async () => {
    const cache = createQueryVectorCache();
    const gate = deferred<number[]>();
    let computed = 0;
    const compute = () => { computed += 1; return gate.promise; };

    const first = cache.get("q", 60_000, compute);
    const second = cache.get("q", 60_000, compute);
    gate.resolve([0.5]);

    expect(await first).toEqual([0.5]);
    expect(await second).toEqual([0.5]);
    expect(computed).toBe(1);
  });

  it("keeps different questions apart", async () => {
    const cache = createQueryVectorCache();
    expect(await cache.get("a", 60_000, async () => [1])).toEqual([1]);
    expect(await cache.get("b", 60_000, async () => [2])).toEqual([2]);
    expect(await cache.get("a", 60_000, async () => [3])).toEqual([1]);
  });

  it("computes every time and keeps nothing when the TTL is 0", async () => {
    const cache = createQueryVectorCache();
    let computed = 0;
    const compute = async () => { computed += 1; return [computed]; };
    expect(await cache.get("q", 0, compute)).toEqual([1]);
    expect(await cache.get("q", 0, compute)).toEqual([2]);
    expect(cache.size).toBe(0);
  });

  it("does not keep a failed computation", async () => {
    const cache = createQueryVectorCache();
    let attempts = 0;
    const compute = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("embedder unavailable");
      return [7];
    };
    await expect(cache.get("q", 60_000, compute)).rejects.toThrow("embedder unavailable");
    expect(await cache.get("q", 60_000, compute)).toEqual([7]);
    expect(attempts).toBe(2);
  });

  it("holds at most maxEntries vectors and drops the oldest", async () => {
    const cache = createQueryVectorCache({ maxEntries: 2 });
    const computed: string[] = [];
    const get = (key: string) => cache.get(key, 60_000, async () => { computed.push(key); return [computed.length]; });
    await get("a");
    await get("b");
    await get("c");
    expect(cache.size).toBe(2);
    await get("b");
    await get("c");
    expect(computed).toEqual(["a", "b", "c"]);
    await get("a");
    expect(computed).toEqual(["a", "b", "c", "a"]);
  });
});

describe("dataset list cache", () => {
  it("serves the list from the cache within the TTL and loads again after it", async () => {
    const time = clock();
    const cache = createDatasetListCache({ now: time.now });
    let loads = 0;
    const loader = async () => { loads += 1; return [dataset(`d${loads}`)]; };

    expect((await cache.load(COMPANY, 60_000, loader)).map((row) => row.id)).toEqual(["d1"]);
    time.advance(59_000);
    expect((await cache.load(COMPANY, 60_000, loader)).map((row) => row.id)).toEqual(["d1"]);
    expect(loads).toBe(1);

    time.advance(2_000);
    expect((await cache.load(COMPANY, 60_000, loader)).map((row) => row.id)).toEqual(["d2"]);
    expect(loads).toBe(2);
  });

  it("keeps companies apart", async () => {
    const cache = createDatasetListCache();
    expect((await cache.load(COMPANY, 60_000, async () => [dataset("a")])).map((row) => row.id)).toEqual(["a"]);
    expect((await cache.load(OTHER_COMPANY, 60_000, async () => [dataset("b", OTHER_COMPANY)])).map((row) => row.id)).toEqual(["b"]);
    expect((await cache.load(COMPANY, 60_000, async () => [dataset("never")])).map((row) => row.id)).toEqual(["a"]);
  });

  it("forgets the list of one company when it is invalidated, and only that one", async () => {
    const cache = createDatasetListCache();
    let loads = 0;
    const loader = (id: string) => async () => { loads += 1; return [dataset(`${id}${loads}`)]; };
    await cache.load(COMPANY, 60_000, loader("a"));
    await cache.load(OTHER_COMPANY, 60_000, loader("b"));
    expect(loads).toBe(2);

    cache.invalidate(COMPANY);
    expect((await cache.load(COMPANY, 60_000, loader("a"))).map((row) => row.id)).toEqual(["a3"]);
    expect((await cache.load(OTHER_COMPANY, 60_000, loader("b"))).map((row) => row.id)).toEqual(["b2"]);
    expect(loads).toBe(3);
  });

  it("forgets every list on clear", async () => {
    const cache = createDatasetListCache();
    let loads = 0;
    const loader = async () => { loads += 1; return [dataset("x")]; };
    await cache.load(COMPANY, 60_000, loader);
    await cache.load(OTHER_COMPANY, 60_000, loader);
    cache.clear();
    await cache.load(COMPANY, 60_000, loader);
    await cache.load(OTHER_COMPANY, 60_000, loader);
    expect(loads).toBe(4);
  });

  it("shares one load between concurrent callers", async () => {
    const cache = createDatasetListCache();
    const gate = deferred<CorpusDatasetRecord[]>();
    let loads = 0;
    const loader = () => { loads += 1; return gate.promise; };
    const first = cache.load(COMPANY, 60_000, loader);
    const second = cache.load(COMPANY, 60_000, loader);
    gate.resolve([dataset("a")]);
    expect((await first).map((row) => row.id)).toEqual(["a"]);
    expect((await second).map((row) => row.id)).toEqual(["a"]);
    expect(loads).toBe(1);
  });

  it("does not keep a load that an invalidation overtook, and does not hand it to a later caller", async () => {
    const cache = createDatasetListCache();
    const stale = deferred<CorpusDatasetRecord[]>();
    let loads = 0;
    const loader = () => {
      loads += 1;
      return loads === 1 ? stale.promise : Promise.resolve([dataset("fresh")]);
    };

    const early = cache.load(COMPANY, 60_000, loader);
    cache.invalidate(COMPANY); // a write lands while the first load is still reading
    expect((await cache.load(COMPANY, 60_000, loader)).map((row) => row.id)).toEqual(["fresh"]);

    stale.resolve([dataset("stale")]);
    expect((await early).map((row) => row.id)).toEqual(["stale"]); // its own caller still gets what it read
    expect((await cache.load(COMPANY, 60_000, loader)).map((row) => row.id)).toEqual(["fresh"]);
    expect(loads).toBe(2);
  });

  it("hands each caller its own copy of the rows", async () => {
    const cache = createDatasetListCache();
    const loader = async () => [dataset("a", COMPANY, 3)];
    const first = await cache.load(COMPANY, 60_000, loader);
    first[0]!.documentCount = 999;
    first.push(dataset("junk"));
    const second = await cache.load(COMPANY, 60_000, loader);
    expect(second).toHaveLength(1);
    expect(second[0]!.documentCount).toBe(3);
  });

  it("always loads and keeps nothing when the TTL is 0", async () => {
    const cache = createDatasetListCache();
    let loads = 0;
    const loader = async () => { loads += 1; return [dataset("a")]; };
    await cache.load(COMPANY, 0, loader);
    await cache.load(COMPANY, 0, loader);
    expect(loads).toBe(2);
    await cache.load(COMPANY, 60_000, loader);
    expect(loads).toBe(3);
  });

  it("does not keep a failed load", async () => {
    const cache = createDatasetListCache();
    let loads = 0;
    const loader = async () => {
      loads += 1;
      if (loads === 1) throw new Error("database busy");
      return [dataset("a")];
    };
    await expect(cache.load(COMPANY, 60_000, loader)).rejects.toThrow("database busy");
    expect((await cache.load(COMPANY, 60_000, loader)).map((row) => row.id)).toEqual(["a"]);
    expect(loads).toBe(2);
  });
});

/** Ports whose store and index count every call; the data is one dataset per company. */
function spyPorts() {
  const calls: Record<string, number> = {};
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
  const queue = { async claim() { return []; } };
  const blobs = { async delete() {} };
  const parser = { async parse() { throw new Error("not used"); } };
  const ports = {
    store: {
      async listDatasets(companyId: string) { count("listDatasets"); return [dataset("d1", companyId, calls.listDatasets ?? 1)]; },
      async listDatasetNames() { count("listDatasetNames"); return [{ id: "d1", name: "name-d1" }]; },
      async getDataset() { count("getDataset"); return null; },
      async hasDataset() { count("hasDataset"); return true; },
      async listDocuments() { count("listDocuments"); return []; },
      async getDocument() { count("getDocument"); return null; },
      async getDocumentNames() { count("getDocumentNames"); return new Map<string, string>(); },
      async listSourceDocuments() { count("listSourceDocuments"); return []; },
      async countDocuments() { count("countDocuments"); return 0; },
      async getJob() { count("getJob"); return null; },
      async counters() { count("counters"); return { datasets: 1, documents: 1, ready: 1, pending: 0, failed: 0, chunks: 1, bytes: 1 }; },
      async createDataset(input: { companyId: string }) { count("createDataset"); return dataset("new", input.companyId); },
      async updateDataset() { count("updateDataset"); return null; },
      async deleteDataset() { count("deleteDataset"); return true; },
      async createDocument() { count("createDocument"); throw new Error("create failed"); },
      async updateDocument() { count("updateDocument"); return null; },
      async deleteDocument() { count("deleteDocument"); return true; },
    },
    blobs,
    queue,
    parser,
    index: {
      async indexDocument() { count("indexDocument"); return 1; },
      async deleteDocument() { count("indexDeleteDocument"); },
      async search() { count("search"); return []; },
      async countChunks() { count("countChunks"); return 0; },
      async assertEmbedderConfigured() { count("assertEmbedderConfigured"); },
    },
  };
  return { calls, ports: ports as unknown as CorpusPorts, raw: ports };
}

describe("withDatasetListCache", () => {
  it("serves listDatasets from the cache and keeps the counters of the first read", async () => {
    const { calls, ports } = spyPorts();
    const cached = withDatasetListCache(ports, { ttlMs: 60_000, cache: createDatasetListCache() });

    const first = await cached.store.listDatasets(COMPANY);
    const second = await cached.store.listDatasets(COMPANY);
    expect(calls.listDatasets).toBe(1);
    expect(second).toEqual(first);
    expect(first[0]!.documentCount).toBe(1);
  });

  it("expires the list after the TTL", async () => {
    const time = clock();
    const { calls, ports } = spyPorts();
    const cached = withDatasetListCache(ports, { ttlMs: 60_000, cache: createDatasetListCache({ now: time.now }) });
    await cached.store.listDatasets(COMPANY);
    time.advance(61_000);
    const reloaded = await cached.store.listDatasets(COMPANY);
    expect(calls.listDatasets).toBe(2);
    expect(reloaded[0]!.documentCount).toBe(1 + 1); // the fake counts its reads: the second read is a new one
  });

  it("is not touched by reads", async () => {
    const { calls, ports } = spyPorts();
    const cached = withDatasetListCache(ports, { ttlMs: 60_000, cache: createDatasetListCache() });
    await cached.store.listDatasets(COMPANY);

    await cached.store.listDatasetNames(COMPANY);
    await cached.store.getDataset(COMPANY, "d1");
    await cached.store.hasDataset(COMPANY, "d1");
    await cached.store.listDocuments(COMPANY, "d1");
    await cached.store.getDocument(COMPANY, "doc");
    await cached.store.getDocumentNames(COMPANY, ["doc"]);
    await cached.store.listSourceDocuments({ companyId: COMPANY, limit: 1 });
    await cached.store.countDocuments(COMPANY, "d1");
    await cached.store.getJob(COMPANY, "job");
    await cached.store.counters(COMPANY);
    await cached.index.search({ companyId: COMPANY, query: "q", limit: 5, mode: "hybrid", embedderModel: "m", embedderDimensions: 3, embedderBaseUrl: null });
    await cached.index.countChunks(COMPANY);
    await cached.index.assertEmbedderConfigured?.(COMPANY, null);

    await cached.store.listDatasets(COMPANY);
    expect(calls.listDatasets).toBe(1);
  });

  it("does not call listDatasets for the names a search needs", async () => {
    const { calls, ports } = spyPorts();
    const cached = withDatasetListCache(ports, { ttlMs: 60_000, cache: createDatasetListCache() });
    expect(await cached.store.listDatasetNames(COMPANY)).toEqual([{ id: "d1", name: "name-d1" }]);
    expect(calls.listDatasets).toBeUndefined();
  });

  const writes: Array<[string, (cached: CorpusPorts, companyId: string) => Promise<unknown>]> = [
    ["store.createDataset", (c, id) => c.store.createDataset({ companyId: id, name: "n", description: null })],
    ["store.updateDataset", (c, id) => c.store.updateDataset(id, "d1", { name: "n" })],
    ["store.deleteDataset", (c, id) => c.store.deleteDataset(id, "d1")],
    ["store.updateDocument", (c, id) => c.store.updateDocument(id, "doc", { status: "ready" })],
    ["store.deleteDocument", (c, id) => c.store.deleteDocument(id, "doc")],
    ["index.indexDocument", (c, id) => c.index.indexDocument({ companyId: id, datasetId: "d1", documentId: "doc", chunks: [], embedderModel: "m", embedderDimensions: 3, embedderBaseUrl: null })],
    ["index.deleteDocument", (c, id) => c.index.deleteDocument(id, "doc")],
  ];

  it.each(writes)("%s drops the list of its company and no other", async (_name, write) => {
    const { calls, ports } = spyPorts();
    const cached = withDatasetListCache(ports, { ttlMs: 60_000, cache: createDatasetListCache() });
    await cached.store.listDatasets(COMPANY);
    await cached.store.listDatasets(OTHER_COMPANY);
    expect(calls.listDatasets).toBe(2);

    await write(cached, OTHER_COMPANY);
    await cached.store.listDatasets(COMPANY);
    expect(calls.listDatasets).toBe(2); // the first company's list is still cached
    await cached.store.listDatasets(OTHER_COMPANY);
    expect(calls.listDatasets).toBe(3); // the writer's company reloads

    await write(cached, COMPANY);
    await cached.store.listDatasets(COMPANY);
    expect(calls.listDatasets).toBe(4);
  });

  it("drops the list of the company a document is created for, also when the write fails", async () => {
    const { calls, ports } = spyPorts();
    const cached = withDatasetListCache(ports, { ttlMs: 60_000, cache: createDatasetListCache() });
    await cached.store.listDatasets(COMPANY);

    await expect(
      cached.store.createDocument({ companyId: COMPANY, datasetId: "d1", filename: "f", mimeType: null, byteSize: 1, blobRef: "b", maxAttempts: 1 }),
    ).rejects.toThrow("create failed");
    await cached.store.listDatasets(COMPANY);
    expect(calls.listDatasets).toBe(2);
  });

  it("returns what the write returned", async () => {
    const { ports } = spyPorts();
    const cached = withDatasetListCache(ports, { ttlMs: 60_000, cache: createDatasetListCache() });
    expect((await cached.store.createDataset({ companyId: COMPANY, name: "n", description: null })).id).toBe("new");
    expect(await cached.store.deleteDataset(COMPANY, "d1")).toBe(true);
  });

  it("leaves the blob, queue and parser ports as they are", () => {
    const { raw, ports } = spyPorts();
    const cached = withDatasetListCache(ports, { ttlMs: 60_000, cache: createDatasetListCache() });
    expect(cached.blobs).toBe(raw.blobs);
    expect(cached.queue).toBe(raw.queue);
    expect(cached.parser).toBe(raw.parser);
  });

  it("returns the ports untouched when the TTL is 0", async () => {
    const { calls, ports } = spyPorts();
    const cached = withDatasetListCache(ports, { ttlMs: 0, cache: createDatasetListCache() });
    expect(cached).toBe(ports);
    await cached.store.listDatasets(COMPANY);
    await cached.store.listDatasets(COMPANY);
    expect(calls.listDatasets).toBe(2);
  });
});
