-- Clear stale blocked-only metadata left on issues that already left blocked.
UPDATE "issues"
SET "unblock_descriptor" = NULL,
    "blocker_metadata" = NULL,
    "blocked_transition_at" = NULL,
    "blocked_owner_notified_at" = NULL
WHERE "status" <> 'blocked'
  AND ("unblock_descriptor" IS NOT NULL
    OR "blocker_metadata" IS NOT NULL
    OR "blocked_transition_at" IS NOT NULL
    OR "blocked_owner_notified_at" IS NOT NULL);
