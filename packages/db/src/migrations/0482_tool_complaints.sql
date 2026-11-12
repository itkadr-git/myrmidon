-- 1.7 TOOL-COMPLAINTS-API (OPE-12228): the agent tool-complaint channel.
-- An agent (bearer agent API key) files a complaint about a tool
-- {tool, issue, severity, runId?}; the board lists the per-company feed
-- with lifecycle statuses. Company-scoped: complaints never cross
-- companies.

CREATE TABLE "tool_complaints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"issue" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"run_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_complaints" ADD CONSTRAINT "tool_complaints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_complaints" ADD CONSTRAINT "tool_complaints_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_complaints_company_created_idx" ON "tool_complaints" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_complaints_company_tool_idx" ON "tool_complaints" USING btree ("company_id","tool");--> statement-breakpoint
CREATE INDEX "tool_complaints_company_status_idx" ON "tool_complaints" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "tool_complaints_agent_created_idx" ON "tool_complaints" USING btree ("agent_id","created_at");