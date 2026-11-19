ALTER TABLE "issues" ADD COLUMN "acceptance_snapshot_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- myrmidon(OPE-15134/OPE-15145): a company-bound document owner and
-- revision document fence serialize writers with acceptance link changes.
-- Issue row fences invalidate stale REPEATABLE READ writers; the separate
-- epoch survives issue deletion and detects committed ABA changes. Supported
-- writers must leave these database constraints and triggers enabled.
-- Keep the acceptance owner on the document itself so revision writers need
-- not rediscover it through a link invisible to their transaction snapshot.
ALTER TABLE "documents" ADD COLUMN "acceptance_issue_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "issues_id_company_acceptance_uq" ON "issues" ("id", "company_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_acceptance_issue_company_fk"
  FOREIGN KEY ("acceptance_issue_id", "company_id") REFERENCES "issues" ("id", "company_id");--> statement-breakpoint
UPDATE "documents" AS d SET "acceptance_issue_id" = l."issue_id"
  FROM "issue_documents" AS l
  WHERE l."document_id" = d."id" AND l."key" = 'acceptance-scenarios'
    AND l."company_id" = d."company_id";--> statement-breakpoint
DO $check$ BEGIN
  IF EXISTS (SELECT 1 FROM "issue_documents" l JOIN "documents" d ON d."id" = l."document_id"
    WHERE l."key" = 'acceptance-scenarios' AND (d."acceptance_issue_id" IS DISTINCT FROM l."issue_id" OR d."company_id" IS DISTINCT FROM l."company_id")) THEN
    RAISE EXCEPTION 'invalid existing acceptance document binding';
  END IF;
END $check$;--> statement-breakpoint
CREATE TABLE "issue_acceptance_epochs" (
  "issue_id" uuid PRIMARY KEY,
  "epoch" bigint NOT NULL DEFAULT 0
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bump_issue_acceptance_epoch_internal"("p_issue_id" uuid) RETURNS void AS $bump$
BEGIN
  INSERT INTO "issue_acceptance_epochs" ("issue_id", "epoch")
  VALUES ("p_issue_id", 1)
  ON CONFLICT ("issue_id") DO UPDATE
  SET "epoch" = "issue_acceptance_epochs"."epoch" + 1;
END;
$bump$ LANGUAGE plpgsql;--> statement-breakpoint
-- Explicit writers update the issue row to fence stale repeatable-read writers
-- without assigning the user-visible updated_at timestamp.
CREATE OR REPLACE FUNCTION "bump_issue_acceptance_epoch"("p_issue_id" uuid) RETURNS void AS $bump$
BEGIN
  UPDATE "issues" SET "last_activity_at" = "last_activity_at" WHERE "id" = "p_issue_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cannot bump acceptance epoch for missing issue %', "p_issue_id";
  END IF;
END;
$bump$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trg_issue_acceptance_epoch_monotonic"() RETURNS trigger AS $trg$
BEGIN
  IF NEW."issue_id" IS DISTINCT FROM OLD."issue_id" THEN
    -- Re-keying an epoch row would let a PK shuffle plus an identity ABA
    -- hand a stale pin its old snapshot back; the row key is immutable.
    RAISE EXCEPTION 'issue acceptance epochs are keyed by issue_id: re-keying from % to % is forbidden', OLD."issue_id", NEW."issue_id";
  END IF;
  IF NEW."epoch" < OLD."epoch" THEN
    RAISE EXCEPTION 'issue acceptance epoch is trigger-managed and monotonic: direct decrease from % to % is forbidden', OLD."epoch", NEW."epoch";
  END IF;
  RETURN NEW;
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "issue_acceptance_epoch_monotonic_trg"
  BEFORE UPDATE ON "issue_acceptance_epochs"
  FOR EACH ROW EXECUTE FUNCTION "trg_issue_acceptance_epoch_monotonic"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trg_issue_acceptance_epoch_undelete"() RETURNS trigger AS $trg$
BEGIN
  -- Deleting the epoch row cannot reset the generation: it comes back at
  -- epoch+1.
  INSERT INTO "issue_acceptance_epochs" ("issue_id", "epoch")
  VALUES (OLD."issue_id", OLD."epoch" + 1)
  ON CONFLICT ("issue_id") DO UPDATE
  SET "epoch" = EXCLUDED."epoch";
  RETURN NULL;
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "issue_acceptance_epoch_undelete_trg"
  AFTER DELETE ON "issue_acceptance_epochs"
  FOR EACH ROW EXECUTE FUNCTION "trg_issue_acceptance_epoch_undelete"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trg_issues_acceptance_epoch"() RETURNS trigger AS $trg$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM "bump_issue_acceptance_epoch_internal"(NEW."id");
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM "bump_issue_acceptance_epoch_internal"(NEW."id");
  END IF;
  RETURN NULL;
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "issues_acceptance_epoch_trg"
  AFTER INSERT OR UPDATE ON "issues"
  FOR EACH ROW EXECUTE FUNCTION "trg_issues_acceptance_epoch"();--> statement-breakpoint
-- Lock the issue before accepting a tenant-bound link.  The lock also makes
-- a concurrent company move wait, rather than validating an obsolete tenant.
CREATE OR REPLACE FUNCTION "trg_acceptance_link_issue_company"() RETURNS trigger AS $trg$
DECLARE
  "v_company_id" uuid;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD."key" = 'acceptance-scenarios' AND
     (TG_OP = 'DELETE' OR NEW."key" <> 'acceptance-scenarios' OR NEW."document_id" IS DISTINCT FROM OLD."document_id") THEN
    UPDATE "documents" SET "acceptance_issue_id" = NULL
      WHERE "id" = OLD."document_id" AND "acceptance_issue_id" = OLD."issue_id";
  END IF;
  IF TG_OP <> 'DELETE' AND NEW."key" = 'acceptance-scenarios' THEN
    SELECT "company_id" INTO "v_company_id" FROM "issues"
      WHERE "id" = NEW."issue_id" FOR UPDATE;
    IF NOT FOUND OR "v_company_id" IS DISTINCT FROM NEW."company_id" THEN
      RAISE EXCEPTION 'acceptance link issue company mismatch';
    END IF;
    -- Change the document row, not merely its lock: a stale repeatable-read
    -- revision writer must get a serialization failure after link creation.
    UPDATE "documents" SET "acceptance_issue_id" = NEW."issue_id"
      WHERE "id" = NEW."document_id" AND "company_id" = NEW."company_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'acceptance link document company mismatch';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "document_revisions"
      WHERE "document_id" = NEW."document_id"
        AND "company_id" IS DISTINCT FROM NEW."company_id"
    ) THEN
      RAISE EXCEPTION 'acceptance link revision company mismatch';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "acceptance_link_issue_company_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "issue_documents"
  FOR EACH ROW EXECUTE FUNCTION "trg_acceptance_link_issue_company"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trg_acceptance_company_move_guard"() RETURNS trigger AS $trg$
BEGIN
  IF NEW."company_id" IS DISTINCT FROM OLD."company_id" AND EXISTS (
    SELECT 1 FROM "issue_documents"
    WHERE "key" = 'acceptance-scenarios'
      AND ((TG_TABLE_NAME = 'issues' AND "issue_id" = OLD."id")
        OR (TG_TABLE_NAME = 'documents' AND "document_id" = OLD."id"))
  ) THEN
    RAISE EXCEPTION 'cannot move a linked acceptance % to another company', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "issue_acceptance_company_move_guard_trg"
  BEFORE UPDATE OF "company_id" ON "issues"
  FOR EACH ROW EXECUTE FUNCTION "trg_acceptance_company_move_guard"();--> statement-breakpoint
CREATE TRIGGER "document_acceptance_company_move_guard_trg"
  BEFORE UPDATE OF "company_id" ON "documents"
  FOR EACH ROW EXECUTE FUNCTION "trg_acceptance_company_move_guard"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trg_issue_documents_acceptance_epoch"() RETURNS trigger AS $trg$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."key" = 'acceptance-scenarios' THEN
      PERFORM "bump_issue_acceptance_epoch_internal"(NEW."issue_id");
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD."key" = 'acceptance-scenarios' OR NEW."key" = 'acceptance-scenarios' THEN
      -- A transfer bumps both sides, exactly once each when they differ.
      IF OLD."issue_id" IS DISTINCT FROM NEW."issue_id" THEN
        PERFORM "bump_issue_acceptance_epoch_internal"(OLD."issue_id");
      END IF;
      PERFORM "bump_issue_acceptance_epoch_internal"(NEW."issue_id");
    END IF;
  ELSE
    IF OLD."key" = 'acceptance-scenarios' THEN
      PERFORM "bump_issue_acceptance_epoch_internal"(OLD."issue_id");
    END IF;
  END IF;
  RETURN NULL;
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "issue_documents_acceptance_epoch_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "issue_documents"
  FOR EACH ROW EXECUTE FUNCTION "trg_issue_documents_acceptance_epoch"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trg_documents_acceptance_epoch"() RETURNS trigger AS $trg$
DECLARE
  "v_issue_id" uuid;
BEGIN
  "v_issue_id" := COALESCE(NEW."acceptance_issue_id", OLD."acceptance_issue_id");
  IF "v_issue_id" IS NOT NULL THEN
    -- During an issue DELETE the FK cascade removes the link after the issue
    -- row has gone. The owner FK makes this missing-row case possible only
    -- while that cascade clears the old owner; retain the epoch for ID reuse.
    IF TG_OP = 'UPDATE' AND NEW."acceptance_issue_id" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "issues" WHERE "id" = "v_issue_id") THEN
      PERFORM "bump_issue_acceptance_epoch_internal"("v_issue_id");
    ELSE
      PERFORM "bump_issue_acceptance_epoch"("v_issue_id");
    END IF;
  END IF;
  RETURN NULL;
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "documents_acceptance_epoch_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION "trg_documents_acceptance_epoch"();--> statement-breakpoint
-- Every revision writer participates in the document row serialization point,
-- even when its transaction snapshot predates the acceptance link.
CREATE OR REPLACE FUNCTION "trg_revision_document_fence"() RETURNS trigger AS $trg$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE "documents" SET "updated_at" = "updated_at" WHERE "id" = OLD."document_id";
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW."document_id" IS DISTINCT FROM OLD."document_id") THEN
    UPDATE "documents" SET "updated_at" = "updated_at" WHERE "id" = NEW."document_id";
  END IF;
  IF TG_OP <> 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM "documents"
    WHERE "id" = NEW."document_id" AND "company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'revision document company mismatch';
  END IF;
  IF TG_OP <> 'DELETE' AND EXISTS (
    SELECT 1 FROM "issue_documents" AS "link"
    WHERE "link"."document_id" = NEW."document_id"
      AND "link"."key" = 'acceptance-scenarios'
      AND "link"."company_id" IS DISTINCT FROM NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'acceptance revision company mismatch';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "revision_document_fence_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "document_revisions"
  FOR EACH ROW EXECUTE FUNCTION "trg_revision_document_fence"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trg_document_revisions_acceptance_epoch"() RETURNS trigger AS $trg$
DECLARE
  "v_old_issue_id" uuid;
  "v_new_issue_id" uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "acceptance_issue_id" INTO "v_new_issue_id"
    FROM "documents" WHERE "id" = NEW."document_id";
    IF "v_new_issue_id" IS NOT NULL THEN
      PERFORM "bump_issue_acceptance_epoch_internal"("v_new_issue_id");
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- A revision moved between documents bumps both owners, exactly once
    -- each when they differ; a moved-back revision can never restore the
    -- previous pin.
    SELECT "acceptance_issue_id" INTO "v_old_issue_id"
    FROM "documents" WHERE "id" = OLD."document_id";
    SELECT "acceptance_issue_id" INTO "v_new_issue_id"
    FROM "documents" WHERE "id" = NEW."document_id";
    IF "v_old_issue_id" IS DISTINCT FROM "v_new_issue_id" THEN
      IF "v_old_issue_id" IS NOT NULL THEN
        PERFORM "bump_issue_acceptance_epoch_internal"("v_old_issue_id");
      END IF;
    END IF;
    IF "v_new_issue_id" IS NOT NULL THEN
      PERFORM "bump_issue_acceptance_epoch_internal"("v_new_issue_id");
    END IF;
  ELSE
    SELECT "acceptance_issue_id" INTO "v_old_issue_id"
    FROM "documents" WHERE "id" = OLD."document_id";
    IF "v_old_issue_id" IS NOT NULL THEN
      PERFORM "bump_issue_acceptance_epoch_internal"("v_old_issue_id");
    END IF;
  END IF;
  RETURN NULL;
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "document_revisions_acceptance_epoch_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "document_revisions"
  FOR EACH ROW EXECUTE FUNCTION "trg_document_revisions_acceptance_epoch"();--> statement-breakpoint
-- Row triggers never fire on TRUNCATE; a statement-level guard fails closed
-- so the generations can never be reset at once.
CREATE OR REPLACE FUNCTION "trg_issue_acceptance_epochs_no_truncate"() RETURNS trigger AS $trg$
BEGIN
  RAISE EXCEPTION 'issue_acceptance_epochs cannot be truncated: epochs are monotonic generations';
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "issue_acceptance_epochs_no_truncate_trg"
  BEFORE TRUNCATE ON "issue_acceptance_epochs"
  FOR EACH STATEMENT EXECUTE FUNCTION "trg_issue_acceptance_epochs_no_truncate"();--> statement-breakpoint
-- Validate the final graph, not the intermediate state while the link trigger
-- updates the document. This also rejects direct changes to the owner column.
CREATE OR REPLACE FUNCTION "check_acceptance_document_binding"() RETURNS trigger AS $check$
DECLARE
  v_document_id uuid;
  v_owner uuid;
  v_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'documents' THEN
    v_document_id := COALESCE(NEW."id", OLD."id");
  ELSE
    v_document_id := COALESCE(NEW."document_id", OLD."document_id");
  END IF;
  SELECT "acceptance_issue_id" INTO v_owner FROM "documents" WHERE "id" = v_document_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO v_count FROM "issue_documents"
    WHERE "document_id" = v_document_id AND "key" = 'acceptance-scenarios';
  IF (v_owner IS NULL AND v_count <> 0) OR
     (v_owner IS NOT NULL AND (v_count <> 1 OR NOT EXISTS (
       SELECT 1 FROM "issue_documents" l JOIN "documents" d ON d."id" = l."document_id"
       WHERE l."document_id" = v_document_id AND l."key" = 'acceptance-scenarios'
         AND l."issue_id" = v_owner AND l."company_id" = d."company_id"
     ))) THEN
    RAISE EXCEPTION 'invalid acceptance document binding for %', v_document_id;
  END IF;
  RETURN NULL;
END;
$check$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "acceptance_document_binding_check"
  AFTER INSERT OR UPDATE ON "documents" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_acceptance_document_binding"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "acceptance_link_binding_check"
  AFTER INSERT OR UPDATE OR DELETE ON "issue_documents" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_acceptance_document_binding"();--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "acceptance_snapshot_version";
