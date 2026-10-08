-- myrmidon(PERF-DIET-P): the text-search path already carries pg_trgm GIN
-- indexes on the plain columns (vendor migrations 0051 and 0079: issues(title,
-- description, identifier), issue_comments(body), documents(title,
-- latest_body)), and the task-search statement matches those columns bare, so
-- it uses them. Company search has a second family of predicates that wraps the
-- column in coalesce: `coalesce(title, '') ILIKE '%…%'` over documents and
-- `coalesce(identifier, '') ILIKE '%…%'` over issues
-- (server/src/services/company-search.ts, company-artifacts.ts). A boolean
-- expression is not index-servable for the column index, so the planner
-- sequentially scans documents — the table whose latest_body column is the
-- heavy one — and issues. Measured on embedded PostgreSQL with 20 000 documents
-- and 50 000 issues, selective term: sequential scan 13.3 ms / 37.3 ms, bitmap
-- index scan on the expression index below 0.6 ms / 2.6 ms.
--
-- Both indexes are expression indexes on the exact emitted shape
-- `(coalesce(col, ''))` with the gin_trgm_ops operator class, so no query text
-- changes and the search semantics stay identical: a NULL column and the empty
-- string are both non-matching for the same row, and the predicates sit in
-- positive OR/AND chains.
--
-- CREATE INDEX IF NOT EXISTS, not CONCURRENTLY: the migration runner wraps every
-- file in a transaction (packages/db/src/client.ts), and documents/issues are in
-- the medium bucket of packages/db/src/table-size-estimates.ts. The one-time build
-- is the accepted cost; an operator who wants to build it on a live board
-- without that lock runs `CREATE INDEX CONCURRENTLY IF NOT EXISTS` with the same
-- definition before deploying — the IF NOT EXISTS statements below then skip the
-- already-built indexes, so the migration stays a no-op on re-apply.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_coalesced_title_search_idx" ON "documents" USING gin ((coalesce("title", '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_coalesced_identifier_search_idx" ON "issues" USING gin ((coalesce("identifier", '')) gin_trgm_ops);