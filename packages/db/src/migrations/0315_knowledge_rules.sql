-- packages/db/src/migrations/0315_knowledge_rules.sql
--
-- myrmidon(1.6.6 KNOWLEDGE-2.0 K-3, §3.1 `rules` + §6 K-3): one carrier of
-- rules, one place where the approver is decided.
--
--   1. the caste directory gains `sensitive`: a sensitive caste's rules are the
--      owner's to approve, every other caste's are the board operator's (the
--      owner's matrix of 29.09 — "разработка — оператор доски (ADM), площадки и
--      SMM — Alex"). The flag is directory data, the *rule* is in the code
--      (`knowledge/rules.ts`), so nobody types `approver_kind` by hand;
--   2. a rule's castes live on the item (`roles`) — the port of the wiki
--      model's `roles` — and the delivery resolver reads exactly this column;
--   3. N-4: the legacy wiki regulations move into `knowledge_items` as
--      `kind=rule`: text, history, statuses and the delivered revision intact.
--      The slug stays the page key, so every reference to the old wiki page
--      resolves to the same page (`wikiPageId = slug`).
--
-- Additive and idempotent: the (nest_id, slug) pair guards (3), so re-running
-- the migration — or running it on a database that never had a wiki page —
-- moves nothing and changes nothing.

ALTER TABLE "agent_castes" ADD COLUMN IF NOT EXISTS "sensitive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "agent_castes" SET "sensitive" = true WHERE "key" = 'cmo' AND "sensitive" = false;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN IF NOT EXISTS "roles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_roles_idx" ON "knowledge_items" USING gin ("roles");--> statement-breakpoint
INSERT INTO "knowledge_items" (
  "company_id", "nest_id", "kind", "slug", "title", "summary", "status", "folder_path",
  "tags", "roles", "approval_required", "approver_kind", "current_revision_number",
  "created_at", "updated_at"
)
SELECT
  w."company_id", w."company_id", 'rule', w."slug", w."title", NULL, 'draft',
  COALESCE(NULLIF(regexp_replace(w."slug", '/[^/]*$', ''), w."slug"), ''),
  '[]'::jsonb, w."roles", true,
  CASE WHEN EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(w."roles") AS role_key
    JOIN "agent_castes" c
      ON c."company_id" = w."company_id" AND c."key" = role_key AND c."sensitive"
    WHERE role_key <> '*'
  ) THEN 'owner' ELSE 'operator' END,
  0, w."created_at", w."updated_at"
FROM "myrmidon_wiki_regulations" w
WHERE NOT EXISTS (
  SELECT 1 FROM "knowledge_items" k WHERE k."nest_id" = w."company_id" AND k."slug" = w."slug"
);--> statement-breakpoint
INSERT INTO "knowledge_revisions" (
  "company_id", "nest_id", "item_id", "revision_number", "status", "content",
  "change_summary", "created_by_agent_id", "created_by_user_id", "created_at"
)
SELECT
  k."company_id", k."nest_id", k."id", rev."revision_number", rev."status", rev."content",
  rev."change_summary", rev."created_by_agent_id", rev."created_by_user_id", rev."created_at"
FROM "myrmidon_wiki_regulations" w
JOIN "knowledge_items" k
  ON k."nest_id" = w."company_id" AND k."slug" = w."slug" AND k."kind" = 'rule'
CROSS JOIN LATERAL (
  SELECT
    (entry ->> 'revisionNumber')::integer AS "revision_number",
    CASE WHEN entry ->> 'status' = 'approved' THEN 'approved' ELSE 'draft' END AS "status",
    COALESCE(entry ->> 'content', '') AS "content",
    NULLIF(entry ->> 'changeSummary', '') AS "change_summary",
    NULLIF(entry ->> 'createdByAgentId', '') AS "created_by_agent_id",
    NULLIF(entry ->> 'createdByUserId', '') AS "created_by_user_id",
    COALESCE((entry ->> 'createdAt')::timestamptz, w."created_at") AS "created_at"
  FROM jsonb_array_elements(w."revisions") AS entry
  UNION ALL
  -- A page whose history column is empty (or not an array) still has text: the
  -- mirrored newest revision becomes revision 1.
  SELECT 1, w."status", w."content", NULL, NULL, NULL, w."created_at"
  WHERE jsonb_typeof(w."revisions") IS DISTINCT FROM 'array' OR jsonb_array_length(w."revisions") = 0
) rev
WHERE NOT EXISTS (
  SELECT 1 FROM "knowledge_revisions" r
  WHERE r."item_id" = k."id" AND r."revision_number" = rev."revision_number"
);--> statement-breakpoint
UPDATE "knowledge_items" k
SET
  "current_revision_number" = agg."max_revision",
  "delivered_revision_id" = (
    SELECT r."id" FROM "knowledge_revisions" r
    WHERE r."item_id" = k."id" AND r."status" = 'approved'
    ORDER BY r."revision_number" DESC LIMIT 1
  ),
  "status" = CASE WHEN agg."approved_count" > 0 THEN 'published' ELSE 'draft' END,
  "updated_at" = now()
FROM (
  SELECT "item_id",
         MAX("revision_number") AS "max_revision",
         COUNT(*) FILTER (WHERE "status" = 'approved') AS "approved_count"
  FROM "knowledge_revisions"
  GROUP BY "item_id"
) agg
WHERE agg."item_id" = k."id"
  AND k."kind" = 'rule'
  AND EXISTS (
    SELECT 1 FROM "myrmidon_wiki_regulations" w
    WHERE w."company_id" = k."nest_id" AND w."slug" = k."slug"
  );--> statement-breakpoint
INSERT INTO "knowledge_sources" ("company_id", "nest_id", "revision_id", "kind", "ref", "note")
SELECT
  r."company_id", r."nest_id", r."id", 'document',
  'myrmidon_wiki_regulations:' || w."id"::text,
  'legacy wiki regulation moved into the knowledge module by K-3 (N-4)'
FROM "knowledge_revisions" r
JOIN "knowledge_items" k ON k."id" = r."item_id" AND k."kind" = 'rule'
JOIN "myrmidon_wiki_regulations" w ON w."company_id" = k."nest_id" AND w."slug" = k."slug"
ON CONFLICT DO NOTHING;