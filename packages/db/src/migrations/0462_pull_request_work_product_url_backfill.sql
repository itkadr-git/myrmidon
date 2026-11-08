-- 1.6.6 DEFECT REVIEW-CI (OPE-12024): 107 pull_request work products have empty
-- url / external_id, but the address and number live only in metadata
-- ({ url } and/or { repository, number, ... } / { repo, number, ... }).  The
-- board reads CI by url / external_id and returned "CI state=unknown
-- (pull_request_reference_unreadable)", which also caused the review decision
-- engine to reject the reviewer verdict with HTTP 422.  Backfill the missing
-- columns from the metadata JSONB so every pull_request work product is
-- readable without a manual PATCH.  An explicit metadata.url wins; otherwise
-- the url is synthesized from repository/repo + number.
UPDATE "issue_work_products" AS wp
SET
  "url" = CASE
    WHEN wp."url" IS NULL OR wp."url" = '' THEN
      COALESCE(
        NULLIF(wp."metadata"->>'url', ''),
        'https://github.com/'
        || COALESCE(wp."metadata"->>'repository', wp."metadata"->>'repo')
        || '/pull/'
        || (wp."metadata"->>'number')
      )
    ELSE wp."url"
  END,
  "external_id" = CASE
    WHEN wp."external_id" IS NULL OR wp."external_id" = '' THEN
      COALESCE(wp."metadata"->>'repository', wp."metadata"->>'repo')
      || '#pull/'
      || (wp."metadata"->>'number')
    ELSE wp."external_id"
  END
WHERE wp."type" = 'pull_request'
  AND wp."provider" = 'github'
  AND (
    wp."url" IS NULL
    OR wp."url" = ''
    OR wp."external_id" IS NULL
    OR wp."external_id" = ''
  )
  AND wp."metadata" IS NOT NULL
  AND (
    NULLIF(wp."metadata"->>'url', '') IS NOT NULL
    OR (
      (wp."metadata"->>'repository' IS NOT NULL OR wp."metadata"->>'repo' IS NOT NULL)
      AND wp."metadata"->>'number' IS NOT NULL
      AND wp."metadata"->>'number' ~ '^\d+$'
    )
  );
