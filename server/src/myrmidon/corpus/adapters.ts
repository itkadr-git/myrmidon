import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, count, eq, sql as drizzleSql } from "drizzle-orm";
import { companySecrets, corpusChunks, corpusDatasets, corpusDocuments, corpusParseJobs, type Db } from "@paperclipai/db";
import { createHttpDocumentParser, createPostgresSearchIndex, LocalBlobStore, PostgresCorpusStore, PostgresWorkQueue } from "@paperclipai/corpus";
import type { SqlExecutor } from "@paperclipai/corpus";
import type { CorpusSettings } from "@paperclipai/shared";
import type { CorpusPortContext } from "./ports.js";
import type { CorpusMcpPortProvider } from "./contract.js";
import type { CorpusDocumentRecord, CorpusPorts, CorpusJobRecord, CorpusDatasetRecord } from "./ports.js";
import { secretService } from "../../services/secrets.js";
import type { Config } from "../../config.js";

function countValue(row: { value?: number | bigint | string } | undefined): number { return Number(row?.value ?? 0); }

export function createCorpusPorts(db: Db, context: CorpusPortContext, config: Config): CorpusPorts {
  const { settings } = context;
  const store = new PostgresCorpusStore(db as never);
  const queue = new PostgresWorkQueue(db as never);
  const blobs = new LocalBlobStore(path.join(config.storageLocalDiskBaseDir, "corpus"));
  const embedder = async (companyId: string, baseUrl: string | null, model: string, dimensions: number, input: string[]): Promise<number[][]> => {
    const secretRow = await db.select().from(companySecrets).where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.scope, "company"), eq(companySecrets.name, "MYRMIDON_CORPUS_EMBEDDER_API_KEY"), eq(companySecrets.status, "active"))).then((rows) => rows[0] ?? null);
    const apiKey = secretRow ? await secretService(db).resolveSecretValue(companyId, secretRow.id, "latest", { accessContext: { consumerType: "system", consumerId: "myrmidon-corpus" } }) : undefined;
    const endpoint = baseUrl ?? context.env.MYRMIDON_LLM_GATEWAY_BASE_URL ?? "http://127.0.0.1:3000/v1";
    const response = await fetch(`${endpoint.replace(/\/+$/, "")}/embeddings`, { method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: "Bearer " + apiKey } : {}) }, body: JSON.stringify({ model, input, dimensions }) });
    if (!response.ok) throw new Error(`corpus embeddings request failed (${response.status})`);
    const result = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
    const vectorResults = result.data?.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((item) => item.embedding);
    if (!vectorResults || vectorResults.length !== input.length || vectorResults.some((v) => !v || v.length !== dimensions)) throw new Error("corpus embeddings response has invalid dimensions");
    return vectorResults as number[][];
  };
  const searchIndex = createPostgresSearchIndex({ sql: {
    async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<Row[]> {
      const params = [...values]; const parts = text.split(/\$(\d+)/g);
      let query = drizzleSql.empty();
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) query.append(drizzleSql.raw(parts[i]!));
        else query.append(drizzleSql`${params[Number(parts[i]) - 1]}`);
      }
      return db.execute(query) as unknown as Promise<Row[]>;
    },
    async withTransaction<T>(run: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => run({
        async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<Row[]> {
          const params = [...values]; const parts = text.split(/\$(\d+)/g);
          let query = drizzleSql.empty();
          for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 0) query.append(drizzleSql.raw(parts[i]!));
            else query.append(drizzleSql`${params[Number(parts[i]) - 1]}`);
          }
          return tx.execute(query) as unknown as Promise<Row[]>;
        },
        async withTransaction<Tx>(nested: (tx: SqlExecutor) => Promise<Tx>) { return nested(this); },
      }));
    },
  } });
  const index = {
    async indexDocument(input: { companyId: string; datasetId: string; documentId: string; chunks: Array<{ text: string; index: number; metadata?: Record<string, unknown> }>; embedderModel: string; embedderDimensions: number; embedderBaseUrl: string | null }) {
      const vectors = await embedder(input.companyId, input.embedderBaseUrl, input.embedderModel, input.embedderDimensions, input.chunks.map((c) => c.text));
      await store.replaceDocumentChunks({ companyId: input.companyId, documentId: input.documentId, chunks: input.chunks.map((c, i) => ({ chunkIndex: c.index, content: c.text, embedding: vectors[i]!, metadata: c.metadata })) });
      return input.chunks.length;
    },
    async deleteDocument(companyId: string, documentId: string) { await store.replaceDocumentChunks({ companyId, documentId, chunks: [] }); },
    async search(input: { companyId: string; datasetId: string; query: string; limit: number; mode: "hybrid" | "vector" | "fulltext"; embedderModel: string; embedderDimensions: number; embedderBaseUrl: string | null }) {
      const vector = input.mode === "fulltext" ? undefined : (await embedder(input.companyId, input.embedderBaseUrl, input.embedderModel, input.embedderDimensions, [input.query]))[0];
      const hits = await searchIndex.search({ companyId: input.companyId, datasetId: input.datasetId, text: input.mode === "vector" ? "" : input.query, embedding: vector, limit: input.limit });
      return hits.map((hit) => ({ chunkId: hit.chunkId, documentId: hit.documentId, datasetId: hit.datasetId, score: hit.score, text: hit.content, metadata: hit.metadata }));
    },
    async countChunks(companyId: string, datasetId?: string) {
      const rows = await db.select({ value: count() }).from(corpusChunks).innerJoin(corpusDocuments, eq(corpusChunks.documentId, corpusDocuments.id)).where(datasetId ? and(eq(corpusChunks.companyId, companyId), eq(corpusDocuments.companyId, companyId), eq(corpusDocuments.datasetId, datasetId)) : and(eq(corpusChunks.companyId, companyId), eq(corpusDocuments.companyId, companyId)));
      return countValue(rows[0]);
    },
  };
  const documentRecord = async (companyId: string, row: Awaited<ReturnType<typeof store.getDocument>>): Promise<CorpusDocumentRecord | null> => {
    if (!row) return null;
    const [jobs, chunks] = await Promise.all([
      queue.listJobsForDocument(companyId, row.id), store.listDocumentChunks(companyId, row.id),
    ]);
    return { id: row.id, companyId, datasetId: row.datasetId, filename: row.title, mimeType: row.contentType, byteSize: row.byteSize ?? 0, blobRef: row.blobKey ?? "", status: row.status === "embedding" ? "parsing" : row.status, chunkCount: chunks.length, error: row.parseError, attempts: jobs[0]?.attempts ?? 0, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), parsedAt: row.parsedAt?.toISOString() ?? null };
  };
  const datasetRecord = async (companyId: string, row: Awaited<ReturnType<typeof store.getDataset>>): Promise<CorpusDatasetRecord | null> => {
    if (!row) return null;
    const [docs, stats, chunks] = await Promise.all([
      store.listDocuments({ companyId, datasetId: row.id }),
      db.select({ status: corpusDocuments.status, value: count() }).from(corpusDocuments).where(and(eq(corpusDocuments.companyId, companyId), eq(corpusDocuments.datasetId, row.id))).groupBy(corpusDocuments.status),
      db.select({ value: count() }).from(corpusChunks).innerJoin(corpusDocuments, eq(corpusChunks.documentId, corpusDocuments.id)).where(and(eq(corpusChunks.companyId, companyId), eq(corpusDocuments.companyId, companyId), eq(corpusDocuments.datasetId, row.id))),
    ]);
    return { id: row.id, companyId, name: row.name, description: row.description, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), documentCount: docs.length, readyCount: countValue(stats.find((x) => x.status === "ready")), failedCount: countValue(stats.find((x) => x.status === "failed")), chunkCount: countValue(chunks[0]) };
  };
  const getDocument = async (companyId: string, id: string) => documentRecord(companyId, await store.getDocument(companyId, id));
  const getDataset = async (companyId: string, id: string) => datasetRecord(companyId, await store.getDataset(companyId, id));
  const jobRecord = async (companyId: string, row: Awaited<ReturnType<typeof queue.getJob>>): Promise<CorpusJobRecord | null> => {
    if (!row) return null;
    const doc = await getDocument(companyId, row.documentId);
    return { id: row.id, companyId, datasetId: doc?.datasetId ?? "", documentId: row.documentId, state: row.status === "pending" ? "queued" : row.status, attempts: row.attempts, maxAttempts: row.maxAttempts, lastError: row.lastError, createdAt: row.createdAt.toISOString(), updatedAt: row.createdAt.toISOString() };
  };
  return {
    store: {
      async listDatasets(companyId) { const rows = await store.listDatasets(companyId); const mapped: CorpusDatasetRecord[] = []; for (const item of rows) { const record = await datasetRecord(companyId, item); if (record) mapped.push(record); } return mapped; },
      getDataset,
      async createDataset(input) { return (await datasetRecord(input.companyId, await store.createDataset({ companyId: input.companyId, name: input.name, description: input.description })))!; },
      async updateDataset(companyId, id, patch) {
        const row = await db.update(corpusDatasets).set({ ...patch, updatedAt: new Date() }).where(and(eq(corpusDatasets.companyId, companyId), eq(corpusDatasets.id, id))).returning().then((rows) => rows[0] ?? null);
        return row ? await datasetRecord(companyId, await store.getDataset(companyId, row.id)) : null;
      },
      async deleteDataset(companyId, id) {
        const docs = await store.listDocuments({ companyId, datasetId: id });
        for (const doc of docs) { const d = await getDocument(companyId, doc.id); if (d) await blobs.delete(d.blobRef); }
        const deleted = await db.delete(corpusDatasets).where(and(eq(corpusDatasets.companyId, companyId), eq(corpusDatasets.id, id))).returning({ id: corpusDatasets.id });
        return deleted.length > 0;
      },
      async listDocuments(companyId, datasetId, options) { const rows = await store.listDocuments({ companyId, datasetId: datasetId!, limit: options?.limit, offset: options?.offset }); const mapped: CorpusDocumentRecord[] = []; for (const item of rows) { const record = await documentRecord(companyId, item); if (record) mapped.push(record); } return mapped; },
      getDocument,
      async createDocument(input) {
        const row = await store.createDocument({ companyId: input.companyId, datasetId: input.datasetId, title: input.filename, blobKey: input.blobRef, contentType: input.mimeType, byteSize: input.byteSize });
        return (await documentRecord(input.companyId, row))!;
      },
      async updateDocument(companyId, id, patch) {
        const row = await store.getDocument(companyId, id); if (!row) return null;
        if (patch.status && patch.status !== row.status) {
          // The store enforces the chain queued -> parsing -> embedding -> ready; the worker
          // port speaks parsing -> ready, so the embedding step is passed through here.
          if (patch.status === "ready" && row.status === "parsing") await store.updateDocumentStatus(companyId, id, "embedding", { parserVersion: "v1" });
          await store.updateDocumentStatus(companyId, id, patch.status, { parseError: patch.error, parserVersion: "v1" });
        }
        const updated = await db.update(corpusDocuments).set({ ...(patch.blobRef !== undefined ? { blobKey: patch.blobRef } : {}), ...(patch.status ? { status: patch.status === "parsing" ? "parsing" : patch.status } : {}), ...(patch.error !== undefined ? { parseError: patch.error } : {}), ...(patch.parsedAt ? { parsedAt: new Date(patch.parsedAt) } : {}) }).where(and(eq(corpusDocuments.companyId, companyId), eq(corpusDocuments.id, id))).returning({ id: corpusDocuments.id });
        return updated.length ? getDocument(companyId, id) : null;
      },
      async deleteDocument(companyId, id) { const d = await getDocument(companyId, id); if (!d) return false; await store.deleteDocument(companyId, id); await blobs.delete(d.blobRef); return true; },
      async countDocuments(companyId, datasetId) { return (await store.listDocuments({ companyId, datasetId })).length; },
      async getJob(companyId, jobId) { return jobRecord(companyId, await queue.getJob(companyId, jobId)); },
      async counters(companyId: string) { const datasets = await store.listDatasets(companyId); const docs = await store.listDocuments({ companyId }); const bytes = docs.reduce((sum, doc) => sum + (doc.byteSize ?? 0), 0); return { datasets: datasets.length, documents: docs.length, ready: docs.filter((d) => d.status === "ready").length, pending: docs.filter((d) => d.status === "queued" || d.status === "parsing").length, failed: docs.filter((d) => d.status === "failed").length, chunks: countValue((await db.select({ value: count() }).from(corpusChunks).where(eq(corpusChunks.companyId, companyId)))[0]), bytes }; },
    },
    blobs: {
      async put(input) { const ref = `${input.companyId}/${input.documentId}/${randomUUID()}`; const result = await blobs.put(ref, input.bytes); return { ref: result.key, byteSize: result.byteSize }; },
      async get(ref) { const value = await blobs.get(ref); if (!value) throw new Error("corpus blob not found"); return value; },
      async delete(ref) { await blobs.delete(ref); },
    },
    queue: {
      async enqueue(input) { const row = await queue.enqueue({ companyId: input.companyId, documentId: input.documentId, parserVersion: "v1", maxAttempts: input.maxAttempts }); return (await jobRecord(input.companyId, row))!; },
      async claim({ limit }) {
        if (limit <= 0) return [];
        const claimed = await db.execute(drizzleSql`
          update corpus_parse_jobs
          set status = 'running', attempts = attempts + 1, started_at = now()
          where id in (
            with eligible as materialized (
              select id, company_id, next_attempt_at, created_at
              from corpus_parse_jobs
              where status = 'pending' and next_attempt_at <= now()
              order by next_attempt_at asc, created_at asc
              for update skip locked
            ),
            ranked as (
              select id, next_attempt_at, created_at,
                row_number() over (partition by company_id order by next_attempt_at asc, created_at asc) as company_rank
              from eligible
            ),
            selected as (
              select id from ranked
              order by company_rank asc, next_attempt_at asc, created_at asc
              limit ${limit}
            )
            select id from selected
          )
          returning id, company_id, document_id, parser_version, status, attempts, max_attempts, last_error, next_attempt_at, started_at, finished_at, created_at
        `) as unknown as Array<{
          id: string;
          company_id: string;
          document_id: string;
          parser_version: string;
          status: string;
          attempts: number;
          max_attempts: number;
          last_error: string | null;
          next_attempt_at: Date;
          started_at: Date | null;
          finished_at: Date | null;
          created_at: Date;
        }>;
        const result: CorpusJobRecord[] = [];
        for (const row of claimed) {
          // Raw SQL returns PostgreSQL column names; preserve tenant scope for lookup.
          const mapped = await jobRecord(row.company_id, await queue.getJob(row.company_id, row.id));
          if (mapped) result.push(mapped);
        }
        return result;
      },
      async complete(companyId, id) { await queue.complete(companyId, id); },
      async fail(companyId, id, reason) { const row = await queue.fail(companyId, id, reason); return jobRecord(companyId, row); },
    },
    parser: {
      async parse(input) {
        const client = createHttpDocumentParser({ baseUrl: input.baseUrl, timeoutMs: input.timeoutMs });
        const result = await client.parse({ sourceUri: null, content: input.bytes, contentType: input.mimeType, title: input.filename, parserVersion: "v1" });
        return { text: result.chunks.map((chunk) => chunk.content).join("\n"), chunks: result.chunks.map((chunk) => ({ text: chunk.content, index: chunk.chunkIndex, metadata: chunk.metadata })) };
      },
    },
    index,
  };
}

export function createCorpusMcpProvider(readSettings: (companyId: string) => Promise<CorpusSettings>, createPorts: (context: CorpusPortContext) => CorpusPorts): CorpusMcpPortProvider {
  return async (companyId) => {
    const resolve = async () => {
      const settings = await readSettings(companyId);
      if (!settings.enabled) return null;
      const ports = createPorts({ env: process.env, settings });
      return { settings, ports };
    };
    return {
      async search(request) {
        const current = await resolve();
        if (!current) throw new Error("corpus_disabled");
        const { settings, ports } = current;
        const datasets = await ports.store.listDatasets(companyId);
        const allowed = new Set(datasets.map((d) => d.id));
        const ids = (request.datasets.length ? request.datasets : datasets.map((d) => d.id)).filter((id) => allowed.has(id));
        const groups = await Promise.all(ids.map((datasetId) => ports.index.search({ companyId, datasetId, query: request.query, limit: request.topK, mode: "hybrid", embedderModel: settings.embedderModel, embedderDimensions: settings.embedderDimensions, embedderBaseUrl: settings.embedderBaseUrl })));
        return { query: request.query, datasets: ids, topK: request.topK, hits: groups.flat().filter((hit) => request.minScore === null || hit.score >= request.minScore).slice(0, request.topK).map((hit) => ({ chunkId: hit.chunkId, document: { id: hit.documentId, name: hit.documentId, datasetId: hit.datasetId, datasetName: datasets.find((d) => d.id === hit.datasetId)?.name ?? "", url: null }, ordinal: 0, text: hit.text, score: hit.score })) };
      },
      async getDocument({ documentId, includeText }) {
        const current = await resolve();
        if (!current) throw new Error("corpus_disabled");
        const { ports } = current;
        const document = await ports.store.getDocument(companyId, documentId); if (!document) throw new Error("document not found");
        const dataset = await ports.store.getDataset(companyId, document.datasetId);
        const chunks = includeText ? await (async () => { const rows = await ports.store.getDocument(companyId, documentId); return rows ? Buffer.from(await ports.blobs.get(rows.blobRef)).toString("utf8") : null; })() : null;
        return { document: { id: document.id, name: document.filename, datasetId: document.datasetId, datasetName: dataset?.name ?? "", url: null, status: document.status, sizeBytes: document.byteSize, chunks: document.chunkCount, createdAt: document.createdAt, error: document.error }, text: chunks };
      },
      async listDatasets() {
        const current = await resolve();
        if (!current) throw new Error("corpus_disabled");
        const datasets = await current.ports.store.listDatasets(companyId);
        return datasets.map((d) => ({ id: d.id, name: d.name, documents: d.documentCount, readyDocuments: d.readyCount, chunks: d.chunkCount, updatedAt: d.updatedAt }));
      },
      async listDocuments({ datasetId, offset, limit }) {
        const current = await resolve();
        if (!current) throw new Error("corpus_disabled");
        const { ports } = current;
        const datasets = await ports.store.listDatasets(companyId);
        const allowed = new Set(datasets.map((d) => d.id));
        const rows = datasetId ? (allowed.has(datasetId) ? await ports.store.listDocuments(companyId, datasetId, { offset, limit }) : []) : (await Promise.all(datasets.map((d) => ports.store.listDocuments(companyId, d.id)))).flat().slice(offset, offset + limit);
        return { dataset: datasetId ? (() => { const d = datasets.find((item) => item.id === datasetId); return d ? { id: d.id, name: d.name } : null; })() : null, documents: rows.map((d) => ({ id: d.id, name: d.filename, datasetId: d.datasetId, status: d.status, chunks: d.chunkCount, createdAt: d.createdAt })), offset, limit };
      },
    };
  };
}
