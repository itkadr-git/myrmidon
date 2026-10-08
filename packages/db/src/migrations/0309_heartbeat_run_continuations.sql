-- myrmidon(DB-CARE DBC-3): the execution-continuation envelope of a run gets its
-- own table. The envelope used to live inside heartbeat_runs.context_snapshot,
-- where it copied the task history next to the wake payload; the 08.10.2026
-- database audit measured 31 KB average per snapshot and TOAST traffic on
-- heartbeat_runs. One row per run, capped by characters in the writer, with
-- wake_links referencing the wake payload instead of duplicating it.
-- Readers fall back to the legacy context_snapshot copy for older rows.
-- heartbeat_run_continuations is a new table, so no rule of
-- check-migration-safety.ts applies (none of the four rules covers a new
-- relation); the indexes serve the resume lookup by run and the retention
-- sweeps by company.
CREATE TABLE "heartbeat_run_continuations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"run_id" uuid NOT NULL,
	"previous_context_run_id" uuid,
	"envelope" jsonb NOT NULL,
	"envelope_chars" integer NOT NULL,
	"wake_links" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heartbeat_run_continuations" ADD CONSTRAINT "heartbeat_run_continuations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_continuations" ADD CONSTRAINT "heartbeat_run_continuations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_continuations" ADD CONSTRAINT "heartbeat_run_continuations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_continuations_run_uq" ON "heartbeat_run_continuations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "heartbeat_run_continuations_company_agent_created_idx" ON "heartbeat_run_continuations" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "heartbeat_run_continuations_company_issue_created_idx" ON "heartbeat_run_continuations" USING btree ("company_id","issue_id","created_at");