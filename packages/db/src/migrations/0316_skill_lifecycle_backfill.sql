-- myrmidon(1.6.6 KNOWLEDGE-2.0 K-7): one-time backfill of the skill lifecycle.
--
-- Architecture doc §5.5: every existing company skill moves to `verified` with
-- `reason: legacy-2026-10` so the gates close over all of them without stopping
-- delivery (a skill with no row is legacy/unmanaged and delivered to everyone;
-- a `candidate` row would withhold it from non-pilot agents and stop the
-- pipeline). Delivery of a backfilled skill is unchanged: the verified pointer
-- is the skill's own current revision, the same content the unmanaged path
-- delivered before.
--
-- Then, per §5.5, a skill card (`knowledge_items.kind = 'skill_card'`) is
-- created for every skill from its catalog metadata — name, description,
-- categories, source — published (delivered pointer = revision 1), mirrored
-- into `knowledge_search` so search == delivery, and given provenance rows
-- pointing at the skill itself.
--
-- Purely additive data: no table is created or altered, no column is touched,
-- existing lifecycle rows and existing knowledge items are never overwritten,
-- and every statement is guarded so a replay is a no-op.

--> statement-breakpoint
-- One lifecycle row per skill that has none: `verified` at the skill's current
-- revision. `ON CONFLICT DO NOTHING RETURNING` yields exactly the rows created
-- by THIS run, so the event insert below never duplicates history on a replay.
WITH created AS (
  INSERT INTO "company_skill_lifecycle" (
    "company_id", "skill_id", "state", "verified_version_id", "previous_verified_version_id",
    "approved_by", "approved_at", "reason", "created_at", "updated_at"
  )
  SELECT
    s."company_id", s."id", 'verified', s."current_version_id", NULL,
    'system:skill-lifecycle-backfill', now(), 'legacy-2026-10', now(), now()
  FROM "company_skills" s
  WHERE NOT EXISTS (
    SELECT 1 FROM "company_skill_lifecycle" l
    WHERE l."company_id" = s."company_id" AND l."skill_id" = s."id"
  )
  ON CONFLICT DO NOTHING
  RETURNING "company_skill_lifecycle".*
)
INSERT INTO "company_skill_lifecycle_events" (
  "company_id", "skill_id", "from_state", "to_state", "version_id",
  "actor_type", "actor_id", "reason", "created_at"
)
SELECT
  c."company_id", c."skill_id", NULL, 'verified', c."verified_version_id",
  'system', 'skill-lifecycle-backfill', 'legacy-2026-10', now()
FROM created c;
--> statement-breakpoint
-- Skill cards: one item per (company, skill), never touching an existing slug.
-- The slug is the skill key normalised to the knowledge slug rules
-- (`[a-z0-9-]+` segments); on a normalisation collision the later skills (the
-- ORDER BY below is deterministic, so a replay computes the same slugs) get a
-- `-<n>` suffix.
WITH sized AS (
  SELECT
    s."company_id",
    s."id" AS skill_id,
    s."key" AS skill_key,
    s."name" AS skill_name,
    s."description" AS skill_description,
    s."source_type" AS source_type,
    s."source_locator" AS source_locator,
    s."categories" AS categories,
    CASE
      WHEN COUNT(*) OVER (PARTITION BY s."company_id", n."base") > 1
       AND ROW_NUMBER() OVER (
             PARTITION BY s."company_id", n."base"
             ORDER BY s."key", s."id"
           ) > 1
      THEN 'skills/' || n."base" || '-' ||
           ROW_NUMBER() OVER (
             PARTITION BY s."company_id", n."base"
             ORDER BY s."key", s."id"
           )::text
      ELSE 'skills/' || n."base"
    END AS card_slug
  FROM "company_skills" s
  CROSS JOIN LATERAL (
    SELECT btrim(regexp_replace(lower(s."key"), '[^a-z0-9]+', '-', 'g'), '-') AS "base"
  ) n
),
card_body AS (
  SELECT
    sized.*,
    ('# ' || regexp_replace(sized."skill_name", '\s+', ' ', 'g') || E'\n\n' ||
     COALESCE(NULLIF(btrim(sized."skill_description"), ''), '(no description)') || E'\n\n' ||
     '## Skill card' || E'\n\n' ||
     E'- key: `' || sized."skill_key" || '`' || E'\n' ||
     E'- lifecycle: verified (legacy-2026-10 backfill, OPE-5960)' || E'\n' ||
     E'- source: `' || sized."source_type" || '`' ||
       CASE
         WHEN sized."source_locator" IS NULL OR btrim(sized."source_locator") = ''
         THEN E'\n'
         ELSE E' — `' || sized."source_locator" || '`' || E'\n'
       END ||
     CASE
       WHEN cardinality(sized."categories") > 0
       THEN E'- categories: ' || array_to_string(sized."categories", ', ') || E'\n'
       ELSE ''
     END
    ) AS content
  FROM sized
  WHERE NOT EXISTS (
    SELECT 1 FROM "knowledge_items" k
    WHERE k."nest_id" = sized."company_id" AND k."slug" = sized."card_slug"
  )
),
ins_items AS (
  INSERT INTO "knowledge_items" (
    "company_id", "nest_id", "kind", "slug", "title", "summary", "status", "folder_path",
    "tags", "approval_required", "current_revision_number", "delivered_revision_id",
    "created_by_agent_id", "created_by_user_id", "created_at", "updated_at"
  )
  SELECT
    cb."company_id", cb."company_id", 'skill_card', cb."card_slug",
    left(regexp_replace(cb."skill_name", '\s+', ' ', 'g'), 300),
    CASE
      WHEN btrim(COALESCE(cb."skill_description", '')) = '' THEN NULL
      ELSE left(btrim(cb."skill_description"), 500)
    END,
    'published', 'skills',
    COALESCE(
      (SELECT jsonb_agg(x ORDER BY x) FROM (
         SELECT DISTINCT lower(btrim(c)) AS x FROM unnest(cb."categories") c WHERE btrim(c) <> ''
       ) t),
      '[]'::jsonb
    ),
    false, 1,
    NULL, 'system:skill-lifecycle-backfill', now(), now()
  FROM card_body cb
  ON CONFLICT DO NOTHING
  RETURNING "knowledge_items".*
),
ins_revisions AS (
  INSERT INTO "knowledge_revisions" (
    "company_id", "nest_id", "item_id", "revision_number", "status", "content",
    "change_summary", "approved_by", "approved_at",
    "created_by_agent_id", "created_by_user_id", "created_at"
  )
  SELECT
    i."company_id", i."nest_id", i."id", 1, 'approved', cb."content",
    'skill card created by the legacy-2026-10 backfill (OPE-5960)',
    'system:skill-lifecycle-backfill', now(),
    NULL, 'system:skill-lifecycle-backfill', now()
  FROM ins_items i
  JOIN card_body cb ON cb."card_slug" = i."slug" AND cb."company_id" = i."company_id"
  RETURNING "knowledge_revisions"."id", "knowledge_revisions"."item_id"
)
UPDATE "knowledge_items" k
SET "delivered_revision_id" = r."id"
FROM ins_revisions r
WHERE r."item_id" = k."id";
--> statement-breakpoint
-- Search mirror: a `knowledge_search` row for every card created above, with
-- the body copied from the item's delivered revision — the same content, so
-- the read-model invariant holds (search == delivery) by construction.
INSERT INTO "knowledge_search" ("item_id", "nest_id", "slug", "title", "summary", "body")
SELECT k."id", k."nest_id", k."slug", k."title", k."summary", r."content"
FROM "knowledge_items" k
JOIN "knowledge_revisions" r ON r."id" = k."delivered_revision_id"
WHERE k."kind" = 'skill_card'
  AND k."created_by_user_id" = 'system:skill-lifecycle-backfill'
ON CONFLICT ("item_id") DO NOTHING;
--> statement-breakpoint
-- Provenance: the skill's own source (catalog | local_path | url) becomes the
-- card revision's source row, so every claim on the card points back at the
-- skill entry it describes. The slug (skills/<normalised key>) maps the card
-- back to its skill; the deterministic collision suffix matches statement 2.
WITH sized AS (
  SELECT
    s."company_id",
    s."key" AS skill_key,
    s."source_type" AS source_type,
    s."source_locator" AS source_locator,
    CASE
      WHEN COUNT(*) OVER (PARTITION BY s."company_id", n."base") > 1
       AND ROW_NUMBER() OVER (
             PARTITION BY s."company_id", n."base"
             ORDER BY s."key", s."id"
           ) > 1
      THEN 'skills/' || n."base" || '-' ||
           ROW_NUMBER() OVER (
             PARTITION BY s."company_id", n."base"
             ORDER BY s."key", s."id"
           )::text
      ELSE 'skills/' || n."base"
    END AS card_slug
  FROM "company_skills" s
  CROSS JOIN LATERAL (
    SELECT btrim(regexp_replace(lower(s."key"), '[^a-z0-9]+', '-', 'g'), '-') AS "base"
  ) n
),
cards AS (
  SELECT k."id" AS item_id, k."nest_id", k."company_id",
         CASE WHEN sized."source_type" = 'url' THEN 'url' ELSE 'document' END AS source_kind,
         COALESCE(NULLIF(btrim(sized."source_locator"), ''), sized."skill_key") AS source_ref,
         k."delivered_revision_id"
  FROM "knowledge_items" k
  JOIN sized ON sized."card_slug" = k."slug" AND sized."company_id" = k."company_id"
  WHERE k."kind" = 'skill_card'
    AND k."created_by_user_id" = 'system:skill-lifecycle-backfill'
    AND k."delivered_revision_id" IS NOT NULL
)
INSERT INTO "knowledge_sources" ("company_id", "nest_id", "revision_id", "kind", "ref", "note", "created_at")
SELECT
  c."company_id", c."nest_id", c."delivered_revision_id",
  c."source_kind",
  c."source_ref",
  'skill source recorded by the legacy-2026-10 backfill (OPE-5960)',
  now()
FROM cards c
ON CONFLICT ("revision_id", "kind", "ref") DO NOTHING;
--> statement-breakpoint
-- Audit trail: one knowledge event per backfilled card, mirroring what the
-- module's own create+publish path writes, guarded so a replay adds nothing.
INSERT INTO "knowledge_events" (
  "company_id", "nest_id", "item_id", "revision_id", "event", "payload",
  "actor_type", "actor_id", "created_at"
)
SELECT
  k."company_id", k."nest_id", k."id", k."delivered_revision_id", 'knowledge.backfilled',
  jsonb_build_object('slug', k."slug", 'reason', 'legacy-2026-10', 'task', 'OPE-5960'),
  'system', 'skill-lifecycle-backfill', now()
FROM "knowledge_items" k
WHERE k."kind" = 'skill_card'
  AND k."created_by_user_id" = 'system:skill-lifecycle-backfill'
  AND NOT EXISTS (
    SELECT 1 FROM "knowledge_events" e
    WHERE e."item_id" = k."id" AND e."event" = 'knowledge.backfilled'
  );
