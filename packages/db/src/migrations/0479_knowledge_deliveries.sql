ALTER TABLE "knowledge_items" ADD COLUMN "deliver_to_castes" jsonb;--> statement-breakpoint
CREATE TABLE "knowledge_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"nest_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"bundle_hash" text NOT NULL,
	"rules_revision_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"index_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compiled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "knowledge_deliveries_nest_id_companies_id_fk" FOREIGN KEY ("nest_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "knowledge_deliveries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_deliveries_agent_uq" ON "knowledge_deliveries" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "knowledge_deliveries_nest_idx" ON "knowledge_deliveries" USING btree ("nest_id");--> statement-breakpoint
CREATE INDEX "knowledge_deliveries_company_idx" ON "knowledge_deliveries" USING btree ("company_id");
