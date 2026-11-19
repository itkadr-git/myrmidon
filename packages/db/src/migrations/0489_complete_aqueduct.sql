ALTER TABLE "issues" ADD COLUMN "acceptance_snapshot_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- myrmidon(OPE-15134/OPE-15145): bump the per-issue acceptance snapshot
-- version on every mutation that can change the atomic acceptance snapshot:
-- any update of the issue row (company, identifier, anything), any
-- insert/update/delete of the issue's acceptance-scenarios link row, and any
-- update of the document bound to the issue through that link. Trigger-level
-- tracking covers every writer, including batch imports and future code, and
-- survives link/document delete+recreate. The depth guard stops the
-- recursive re-entry from the bump's own UPDATE of issues.
CREATE OR REPLACE FUNCTION "bump_issue_acceptance_snapshot_version"("p_issue_id" uuid) RETURNS void AS $bump$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN;
  END IF;
  UPDATE "issues"
  SET "acceptance_snapshot_version" = "acceptance_snapshot_version" + 1
  WHERE "id" = "p_issue_id";
END;
$bump$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trg_issues_acceptance_snapshot"() RETURNS trigger AS $trg$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    PERFORM "bump_issue_acceptance_snapshot_version"(NEW."id");
  END IF;
  RETURN NULL;
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "issues_acceptance_snapshot_trg"
  AFTER UPDATE ON "issues"
  FOR EACH ROW EXECUTE FUNCTION "trg_issues_acceptance_snapshot"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trg_issue_documents_acceptance_snapshot"() RETURNS trigger AS $trg$
DECLARE
  "v_issue_id" uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."key" = 'acceptance-scenarios' THEN
      PERFORM "bump_issue_acceptance_snapshot_version"(NEW."issue_id");
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD."key" = 'acceptance-scenarios' OR NEW."key" = 'acceptance-scenarios' THEN
      PERFORM "bump_issue_acceptance_snapshot_version"(NEW."issue_id");
    END IF;
  ELSE
    IF OLD."key" = 'acceptance-scenarios' THEN
      PERFORM "bump_issue_acceptance_snapshot_version"(OLD."issue_id");
    END IF;
  END IF;
  RETURN NULL;
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "issue_documents_acceptance_snapshot_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "issue_documents"
  FOR EACH ROW EXECUTE FUNCTION "trg_issue_documents_acceptance_snapshot"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trg_documents_acceptance_snapshot"() RETURNS trigger AS $trg$
DECLARE
  "v_issue_id" uuid;
BEGIN
  SELECT "issue_id" INTO "v_issue_id"
  FROM "issue_documents"
  WHERE "document_id" = NEW."id"
  LIMIT 1;
  IF "v_issue_id" IS NOT NULL THEN
    PERFORM "bump_issue_acceptance_snapshot_version"("v_issue_id");
  END IF;
  RETURN NULL;
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "documents_acceptance_snapshot_trg"
  AFTER UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION "trg_documents_acceptance_snapshot"();
