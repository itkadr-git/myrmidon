-- myrmidon(CORPUS-A): pgvector-dependent corpus objects — the vector
-- extension, the corpus_chunks.embedding vector(1024) column and its HNSW
-- index. Split out of 0309_corpus_module.sql (OPE-6233): hosted CI runners
-- start embedded PostgreSQL without pgvector, so the base corpus tables must
-- apply cleanly there while vector search activates only where pgvector is
-- installed (production runs the pgvector-enabled PostgreSQL 18 image).
--
-- Guarded availability check: on a cluster without pgvector this migration
-- SKIPS its vector objects (journal entry is still recorded, the database is
-- left in the corpus "pending pgvector" state — FTS/trigram search works,
-- semantic search needs pgvector). On a pgvector-enabled cluster the objects
-- are created; the corpus module surfaces an explicit error if semantic
-- search is used while the embedding column is missing. To activate vector
-- search later, install pgvector and apply the ALTER/CREATE INDEX statements
-- below (all IF NOT EXISTS / idempotent).
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
		RAISE NOTICE 'corpus: pgvector extension is not available on this cluster; skipping corpus_chunks.embedding vector column and HNSW index (semantic search stays disabled until pgvector is installed)';
		RETURN;
	END IF;
	CREATE EXTENSION IF NOT EXISTS vector;
	ALTER TABLE "corpus_chunks" ADD COLUMN IF NOT EXISTS "embedding" vector(1024);
	CREATE INDEX IF NOT EXISTS "corpus_chunks_embedding_hnsw_idx" ON "corpus_chunks" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
END $$;
