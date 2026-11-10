-- myrmidon(DB-SIZE OPE-12581): shrink the stored execution continuation
-- envelopes in heartbeat_run_continuations.
--
-- The board audit of 10.11 measured ~19 KB per row and 97% of the table in
-- TOAST. The writers above the table now store the envelope as body
-- references (`bodyOmitted`), because bodies live in issue_comments and every
-- reader (execution-continuation.ts, native-completion-feedback.ts) needs only
-- originCommentIds, objective and message identity/freshness. This migration
-- applies the same shape to the historical rows, so resume keeps comparing
-- like with like:
--   - messages[*].body -> '' with bodyOmitted = true (identity and freshness
--     stay: id, updatedAt, deleted, author fields);
--   - resumeDelta is dropped: buildExecutionContinuation rebuilds the delta
--     from the fresh thread and only reads priorEnvelope.messages;
--   - completedWork is dropped (null): it is recomputed per wake from the
--     source run's result summary;
--   - interactionOutcomes -> [], completedActions and recoveryOutcomes are
--     dropped: they are rebuilt from issue_thread_interactions,
--     heartbeat_runs.result_json and issue_recovery_actions.
-- truncationNotice/history* annotations stay: the renderer needs them to keep
-- telling the agent what it did not receive.
--
-- Rows that already match the compact shape (all bodies are references, no
-- resumeDelta/completedWork/outcomes) are skipped by the WHERE clause, so the
-- migration is idempotent: a second run matches no row and updates nothing.
--
-- Batched by primary-key ranges of 200 rows (a cursor on id, no OFFSET).
-- paperclip:migration-safety-ignore loop-mutation-large-table: the loop walks the primary key (id) in ranges of 200 rows and every UPDATE is limited by the id range and by the JSON keys of the envelope.
-- paperclip:migration-safety-ignore batched-mutation-large-table-missing-index: the batch cursor is the primary key of heartbeat_run_continuations, which is already indexed.
DO $$
DECLARE
  cursor_id uuid := NULL;
  batch_end uuid;
  row_count bigint;
BEGIN
  LOOP
    -- uuid has no max() aggregate in Postgres: take the last id of the 200-row page by ordering.
    batch_end := NULL;
    SELECT page."id" INTO batch_end
    FROM (
      SELECT "id"
      FROM "heartbeat_run_continuations"
      WHERE cursor_id IS NULL OR "id" > cursor_id
      ORDER BY "id"
      LIMIT 200
    ) AS page
    ORDER BY page."id" DESC
    LIMIT 1;
    EXIT WHEN batch_end IS NULL;

    WITH affected AS (
      SELECT "id",
             -- Reference form of one message: identity and freshness stay,
             -- the body goes away (the same shape the writer produces).
             jsonb_set(
               "envelope" - 'resumeDelta'
                          - 'completedActions'
                          - 'recoveryOutcomes',
               '{completedWork}', 'null'::jsonb
             ) AS stripped
      FROM "heartbeat_run_continuations"
      WHERE (cursor_id IS NULL OR "id" > cursor_id)
        AND "id" <= batch_end
        AND (
          (
            jsonb_typeof("envelope" -> 'messages') = 'array'
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements("envelope" -> 'messages') AS msg
              WHERE coalesce((msg ->> 'bodyOmitted')::boolean, false) = false
                AND coalesce(msg ->> 'body', '') <> ''
            )
          )
          OR jsonb_typeof("envelope" -> 'resumeDelta') = 'object'
          OR jsonb_typeof("envelope" -> 'completedWork') = 'string'
          OR jsonb_typeof("envelope" -> 'completedActions') = 'array'
          OR jsonb_typeof("envelope" -> 'recoveryOutcomes') = 'array'
          OR coalesce(jsonb_array_length("envelope" -> 'interactionOutcomes'), 0) > 0
        )
    ), stripped_envelopes AS (
      SELECT a."id",
             CASE
               WHEN jsonb_typeof(a.stripped -> 'messages') = 'array' THEN
                 jsonb_set(
                   a.stripped,
                   '{messages}',
                   (
                     SELECT coalesce(jsonb_agg(
                       CASE
                         WHEN coalesce((msg ->> 'bodyOmitted')::boolean, false) = true
                              OR coalesce(msg ->> 'body', '') = ''
                            THEN msg
                         ELSE msg || jsonb_build_object('body', '', 'bodyOmitted', true)
                       END
                     ), '[]'::jsonb)
                     FROM jsonb_array_elements(a.stripped -> 'messages') AS msg
                   )
                 )
               ELSE a.stripped
             END AS compact_envelope
      FROM affected a
    )
    UPDATE "heartbeat_run_continuations" AS t
    SET "envelope" = s.compact_envelope,
        "envelope_chars" = length(s.compact_envelope::text)
    FROM stripped_envelopes s
    WHERE t."id" = s."id";

    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count = 0 THEN
      -- Nothing changed in this page; pages continue to keep the cursor moving.
      cursor_id := batch_end;
      CONTINUE;
    END IF;

    cursor_id := batch_end;
  END LOOP;
END
$$;
