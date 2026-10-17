-- myrmidon(DB-PERF-P7): the issue list computed the "last activity" of every
-- candidate issue as GREATEST(updated_at, MAX(issue_comments.created_at),
-- MAX(activity_log.created_at)) with two correlated subqueries
-- (server/src/services/issues.ts, issueCanonicalLastActivityAtExpr), so the
-- plan ran them for every row before the LIMIT and GET /issues averaged 2.8 s on
-- production. This migration denormalizes the value into issues.last_activity_at,
-- indexes it by (company_id, last_activity_at) for the list's sort, and keeps it
-- current with triggers so no write path has to know about the column.
--
-- Additive: the column is NOT NULL with a default and nothing else changes shape,
-- so the previous image keeps working on the new schema.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Backfill with the exact expression the service used before the column existed,
-- including the local-inbox action exclusions of issueLatestLogAtExpr (marking a
-- task read or archiving it from an inbox is per-user bookkeeping and must not
-- look like board activity).
UPDATE "issues" SET "last_activity_at" = GREATEST(
	"updated_at",
	COALESCE((
		SELECT MAX(comment."created_at")
		FROM "issue_comments" AS comment
		WHERE comment."issue_id" = "issues"."id"
			AND comment."company_id" = "issues"."company_id"
	), to_timestamp(0)),
	COALESCE((
		SELECT MAX(log."created_at")
		FROM "activity_log" AS log
		WHERE log."company_id" = "issues"."company_id"
			AND log."entity_type" = 'issue'
			AND log."entity_id" = "issues"."id"::text
			AND log."action" NOT IN ('issue.read_marked','issue.read_unmarked','issue.inbox_archived','issue.inbox_unarchived')
	), to_timestamp(0))
);--> statement-breakpoint
-- myrmidon(DB-PERF-P7): this is NOT CREATE INDEX CONCURRENTLY — the migration
-- runner wraps each migration in a transaction, so CONCURRENTLY is unavailable.
-- issues is not in packages/db/src/table-size-estimates.ts's known-large set
-- (1.6k local rows × 250), so check-migration-safety.ts stays silent, but on the
-- live installation the table holds ~4k rows and the one-time build lock is
-- short. The operator can still pre-create it out of band
-- (`CREATE INDEX CONCURRENTLY IF NOT EXISTS "issues_company_last_activity_at_idx"
-- ON "issues" ("company_id","last_activity_at")`) before applying this migration;
-- IF NOT EXISTS keeps that idempotent.
CREATE INDEX IF NOT EXISTS "issues_company_last_activity_at_idx" ON "issues" USING btree ("company_id","last_activity_at");--> statement-breakpoint
-- A new issue has no comments and no log rows yet, so its canonical value is
-- updated_at. The in-flight default of the new column is deliberately ignored
-- here: importers and fixtures pass a historical updated_at.
CREATE OR REPLACE FUNCTION paperclip_set_issue_last_activity_at() RETURNS trigger AS $$
BEGIN
	NEW."last_activity_at" := COALESCE(NEW."updated_at", now());
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_issue_last_activity_at_insert_trigger ON "issues";--> statement-breakpoint
CREATE TRIGGER paperclip_issue_last_activity_at_insert_trigger
BEFORE INSERT ON "issues"
FOR EACH ROW EXECUTE FUNCTION paperclip_set_issue_last_activity_at();--> statement-breakpoint
-- Any update that moves updated_at is activity; one trigger covers every
-- update site instead of an edit per call.
CREATE OR REPLACE FUNCTION paperclip_bump_issue_last_activity_at() RETURNS trigger AS $$
BEGIN
	IF NEW."last_activity_at" < NEW."updated_at" THEN
		NEW."last_activity_at" := NEW."updated_at";
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_issue_last_activity_at_update_trigger ON "issues";--> statement-breakpoint
CREATE TRIGGER paperclip_issue_last_activity_at_update_trigger
BEFORE UPDATE ON "issues"
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_last_activity_at();--> statement-breakpoint
-- Comments and activity rows are the other two sources of the canonical value.
-- Both triggers only move the column forward (GREATEST), so a backdated row
-- cannot lower it.
CREATE OR REPLACE FUNCTION paperclip_touch_issue_last_activity_at_from_comment() RETURNS trigger AS $$
BEGIN
	UPDATE "issues"
	SET "last_activity_at" = GREATEST("last_activity_at", NEW."created_at")
	WHERE "id" = NEW."issue_id";
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_issue_comment_last_activity_at_trigger ON "issue_comments";--> statement-breakpoint
CREATE TRIGGER paperclip_issue_comment_last_activity_at_trigger
AFTER INSERT ON "issue_comments"
FOR EACH ROW EXECUTE FUNCTION paperclip_touch_issue_last_activity_at_from_comment();--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_touch_issue_last_activity_at_from_log() RETURNS trigger AS $$
BEGIN
	IF NEW."entity_type" = 'issue'
		AND NEW."action" NOT IN ('issue.read_marked','issue.read_unmarked','issue.inbox_archived','issue.inbox_unarchived')
		AND NEW."entity_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
	THEN
		UPDATE "issues"
		SET "last_activity_at" = GREATEST("last_activity_at", NEW."created_at")
		WHERE "id" = NEW."entity_id"::uuid
			AND "company_id" = NEW."company_id";
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_activity_log_last_activity_at_trigger ON "activity_log";--> statement-breakpoint
CREATE TRIGGER paperclip_activity_log_last_activity_at_trigger
AFTER INSERT ON "activity_log"
FOR EACH ROW EXECUTE FUNCTION paperclip_touch_issue_last_activity_at_from_log();
