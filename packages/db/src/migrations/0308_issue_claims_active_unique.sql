-- 1.6.5 (OPE-5401 ч.A / SWARM-CLAIM-UNIQUE-INDEX): swarm claim's check-then-insert raced —
-- two board processes could both pass the liveness pre-check in one window and lease the
-- same issue, so the second one's run claimed the task the first was already executing.
-- A partial unique index — one live claim per issue — closes the window; the capture path
-- (server/src/myrmidon/swarm-claim/store.ts insertClaim) maps 23505 to «занято», the same
-- null the advisory pre-check returns. Default behaviour is unchanged: honest claim,
-- honest release, only the double-win is now impossible.
--
-- Repair first. Where the race already won, the earliest live claim is the one the
-- heartbeat sweeper has been keeping — the later rows are stale leftovers nobody renews.
-- Keep the earliest per issue, release the rest; `released_at` stays the one writer of
-- liveness, and the audit trail of both rows survives.
UPDATE "issue_claims" AS stale
SET "released_at" = COALESCE(stale."heartbeat_at", stale."claimed_at", now()),
    "release_reason" = 'migration_dedup_0308'
WHERE stale."released_at" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "issue_claims" AS keeper
    WHERE keeper."issue_id" = stale."issue_id"
      AND keeper."released_at" IS NULL
      AND (
        COALESCE(keeper."claimed_at", keeper."heartbeat_at") < COALESCE(stale."claimed_at", stale."heartbeat_at")
        OR (
          COALESCE(keeper."claimed_at", keeper."heartbeat_at") = COALESCE(stale."claimed_at", stale."heartbeat_at")
          AND keeper."id" < stale."id"
        )
      )
  );--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. The selective duplicate repair above preserves historical evidence, and the unique index must commit atomically with it: creating the index after the repair in a separate transaction would reopen the claim race window this migration exists to close.
CREATE UNIQUE INDEX IF NOT EXISTS "issue_claims_issue_active_uq" ON "issue_claims" USING btree ("issue_id") WHERE "issue_claims"."released_at" IS NULL;
