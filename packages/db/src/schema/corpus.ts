// myrmidon(CORPUS-A): corpus knowledge module tables (datasets, documents,
// chunks with FTS, parse job queue, per-company settings). pgvector-dependent
// objects (the embedding vector(1024) column and its HNSW index) are applied
// by migration 0310 — not 0309 — so embedded-Postgres CI runners without
// pgvector can boot (OPE-6233).
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Dialect-only column types. They appear ONLY here and in the store layer of
// @paperclipai/corpus; domain and ports never see them.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

const vector1024 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1024)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    const trimmed = value.trim().replace(/^\[/, "").replace(/\]$/, "");
    if (trimmed.length === 0) return [];
    return trimmed.split(",").map((component) => Number.parseFloat(component));
  },
});

export const corpusDatasets = pgTable(
  "corpus_datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    embeddingModel: text("embedding_model").notNull().default("dashscope-text-embedding-v4"),
    embeddingDimensions: integer("embedding_dimensions").notNull().default(1024),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameUq: uniqueIndex("corpus_datasets_company_name_uq").on(table.companyId, table.name),
    companyIdx: index("corpus_datasets_company_idx").on(table.companyId),
  }),
);

export const corpusDocuments = pgTable(
  "corpus_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => corpusDatasets.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sourceUri: text("source_uri"),
    blobKey: text("blob_key"),
    contentType: text("content_type"),
    byteSize: integer("byte_size"),
    status: text("status").notNull().default("queued"),
    parseError: text("parse_error"),
    parserVersion: text("parser_version"),
    contentHash: text("content_hash"),
    parsedAt: timestamp("parsed_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    datasetStatusIdx: index("corpus_documents_dataset_status_idx").on(table.datasetId, table.status),
    companyStatusIdx: index("corpus_documents_company_status_idx").on(table.companyId, table.status),
  }),
);

export const corpusChunks = pgTable(
  "corpus_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => corpusDocuments.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector1024("embedding"),
    tokenCount: integer("token_count"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    // Maintained by the 0309 migration DDL:
    // GENERATED ALWAYS AS (to_tsvector('english', content)) STORED.
    fts: tsvector("fts"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentIdx: index("corpus_chunks_document_idx").on(table.documentId),
    companyDocumentIdx: index("corpus_chunks_company_document_idx").on(table.companyId, table.documentId),
    contentTrgmIdx: index("corpus_chunks_content_trgm_idx").using("gin", table.content.op("gin_trgm_ops")),
  }),
);

export const corpusParseJobs = pgTable(
  "corpus_parse_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => corpusDocuments.id, { onDelete: "cascade" }),
    parserVersion: text("parser_version").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentParserUq: uniqueIndex("corpus_parse_jobs_document_parser_uq").on(
      table.documentId,
      table.parserVersion,
    ),
    claimIdx: index("corpus_parse_jobs_claim_idx").on(table.status, table.nextAttemptAt),
    companyIdx: index("corpus_parse_jobs_company_idx").on(table.companyId),
  }),
);

export const corpusSettings = pgTable(
  "corpus_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    defaultEmbedderBaseUrl: text("default_embedder_base_url"),
    defaultEmbeddingModel: text("default_embedding_model")
      .notNull()
      .default("dashscope-text-embedding-v4"),
    defaultParserUrl: text("default_parser_url"),
    defaultParserVersion: text("default_parser_version").notNull().default("v1"),
    blobStoreRoot: text("blob_store_root"),
    extra: jsonb("extra").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("corpus_settings_company_uq").on(table.companyId),
  }),
);
