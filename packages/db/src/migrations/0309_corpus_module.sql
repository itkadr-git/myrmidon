-- myrmidon(CORPUS-A): corpus knowledge module tables — datasets, documents,
-- chunks (pgvector HNSW + generated tsvector FTS + trigram GIN), the parse job
-- queue (idempotent on document+parser version) and per-company settings.
-- Additive only: new tables and indexes, no changes to existing tables.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "corpus_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"embedding_model" text DEFAULT 'dashscope-text-embedding-v4' NOT NULL,
	"embedding_dimensions" integer DEFAULT 1024 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corpus_datasets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "corpus_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"title" text NOT NULL,
	"source_uri" text,
	"blob_key" text,
	"content_type" text,
	"byte_size" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"parse_error" text,
	"parser_version" text,
	"content_hash" text,
	"parsed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corpus_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "corpus_documents_dataset_id_corpus_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."corpus_datasets"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "corpus_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"token_count" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fts" tsvector GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corpus_chunks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "corpus_chunks_document_id_corpus_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."corpus_documents"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "corpus_parse_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"parser_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corpus_parse_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "corpus_parse_jobs_document_id_corpus_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."corpus_documents"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "corpus_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"default_embedder_base_url" text,
	"default_embedding_model" text DEFAULT 'dashscope-text-embedding-v4' NOT NULL,
	"default_parser_url" text,
	"default_parser_version" text DEFAULT 'v1' NOT NULL,
	"blob_store_root" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corpus_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "corpus_datasets_company_name_uq" ON "corpus_datasets" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corpus_datasets_company_idx" ON "corpus_datasets" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corpus_documents_dataset_status_idx" ON "corpus_documents" USING btree ("dataset_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corpus_documents_company_status_idx" ON "corpus_documents" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corpus_chunks_document_idx" ON "corpus_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corpus_chunks_company_document_idx" ON "corpus_chunks" USING btree ("company_id","document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corpus_chunks_content_trgm_idx" ON "corpus_chunks" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corpus_chunks_fts_idx" ON "corpus_chunks" USING gin ("fts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corpus_chunks_embedding_hnsw_idx" ON "corpus_chunks" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "corpus_parse_jobs_document_parser_uq" ON "corpus_parse_jobs" USING btree ("document_id","parser_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corpus_parse_jobs_claim_idx" ON "corpus_parse_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corpus_parse_jobs_company_idx" ON "corpus_parse_jobs" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "corpus_settings_company_uq" ON "corpus_settings" USING btree ("company_id");
