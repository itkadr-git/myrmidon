-- Clear attribution while the agent is still present. Revision fence updates
-- documents, so letting FK SET NULL actions run in arbitrary order can make
-- that update observe a document referencing the already-deleted agent.
CREATE OR REPLACE FUNCTION "trg_agent_document_attribution_cleanup"() RETURNS trigger AS $trg$
BEGIN
  UPDATE "documents" SET
    "created_by_agent_id" = CASE WHEN "created_by_agent_id" = OLD."id" THEN NULL ELSE "created_by_agent_id" END,
    "updated_by_agent_id" = CASE WHEN "updated_by_agent_id" = OLD."id" THEN NULL ELSE "updated_by_agent_id" END
  WHERE "created_by_agent_id" = OLD."id" OR "updated_by_agent_id" = OLD."id";
  UPDATE "document_revisions" SET "created_by_agent_id" = NULL WHERE "created_by_agent_id" = OLD."id";
  RETURN OLD;
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "agent_document_attribution_cleanup_trg"
  BEFORE DELETE ON "agents"
  FOR EACH ROW EXECUTE FUNCTION "trg_agent_document_attribution_cleanup"();--> statement-breakpoint
-- Delete documents before their company disappears, while revision fence
-- updates can still satisfy the document's company foreign key.
CREATE OR REPLACE FUNCTION "trg_company_document_cleanup"() RETURNS trigger AS $trg$
BEGIN
  DELETE FROM "documents" WHERE "company_id" = OLD."id";
  RETURN OLD;
END;
$trg$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "company_document_cleanup_trg"
  BEFORE DELETE ON "companies"
  FOR EACH ROW EXECUTE FUNCTION "trg_company_document_cleanup"();
