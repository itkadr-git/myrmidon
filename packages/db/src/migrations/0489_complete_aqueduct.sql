ALTER TABLE "issues" ADD COLUMN "acceptance_snapshot_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- myrmidon(OPE-15134/OPE-15145): the acceptance snapshot epoch lives in its
-- own table, never on the issues row. Every bump is a single-row UPSERT on
-- issue_acceptance_epochs, so triggers nested anywhere in a bump chain run
-- normally: there is no shared guard state and no write back into the
-- issues table, which is what made earlier guard-based designs drop nested
-- writers or recurse. The epoch row survives issue delete+recreate (no
-- foreign key), a BEFORE UPDATE trigger rejects any attempt to wind the
-- counter back, and an AFTER DELETE trigger restores a deleted row at
-- epoch+1, so no writer can reset the generation. Writers bump it via
-- AFTER triggers on issues (insert/update), on issue_documents
-- (insert/update/delete, both OLD and NEW issues on a transfer), on
-- documents (insert/update/delete through the owning link), and on
-- document_revisions (insert/update/delete) — trigger-level tracking covers
-- every SQL writer, including batch imports and future code.
CREATE TABLE "issue_acceptance_epochs" (
  "issue_id" uuid PRIMARY KEY,
  "epoch" bigint NOT NULL DEFAULT 0
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bump_issue_acceptance_epoch"("p_issue_id" uuid) RETURNS void AS $bump$
BEGIN
  INSERT INTO "issue_acceptance_epochs" ("issue_id", "epoch")
  VALUES ("p_issue_id", 1)
  ON CONFLICT ("issue_id") DO UPDATE
  SET "epoch" = "issue_acceptance_epochs"."epoch" + 1;
END;
$bump$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trg_issue_acceptance_epoch_monotonic"() RETURNS trigger AS $trg$
BEGIN
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
    PERFORM "bump_issue_acceptance_epoch"(NEW."id");
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM "bump_issue_acceptance_epoch"(NEW."id");
  END IF;
  RETURN NULL;
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "issues_acceptance_epoch_trg"
  AFTER INSERT OR UPDATE ON "issues"
  FOR EACH ROW EXECUTE FUNCTION "trg_issues_acceptance_epoch"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trg_issue_documents_acceptance_epoch"() RETURNS trigger AS $trg$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."key" = 'acceptance-scenarios' THEN
      PERFORM "bump_issue_acceptance_epoch"(NEW."issue_id");
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD."key" = 'acceptance-scenarios' OR NEW."key" = 'acceptance-scenarios' THEN
      -- A transfer bumps both sides, exactly once each when they differ.
      IF OLD."issue_id" IS DISTINCT FROM NEW."issue_id" THEN
        PERFORM "bump_issue_acceptance_epoch"(OLD."issue_id");
      END IF;
      PERFORM "bump_issue_acceptance_epoch"(NEW."issue_id");
    END IF;
  ELSE
    IF OLD."key" = 'acceptance-scenarios' THEN
      PERFORM "bump_issue_acceptance_epoch"(OLD."issue_id");
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
  SELECT "issue_id" INTO "v_issue_id"
  FROM "issue_documents"
  WHERE "document_id" = COALESCE(NEW."id", OLD."id")
    AND "key" = 'acceptance-scenarios'
  LIMIT 1;
  IF "v_issue_id" IS NOT NULL THEN
    PERFORM "bump_issue_acceptance_epoch"("v_issue_id");
  END IF;
  RETURN NULL;
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "documents_acceptance_epoch_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION "trg_documents_acceptance_epoch"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trg_document_revisions_acceptance_epoch"() RETURNS trigger AS $trg$
DECLARE
  "v_old_issue_id" uuid;
  "v_new_issue_id" uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "i"."issue_id" INTO "v_new_issue_id"
    FROM "documents" "d"
    JOIN "issue_documents" "i" ON "i"."document_id" = "d"."id"
    WHERE "d"."id" = NEW."document_id" AND "i"."key" = 'acceptance-scenarios'
    LIMIT 1;
    IF "v_new_issue_id" IS NOT NULL THEN
      PERFORM "bump_issue_acceptance_epoch"("v_new_issue_id");
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- A revision moved between documents bumps both owners, exactly once
    -- each when they differ; a moved-back revision can never restore the
    -- previous pin.
    SELECT "i"."issue_id" INTO "v_old_issue_id"
    FROM "documents" "d"
    JOIN "issue_documents" "i" ON "i"."document_id" = "d"."id"
    WHERE "d"."id" = OLD."document_id" AND "i"."key" = 'acceptance-scenarios'
    LIMIT 1;
    SELECT "i"."issue_id" INTO "v_new_issue_id"
    FROM "documents" "d"
    JOIN "issue_documents" "i" ON "i"."document_id" = "d"."id"
    WHERE "d"."id" = NEW."document_id" AND "i"."key" = 'acceptance-scenarios'
    LIMIT 1;
    IF "v_old_issue_id" IS DISTINCT FROM "v_new_issue_id" THEN
      IF "v_old_issue_id" IS NOT NULL THEN
        PERFORM "bump_issue_acceptance_epoch"("v_old_issue_id");
      END IF;
    END IF;
    IF "v_new_issue_id" IS NOT NULL THEN
      PERFORM "bump_issue_acceptance_epoch"("v_new_issue_id");
    END IF;
  ELSE
    SELECT "i"."issue_id" INTO "v_old_issue_id"
    FROM "documents" "d"
    JOIN "issue_documents" "i" ON "i"."document_id" = "d"."id"
    WHERE "d"."id" = OLD."document_id" AND "i"."key" = 'acceptance-scenarios'
    LIMIT 1;
    IF "v_old_issue_id" IS NOT NULL THEN
      PERFORM "bump_issue_acceptance_epoch"("v_old_issue_id");
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
ALTER TABLE "issues" DROP COLUMN "acceptance_snapshot_version";
