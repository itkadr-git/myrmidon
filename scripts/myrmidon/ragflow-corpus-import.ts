import { pathToFileURL } from "node:url";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  closeRegisteredClients,
  corpusChunks,
  corpusDatasets,
  corpusDocuments,
  createDb,
} from "@myrmidon/db";
import {
  createRagflowSource,
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_EMBEDDING_CONCURRENCY,
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  dryRunRagflowImport,
  importRagflowCorpus,
  type CorpusImportTarget,
} from "@myrmidon/corpus";

function createDatabaseTarget(db: ReturnType<typeof createDb>): CorpusImportTarget {
  return {
    async upsertDataset(dataset) {
      await db.insert(corpusDatasets).values({
        id: dataset.id,
        companyId: dataset.companyId,
        name: dataset.name,
        description: dataset.description,
        embeddingModel: dataset.embeddingModel,
        embeddingDimensions: dataset.embeddingDimensions,
      }).onConflictDoUpdate({
        target: corpusDatasets.id,
        set: {
          name: dataset.name,
          description: dataset.description,
          embeddingModel: dataset.embeddingModel,
          embeddingDimensions: dataset.embeddingDimensions,
          updatedAt: new Date(),
        },
      });
    },
    async upsertDocument(document) {
      await db.insert(corpusDocuments).values({
        id: document.id,
        companyId: document.companyId,
        datasetId: document.datasetId,
        title: document.title,
        sourceUri: document.sourceUri,
        contentType: document.contentType,
        byteSize: document.byteSize,
        contentHash: document.contentHash,
        metadata: document.metadata,
        status: "embedding",
        parserVersion: "ragflow-import-v1",
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: corpusDocuments.id,
        set: {
          datasetId: document.datasetId,
          title: document.title,
          sourceUri: document.sourceUri,
          contentType: document.contentType,
          byteSize: document.byteSize,
          contentHash: document.contentHash,
          metadata: document.metadata,
          status: "embedding",
          parserVersion: "ragflow-import-v1",
          updatedAt: new Date(),
        },
      });
    },
    async getChunkStates(companyId, ids) {
      if (ids.length === 0) return new Map();
      const rows = await db.select({ id: corpusChunks.id, content: corpusChunks.content, embedding: corpusChunks.embedding, metadata: corpusChunks.metadata })
        .from(corpusChunks)
        .innerJoin(corpusDocuments, eq(corpusChunks.documentId, corpusDocuments.id))
        .where(and(eq(corpusChunks.companyId, companyId), eq(corpusDocuments.companyId, companyId), inArray(corpusChunks.id, ids)));
      return new Map(rows.map((row) => [row.id, {
        content: row.content,
        embedding: Array.isArray(row.embedding) ? row.embedding : null,
        embeddingModel: typeof row.metadata.embeddingModel === "string" ? row.metadata.embeddingModel : null,
        embeddingDimensions: typeof row.metadata.embeddingDimensions === "number" ? row.metadata.embeddingDimensions : null,
        embeddingContentHash: typeof row.metadata.embeddingContentHash === "string" ? row.metadata.embeddingContentHash : null,
      }]));
    },
    async upsertChunks(chunks) {
      if (chunks.length === 0) return;
      await db.insert(corpusChunks).values(chunks.map((chunk) => ({
        id: chunk.id,
        companyId: chunk.companyId,
        documentId: chunk.documentId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        embedding: chunk.embedding,
        metadata: chunk.metadata,
      }))).onConflictDoUpdate({
        target: corpusChunks.id,
        set: {
          companyId: sql`excluded.company_id`,
          documentId: sql`excluded.document_id`,
          chunkIndex: sql`excluded.chunk_index`,
          content: sql`excluded.content`,
          embedding: sql`coalesce(excluded.embedding, corpus_chunks.embedding)`,
          metadata: sql`excluded.metadata`,
        },
      });
    },
    async markDocumentReady(companyId, documentId) {
      await db.update(corpusDocuments)
        .set({ status: "ready", parsedAt: new Date(), updatedAt: new Date(), parseError: null })
        .where(and(eq(corpusDocuments.companyId, companyId), eq(corpusDocuments.id, documentId)));
    },
  };
}

async function createLiteLlmEmbedder(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}): Promise<(texts: string[]) => Promise<number[][]>> {
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/embeddings`;
  return async (texts) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ model: options.model, input: texts, dimensions: options.dimensions }),
    });
    if (!response.ok) throw new Error(`LiteLLM embeddings request failed (${response.status})`);
    const result = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
    const rows = result.data?.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (!rows || rows.length !== texts.length || rows.some((row) => !Array.isArray(row.embedding))) {
      throw new Error("LiteLLM returned an invalid embeddings response");
    }
    return rows.map((row) => row.embedding!);
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isHelp = args.includes("--help") || args.includes("-h");

  if (isHelp) {
    process.stdout.write(`RAGFlow-to-Corpus Import CLI

Usage:
  node dist/scripts/ragflow-corpus-import.js [--dry-run]

Options:
  --dry-run   Read-only preflight: report source datasets, documents, chunks, and existing embedding coverage without writing or embedding
  --help, -h  Display this help message

Environment variables (names only):
  RAGFLOW_BASE_URL              RAGFlow instance base URL (required)
  RAGFLOW_API_KEY               RAGFlow API key (required)
  DATABASE_URL                  Target PostgreSQL database URL (required)
  CORPUS_COMPANY_ID             Company ID to import into (required)
  LITELLM_BASE_URL              LiteLLM base URL (required for import, not needed for --dry-run)
  LITELLM_API_KEY               LiteLLM API key (required for import, not needed for --dry-run)
  CORPUS_EMBEDDING_MODEL        Embedding model name (default: ${DEFAULT_EMBEDDING_MODEL})
  CORPUS_EMBEDDING_DIMENSIONS   Embedding dimensions (default: ${DEFAULT_EMBEDDING_DIMENSIONS})
  CORPUS_IMPORT_BATCH_SIZE      Chunk batch size (default: ${DEFAULT_EMBEDDING_BATCH_SIZE})
  CORPUS_IMPORT_CONCURRENCY     Embedding concurrency (default: ${DEFAULT_EMBEDDING_CONCURRENCY})
  CORPUS_CHUNK_COUNT_TOLERANCE  Chunk count tolerance ratio (default: 0.01)
`);
    return;
  }

  const env = process.env;
  const baseRequired = ["RAGFLOW_BASE_URL", "RAGFLOW_API_KEY", "DATABASE_URL", "CORPUS_COMPANY_ID"] as const;
  const required = isDryRun
    ? baseRequired
    : ([...baseRequired, "LITELLM_BASE_URL", "LITELLM_API_KEY"] as const);

  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const dbUrl = env.DATABASE_URL!;
  const db = createDb(dbUrl);
  try {
    const model = env.CORPUS_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    const dimensions = Number(env.CORPUS_EMBEDDING_DIMENSIONS ?? DEFAULT_EMBEDDING_DIMENSIONS);
    if (dimensions !== DEFAULT_EMBEDDING_DIMENSIONS) {
      throw new Error(`Corpus storage requires ${DEFAULT_EMBEDDING_DIMENSIONS}-dimension embeddings`);
    }

    const source = createRagflowSource({ baseUrl: env.RAGFLOW_BASE_URL!, apiKey: env.RAGFLOW_API_KEY! });
    const target = createDatabaseTarget(db);
    const startedAt = Date.now();

    if (isDryRun) {
      const result = await dryRunRagflowImport({
        source,
        target,
        companyId: env.CORPUS_COMPANY_ID!,
        embeddingModel: model,
        embeddingDimensions: dimensions,
        chunkCountTolerance: Number(env.CORPUS_CHUNK_COUNT_TOLERANCE ?? 0.01),
        onProgress(progress) {
          process.stdout.write(`${JSON.stringify({ ...progress, elapsedMs: Date.now() - startedAt })}\n`);
        },
      });
      process.stdout.write(`${JSON.stringify({ mode: "dry-run", ...result, completedAt: new Date().toISOString() })}\n`);
      return;
    }

    const embed = await createLiteLlmEmbedder({
      baseUrl: env.LITELLM_BASE_URL!,
      apiKey: env.LITELLM_API_KEY!,
      model,
      dimensions,
    });

    const summary = await importRagflowCorpus({
      source,
      target,
      embed,
      companyId: env.CORPUS_COMPANY_ID!,
      embeddingModel: model,
      embeddingDimensions: dimensions,
      chunkCountTolerance: Number(env.CORPUS_CHUNK_COUNT_TOLERANCE ?? 0.01),
      embeddingBatchSize: Number(env.CORPUS_IMPORT_BATCH_SIZE ?? DEFAULT_EMBEDDING_BATCH_SIZE),
      embeddingConcurrency: Number(env.CORPUS_IMPORT_CONCURRENCY ?? DEFAULT_EMBEDDING_CONCURRENCY),
      onProgress(progress) {
        process.stdout.write(`${JSON.stringify({ ...progress, elapsedMs: Date.now() - startedAt })}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify({ mode: "import", ...summary, completedAt: new Date().toISOString() })}\n`);
  } finally {
    await closeRegisteredClients(dbUrl);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
