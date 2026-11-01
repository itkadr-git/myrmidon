-- 1.6.6 (UNBLOCK-ON-EVENT OPE-9963): open blocked tasks with an event reason
-- but missing dueAt and with an unregistered key prefix get dueAt = now() + 2 hours.
-- Registered prefixes (recovery.liveness:, github:, stranded.disposition:)
-- have dedicated event readers.
UPDATE "issues"
SET "unblock_descriptor" = jsonb_set(
  "unblock_descriptor",
  '{reasonRef,dueAt}',
  to_jsonb(to_char((now() + interval '2 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
)
WHERE "status" = 'blocked'
  AND "unblock_descriptor"->'reasonRef'->>'kind' = 'event'
  AND coalesce("unblock_descriptor"->'reasonRef'->>'dueAt', '') = ''
  AND coalesce("unblock_descriptor"->'reasonRef'->>'eventKey', '') NOT LIKE 'recovery.liveness:%'
  AND coalesce("unblock_descriptor"->'reasonRef'->>'eventKey', '') NOT LIKE 'github:%'
  AND coalesce("unblock_descriptor"->'reasonRef'->>'eventKey', '') NOT LIKE 'stranded.disposition:%';
