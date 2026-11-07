-- Canonical Paperclip vendor schema DDL for v2026.1012.0
-- Generated from tag v2026.1012.0 (migrations 0000..0305)

CREATE SCHEMA IF NOT EXISTS "drizzle";
CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  "id" SERIAL PRIMARY KEY,
  "hash" text NOT NULL,
  "created_at" bigint
);

-- >>> Migration: 0000_mature_masked_marvel.sql <<<
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"agent_id" uuid,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "agent_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'general' NOT NULL,
	"title" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"reports_to" uuid,
	"capabilities" text,
	"adapter_type" text DEFAULT 'process' NOT NULL,
	"adapter_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"context_mode" text DEFAULT 'thin' NOT NULL,
	"budget_monthly_cents" integer DEFAULT 0 NOT NULL,
	"spent_monthly_cents" integer DEFAULT 0 NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"decision_note" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"budget_monthly_cents" integer DEFAULT 0 NOT NULL,
	"spent_monthly_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"project_id" uuid,
	"goal_id" uuid,
	"billing_code" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"level" text DEFAULT 'task' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"parent_id" uuid,
	"owner_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "heartbeat_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"invocation_source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"external_run_id" text,
	"context_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "issue_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"goal_id" uuid,
	"parent_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'backlog' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"assignee_agent_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"request_depth" integer DEFAULT 0 NOT NULL,
	"billing_code" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'backlog' NOT NULL,
	"lead_agent_id" uuid,
	"target_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "agents" ADD CONSTRAINT "agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "agents" ADD CONSTRAINT "agents_reports_to_agents_id_fk" FOREIGN KEY ("reports_to") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "goals" ADD CONSTRAINT "goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "goals" ADD CONSTRAINT "goals_parent_id_goals_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "goals" ADD CONSTRAINT "goals_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issues" ADD CONSTRAINT "issues_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issues" ADD CONSTRAINT "issues_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issues" ADD CONSTRAINT "issues_parent_id_issues_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issues" ADD CONSTRAINT "issues_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "projects" ADD CONSTRAINT "projects_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_agent_id_agents_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "activity_log_company_created_idx" ON "activity_log" USING btree ("company_id","created_at");
CREATE INDEX "agent_api_keys_key_hash_idx" ON "agent_api_keys" USING btree ("key_hash");
CREATE INDEX "agent_api_keys_company_agent_idx" ON "agent_api_keys" USING btree ("company_id","agent_id");
CREATE INDEX "agents_company_status_idx" ON "agents" USING btree ("company_id","status");
CREATE INDEX "agents_company_reports_to_idx" ON "agents" USING btree ("company_id","reports_to");
CREATE INDEX "approvals_company_status_type_idx" ON "approvals" USING btree ("company_id","status","type");
CREATE INDEX "cost_events_company_occurred_idx" ON "cost_events" USING btree ("company_id","occurred_at");
CREATE INDEX "cost_events_company_agent_occurred_idx" ON "cost_events" USING btree ("company_id","agent_id","occurred_at");
CREATE INDEX "goals_company_idx" ON "goals" USING btree ("company_id");
CREATE INDEX "heartbeat_runs_company_agent_started_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","started_at");
CREATE INDEX "issue_comments_issue_idx" ON "issue_comments" USING btree ("issue_id");
CREATE INDEX "issue_comments_company_idx" ON "issue_comments" USING btree ("company_id");
CREATE INDEX "issues_company_status_idx" ON "issues" USING btree ("company_id","status");
CREATE INDEX "issues_company_assignee_status_idx" ON "issues" USING btree ("company_id","assignee_agent_id","status");
CREATE INDEX "issues_company_parent_idx" ON "issues" USING btree ("company_id","parent_id");
CREATE INDEX "issues_company_project_idx" ON "issues" USING btree ("company_id","project_id");
CREATE INDEX "projects_company_idx" ON "projects" USING btree ("company_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('4a168f2905beecf8aba7c8a051028ebae7c603a957520fe84295ef7138bf4447', 1771300567463);

-- >>> Migration: 0001_fast_northstar.sql <<<
CREATE TABLE "agent_runtime_state" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"adapter_type" text NOT NULL,
	"session_id" text,
	"state_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_run_id" uuid,
	"last_run_status" text,
	"total_input_tokens" bigint DEFAULT 0 NOT NULL,
	"total_output_tokens" bigint DEFAULT 0 NOT NULL,
	"total_cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"total_cost_cents" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "agent_wakeup_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"source" text NOT NULL,
	"trigger_detail" text,
	"reason" text,
	"payload" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"coalesced_count" integer DEFAULT 0 NOT NULL,
	"requested_by_actor_type" text,
	"requested_by_actor_id" text,
	"idempotency_key" text,
	"run_id" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "heartbeat_run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"event_type" text NOT NULL,
	"stream" text,
	"level" text,
	"color" text,
	"message" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "heartbeat_runs" ALTER COLUMN "invocation_source" SET DEFAULT 'on_demand';
ALTER TABLE "agents" ADD COLUMN "runtime_config" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN "trigger_detail" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "wakeup_request_id" uuid;
ALTER TABLE "heartbeat_runs" ADD COLUMN "exit_code" integer;
ALTER TABLE "heartbeat_runs" ADD COLUMN "signal" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "usage_json" jsonb;
ALTER TABLE "heartbeat_runs" ADD COLUMN "result_json" jsonb;
ALTER TABLE "heartbeat_runs" ADD COLUMN "session_id_before" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "session_id_after" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "log_store" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "log_ref" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "log_bytes" bigint;
ALTER TABLE "heartbeat_runs" ADD COLUMN "log_sha256" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "log_compressed" boolean DEFAULT false NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN "stdout_excerpt" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "stderr_excerpt" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "error_code" text;
ALTER TABLE "agent_runtime_state" ADD CONSTRAINT "agent_runtime_state_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "agent_runtime_state" ADD CONSTRAINT "agent_runtime_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "agent_wakeup_requests" ADD CONSTRAINT "agent_wakeup_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "agent_wakeup_requests" ADD CONSTRAINT "agent_wakeup_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "heartbeat_run_events" ADD CONSTRAINT "heartbeat_run_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "heartbeat_run_events" ADD CONSTRAINT "heartbeat_run_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "heartbeat_run_events" ADD CONSTRAINT "heartbeat_run_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "agent_runtime_state_company_agent_idx" ON "agent_runtime_state" USING btree ("company_id","agent_id");
CREATE INDEX "agent_runtime_state_company_updated_idx" ON "agent_runtime_state" USING btree ("company_id","updated_at");
CREATE INDEX "agent_wakeup_requests_company_agent_status_idx" ON "agent_wakeup_requests" USING btree ("company_id","agent_id","status");
CREATE INDEX "agent_wakeup_requests_company_requested_idx" ON "agent_wakeup_requests" USING btree ("company_id","requested_at");
CREATE INDEX "agent_wakeup_requests_agent_requested_idx" ON "agent_wakeup_requests" USING btree ("agent_id","requested_at");
CREATE INDEX "heartbeat_run_events_run_seq_idx" ON "heartbeat_run_events" USING btree ("run_id","seq");
CREATE INDEX "heartbeat_run_events_company_run_idx" ON "heartbeat_run_events" USING btree ("company_id","run_id");
CREATE INDEX "heartbeat_run_events_company_created_idx" ON "heartbeat_run_events" USING btree ("company_id","created_at");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('217284002174a0adcbbb99716afcb92411151a947a8a487de7dcb83a70ba5607', 1771349039633);

-- >>> Migration: 0002_big_zaladane.sql <<<
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_wakeup_request_id_agent_wakeup_requests_id_fk" FOREIGN KEY ("wakeup_request_id") REFERENCES "public"."agent_wakeup_requests"("id") ON DELETE no action ON UPDATE no action;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('9cbdf1229ed84d34bdd56f5b8c3b22675ee4bc1365dd64a944e904bc2424a5e1', 1771349403162);

-- >>> Migration: 0003_shallow_quentin_quire.sql <<<
ALTER TABLE "activity_log" ADD COLUMN "run_id" uuid;
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "activity_log_run_id_idx" ON "activity_log" USING btree ("run_id");
CREATE INDEX "activity_log_entity_type_id_idx" ON "activity_log" USING btree ("entity_type","entity_id");
ALTER TABLE "agents" DROP COLUMN "context_mode";

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f60c49b6ee7454c996a46b590e78b4c22b534981dc08d65d0dd722a46d337a71', 1771456737635);

-- >>> Migration: 0004_issue_identifiers.sql <<<
-- Add issue identifier columns to companies
ALTER TABLE "companies" ADD COLUMN "issue_prefix" text NOT NULL DEFAULT 'PAP';
ALTER TABLE "companies" ADD COLUMN "issue_counter" integer NOT NULL DEFAULT 0;

-- Add issue identifier columns to issues
ALTER TABLE "issues" ADD COLUMN "issue_number" integer;
ALTER TABLE "issues" ADD COLUMN "identifier" text;

-- Backfill existing issues: assign sequential issue_number per company ordered by created_at
WITH numbered AS (
  SELECT id, company_id, ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at ASC) AS rn
  FROM issues
)
UPDATE issues
SET issue_number = numbered.rn,
    identifier = (SELECT issue_prefix FROM companies WHERE companies.id = issues.company_id) || '-' || numbered.rn
FROM numbered
WHERE issues.id = numbered.id;

-- Sync each company's issue_counter to the max assigned number
UPDATE companies
SET issue_counter = COALESCE(
  (SELECT MAX(issue_number) FROM issues WHERE issues.company_id = companies.id),
  0
);

-- Create unique index on (company_id, identifier)
CREATE UNIQUE INDEX "issues_company_identifier_idx" ON "issues" USING btree ("company_id","identifier");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('86e2f6f9d47ba19103a637d886c302b272aac26ccf9ee9d4a321d8c352433182', 1771545600000);

-- >>> Migration: 0005_chief_luke_cage.sql <<<
CREATE TABLE "approval_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "agents" ADD COLUMN "permissions" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "companies" ADD COLUMN "require_board_approval_for_new_agents" boolean DEFAULT true NOT NULL;
ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "approval_comments_company_idx" ON "approval_comments" USING btree ("company_id");
CREATE INDEX "approval_comments_approval_idx" ON "approval_comments" USING btree ("approval_id");
CREATE INDEX "approval_comments_approval_created_idx" ON "approval_comments" USING btree ("approval_id","created_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('7040dd156d41369d8429ee83c01274a28cf45e195ffbea967d9b96f3052d72e1', 1771545601000);

-- >>> Migration: 0006_overjoyed_mister_sinister.sql <<<
CREATE TABLE "agent_config_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"source" text DEFAULT 'patch' NOT NULL,
	"rolled_back_from_revision_id" uuid,
	"changed_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"before_config" jsonb NOT NULL,
	"after_config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "issue_approvals" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"linked_by_agent_id" uuid,
	"linked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_approvals_pk" PRIMARY KEY("issue_id","approval_id")
);

ALTER TABLE "agent_config_revisions" ADD CONSTRAINT "agent_config_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "agent_config_revisions" ADD CONSTRAINT "agent_config_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "agent_config_revisions" ADD CONSTRAINT "agent_config_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "issue_approvals" ADD CONSTRAINT "issue_approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issue_approvals" ADD CONSTRAINT "issue_approvals_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_approvals" ADD CONSTRAINT "issue_approvals_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_approvals" ADD CONSTRAINT "issue_approvals_linked_by_agent_id_agents_id_fk" FOREIGN KEY ("linked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "agent_config_revisions_company_agent_created_idx" ON "agent_config_revisions" USING btree ("company_id","agent_id","created_at");
CREATE INDEX "agent_config_revisions_agent_created_idx" ON "agent_config_revisions" USING btree ("agent_id","created_at");
CREATE INDEX "issue_approvals_issue_idx" ON "issue_approvals" USING btree ("issue_id");
CREATE INDEX "issue_approvals_approval_idx" ON "issue_approvals" USING btree ("approval_id");
CREATE INDEX "issue_approvals_company_idx" ON "issue_approvals" USING btree ("company_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2b9151436c1ca83ae56c0a20915d229a8f22a1398db0f5e7219572026b804b22', 1771545602000);

-- >>> Migration: 0007_new_quentin_quire.sql <<<
CREATE TABLE "agent_task_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"adapter_type" text NOT NULL,
	"task_key" text NOT NULL,
	"session_params_json" jsonb,
	"session_display_id" text,
	"last_run_id" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "agent_task_sessions" ADD CONSTRAINT "agent_task_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "agent_task_sessions" ADD CONSTRAINT "agent_task_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "agent_task_sessions" ADD CONSTRAINT "agent_task_sessions_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "agent_task_sessions_company_agent_adapter_task_uniq" ON "agent_task_sessions" USING btree ("company_id","agent_id","adapter_type","task_key");
CREATE INDEX "agent_task_sessions_company_agent_updated_idx" ON "agent_task_sessions" USING btree ("company_id","agent_id","updated_at");
CREATE INDEX "agent_task_sessions_company_task_updated_idx" ON "agent_task_sessions" USING btree ("company_id","task_key","updated_at");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e9f9a84e20db5e428ae9213b248fa51872cb2fb7db627d06d9a4f1506a502ec9', 1771545603000);

-- >>> Migration: 0008_amused_zzzax.sql <<<
ALTER TABLE "issues" ADD COLUMN "hidden_at" timestamp with time zone;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('d04b3303685364349c205964578bd5c4d62abf81dea54d971168c1bb6baa5b87', 1771534160426);

-- >>> Migration: 0009_fast_jackal.sql <<<
CREATE TABLE "company_secret_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"material" jsonb NOT NULL,
	"value_sha256" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);

CREATE TABLE "company_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'local_encrypted' NOT NULL,
	"external_ref" text,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"description" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "company_secret_versions" ADD CONSTRAINT "company_secret_versions_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "company_secret_versions" ADD CONSTRAINT "company_secret_versions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "company_secret_versions_secret_idx" ON "company_secret_versions" USING btree ("secret_id","created_at");
CREATE INDEX "company_secret_versions_value_sha256_idx" ON "company_secret_versions" USING btree ("value_sha256");
CREATE UNIQUE INDEX "company_secret_versions_secret_version_uq" ON "company_secret_versions" USING btree ("secret_id","version");
CREATE INDEX "company_secrets_company_idx" ON "company_secrets" USING btree ("company_id");
CREATE INDEX "company_secrets_company_provider_idx" ON "company_secrets" USING btree ("company_id","provider");
CREATE UNIQUE INDEX "company_secrets_company_name_uq" ON "company_secrets" USING btree ("company_id","name");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2c560d142857e22379831a7bcedadd3dd44e02f363b80ca5abdca9eec22c18a5', 1771534211029);

-- >>> Migration: 0010_stale_justin_hammer.sql <<<
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"original_filename" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "issue_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"issue_comment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "assets" ADD CONSTRAINT "assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_issue_comment_id_issue_comments_id_fk" FOREIGN KEY ("issue_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "assets_company_created_idx" ON "assets" USING btree ("company_id","created_at");
CREATE INDEX "assets_company_provider_idx" ON "assets" USING btree ("company_id","provider");
CREATE UNIQUE INDEX "assets_company_object_key_uq" ON "assets" USING btree ("company_id","object_key");
CREATE INDEX "issue_attachments_company_issue_idx" ON "issue_attachments" USING btree ("company_id","issue_id");
CREATE INDEX "issue_attachments_issue_comment_idx" ON "issue_attachments" USING btree ("issue_comment_id");
CREATE UNIQUE INDEX "issue_attachments_asset_uq" ON "issue_attachments" USING btree ("asset_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('0c2be1ee431b088695ab3d1f1471d50f8fb619701b50b3c6a6beef725307f82d', 1771605173513);

-- >>> Migration: 0011_windy_corsair.sql <<<
CREATE TABLE "project_goals" (
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_goals_project_id_goal_id_pk" PRIMARY KEY("project_id","goal_id")
);

ALTER TABLE "project_goals" ADD CONSTRAINT "project_goals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "project_goals" ADD CONSTRAINT "project_goals_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "project_goals" ADD CONSTRAINT "project_goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "project_goals_project_idx" ON "project_goals" USING btree ("project_id");
CREATE INDEX "project_goals_goal_idx" ON "project_goals" USING btree ("goal_id");
CREATE INDEX "project_goals_company_idx" ON "project_goals" USING btree ("company_id");
INSERT INTO "project_goals" ("project_id", "goal_id", "company_id")
SELECT "id", "goal_id", "company_id" FROM "projects" WHERE "goal_id" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('06ef4c6d69108b55a7d618d76d4fb020e51a717d7519995f933b9ae021154659', 1771616419708);

-- >>> Migration: 0012_perpetual_ser_duncan.sql <<<
ALTER TABLE "issues" ADD COLUMN "checkout_run_id" uuid;
ALTER TABLE "issues" ADD CONSTRAINT "issues_checkout_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("checkout_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('363da95d93bf8f1e3f2c9d046684d66578b494e8cbadba6642432ea6db52b7a2', 1771619674673);

-- >>> Migration: 0013_dashing_wasp.sql <<<
ALTER TABLE "issues" ADD COLUMN "execution_run_id" uuid;
ALTER TABLE "issues" ADD COLUMN "execution_agent_name_key" text;
ALTER TABLE "issues" ADD COLUMN "execution_locked_at" timestamp with time zone;
ALTER TABLE "issues" ADD CONSTRAINT "issues_execution_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("execution_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('00e91acdaa63469f002158dbda1a2ff7362d41da4de334fe1e198482c8eaf9fb', 1771623691139);

-- >>> Migration: 0014_many_mikhail_rasputin.sql <<<
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);

CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone
);

CREATE TABLE "company_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"membership_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "instance_user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'instance_admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"invite_type" text DEFAULT 'company_join' NOT NULL,
	"token_hash" text NOT NULL,
	"allowed_join_types" text DEFAULT 'both' NOT NULL,
	"defaults_payload" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invite_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"request_type" text NOT NULL,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"request_ip" text NOT NULL,
	"requesting_user_id" text,
	"request_email_snapshot" text,
	"agent_name" text,
	"adapter_type" text,
	"capabilities" text,
	"agent_defaults_payload" jsonb,
	"created_agent_id" uuid,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"rejected_by_user_id" text,
	"rejected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "principal_permission_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"permission_key" text NOT NULL,
	"scope" jsonb,
	"granted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "issues" ADD COLUMN "assignee_user_id" text;
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invites" ADD CONSTRAINT "invites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_created_agent_id_agents_id_fk" FOREIGN KEY ("created_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "principal_permission_grants" ADD CONSTRAINT "principal_permission_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "company_memberships_company_principal_unique_idx" ON "company_memberships" USING btree ("company_id","principal_type","principal_id");
CREATE INDEX "company_memberships_principal_status_idx" ON "company_memberships" USING btree ("principal_type","principal_id","status");
CREATE INDEX "company_memberships_company_status_idx" ON "company_memberships" USING btree ("company_id","status");
CREATE UNIQUE INDEX "instance_user_roles_user_role_unique_idx" ON "instance_user_roles" USING btree ("user_id","role");
CREATE INDEX "instance_user_roles_role_idx" ON "instance_user_roles" USING btree ("role");
CREATE UNIQUE INDEX "invites_token_hash_unique_idx" ON "invites" USING btree ("token_hash");
CREATE INDEX "invites_company_invite_state_idx" ON "invites" USING btree ("company_id","invite_type","revoked_at","expires_at");
CREATE UNIQUE INDEX "join_requests_invite_unique_idx" ON "join_requests" USING btree ("invite_id");
CREATE INDEX "join_requests_company_status_type_created_idx" ON "join_requests" USING btree ("company_id","status","request_type","created_at");
CREATE UNIQUE INDEX "principal_permission_grants_unique_idx" ON "principal_permission_grants" USING btree ("company_id","principal_type","principal_id","permission_key");
CREATE INDEX "principal_permission_grants_company_permission_idx" ON "principal_permission_grants" USING btree ("company_id","permission_key");
CREATE INDEX "issues_company_assignee_user_status_idx" ON "issues" USING btree ("company_id","assignee_user_id","status");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('cd2de941d6fc0f7fea6bb44fa41b978e88300e3ef3af68713aa57c6ea2a70241', 1771691806349);

-- >>> Migration: 0015_project_color_archived.sql <<<
ALTER TABLE "projects" ADD COLUMN "color" text;
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('42b5f5c8ea4f81988a6064b2eb8491c74847a4279ee5a5f3255cd69966dc9877', 1771865100000);

-- >>> Migration: 0016_agent_icon.sql <<<
ALTER TABLE "agents" ADD COLUMN "icon" text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('949b6579d20aca89afb8efc0375e705a1b6a275e9d7cec5ff9ba2eebf24ef88d', 1771955900000);

-- >>> Migration: 0017_tiresome_gabe_jones.sql <<<
DROP INDEX "issues_company_identifier_idx";

-- Rebuild issue prefixes to be company-specific and globally unique.
-- Base prefix is first 3 letters of company name (A-Z only), fallback "CMP".
-- Duplicate bases receive deterministic letter suffixes: PAP, PAPA, PAPAA, ...
WITH ranked_companies AS (
  SELECT
    c.id,
    COALESCE(NULLIF(SUBSTRING(REGEXP_REPLACE(UPPER(c.name), '[^A-Z]', '', 'g') FROM 1 FOR 3), ''), 'CMP') AS base_prefix,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(NULLIF(SUBSTRING(REGEXP_REPLACE(UPPER(c.name), '[^A-Z]', '', 'g') FROM 1 FOR 3), ''), 'CMP')
      ORDER BY c.created_at, c.id
    ) AS prefix_rank
  FROM companies c
)
UPDATE companies c
SET issue_prefix = CASE
  WHEN ranked_companies.prefix_rank = 1 THEN ranked_companies.base_prefix
  ELSE ranked_companies.base_prefix || REPEAT('A', (ranked_companies.prefix_rank - 1)::integer)
END
FROM ranked_companies
WHERE c.id = ranked_companies.id;

-- Reassign issue numbers sequentially per company to guarantee uniqueness.
WITH numbered_issues AS (
  SELECT
    i.id,
    ROW_NUMBER() OVER (PARTITION BY i.company_id ORDER BY i.created_at, i.id) AS issue_number
  FROM issues i
)
UPDATE issues i
SET issue_number = numbered_issues.issue_number
FROM numbered_issues
WHERE i.id = numbered_issues.id;

-- Rebuild identifiers from normalized prefix + issue number.
UPDATE issues i
SET identifier = c.issue_prefix || '-' || i.issue_number
FROM companies c
WHERE c.id = i.company_id;

-- Sync counters to the largest issue number currently assigned per company.
UPDATE companies c
SET issue_counter = COALESCE((
  SELECT MAX(i.issue_number)
  FROM issues i
  WHERE i.company_id = c.id
), 0);

CREATE UNIQUE INDEX "companies_issue_prefix_idx" ON "companies" USING btree ("issue_prefix");
CREATE UNIQUE INDEX "issues_identifier_idx" ON "issues" USING btree ("identifier");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('7b8bc0a9c03438b78611e5601cba48222bfbc6fcee08aa9594f172f558b5aa29', 1771883888199);

-- >>> Migration: 0018_flat_sleepwalker.sql <<<
CREATE TABLE "issue_labels" (
	"issue_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_labels_pk" PRIMARY KEY("issue_id","label_id")
);

CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "labels" ADD CONSTRAINT "labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "issue_labels_issue_idx" ON "issue_labels" USING btree ("issue_id");
CREATE INDEX "issue_labels_label_idx" ON "issue_labels" USING btree ("label_id");
CREATE INDEX "issue_labels_company_idx" ON "issue_labels" USING btree ("company_id");
CREATE INDEX "labels_company_idx" ON "labels" USING btree ("company_id");
CREATE UNIQUE INDEX "labels_company_name_idx" ON "labels" USING btree ("company_id","name");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('96712cb18db3f02e74ce33aca6d0a2ae52d7216964387b4e507e705ef07837eb', 1771897769629);

-- >>> Migration: 0019_public_victor_mancha.sql <<<
CREATE TABLE "project_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cwd" text NOT NULL,
	"repo_url" text,
	"repo_ref" text,
	"metadata" jsonb,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "project_workspaces_company_project_idx" ON "project_workspaces" USING btree ("company_id","project_id");
CREATE INDEX "project_workspaces_project_primary_idx" ON "project_workspaces" USING btree ("project_id","is_primary");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('d07a384240e032c84ee5efbf040b12e78b3e670398dd39d5cf0157679b2a5b3a', 1772029333401);

-- >>> Migration: 0020_white_anita_blake.sql <<<
ALTER TABLE "project_workspaces" ALTER COLUMN "cwd" DROP NOT NULL;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2ef0a0fd958cf0c96df485ba8b3fff06dbed85c56a043991231a0d5258eec209', 1772032176413);

-- >>> Migration: 0021_chief_vindicator.sql <<<
ALTER TABLE "issues" ADD COLUMN "assignee_adapter_overrides" jsonb;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e5f5ec21df5031056ed92874dab3c770435ff092e3f8d15e7b07803ff29bf9e5', 1772122471656);

-- >>> Migration: 0022_company_brand_color.sql <<<
ALTER TABLE "companies" ADD COLUMN "brand_color" text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2e627668cc677920c7fd5d02f4532be3e253c9c80790ceb97711792a110122f4', 1772186400000);

-- >>> Migration: 0023_fair_lethal_legion.sql <<<
ALTER TABLE "join_requests" ADD COLUMN "claim_secret_hash" text;
ALTER TABLE "join_requests" ADD COLUMN "claim_secret_expires_at" timestamp with time zone;
ALTER TABLE "join_requests" ADD COLUMN "claim_secret_consumed_at" timestamp with time zone;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('484e5c7d805eb96ea50b7f808bba8df2b9a4120f4e1452a97ae18c9468a1944b', 1772139727599);

-- >>> Migration: 0024_far_beast.sql <<<
CREATE INDEX "issue_comments_company_issue_created_at_idx" ON "issue_comments" USING btree ("company_id","issue_id","created_at");
CREATE INDEX "issue_comments_company_author_issue_created_at_idx" ON "issue_comments" USING btree ("company_id","author_user_id","issue_id","created_at");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('40ff648f3bc91a9a733f070db7e02649633485db4f91eda404f0612a0ab460d6', 1772806603601);

-- >>> Migration: 0025_nasty_salo.sql <<<
CREATE TABLE "issue_read_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "issue_read_states" ADD CONSTRAINT "issue_read_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issue_read_states" ADD CONSTRAINT "issue_read_states_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "issue_read_states_company_issue_idx" ON "issue_read_states" USING btree ("company_id","issue_id");
CREATE INDEX "issue_read_states_company_user_idx" ON "issue_read_states" USING btree ("company_id","user_id");
CREATE UNIQUE INDEX "issue_read_states_company_issue_user_idx" ON "issue_read_states" USING btree ("company_id","issue_id","user_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('eb01d64ec77c03859269e370af4850092fe592944f3cf1fa6ad4695cb0b3ab17', 1772807461603);

-- >>> Migration: 0026_lying_pete_wisdom.sql <<<
CREATE TABLE "workspace_runtime_services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"project_workspace_id" uuid,
	"issue_id" uuid,
	"scope_type" text NOT NULL,
	"scope_id" text,
	"service_name" text NOT NULL,
	"status" text NOT NULL,
	"lifecycle" text NOT NULL,
	"reuse_key" text,
	"command" text,
	"cwd" text,
	"port" integer,
	"url" text,
	"provider" text NOT NULL,
	"provider_ref" text,
	"owner_agent_id" uuid,
	"started_by_run_id" uuid,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"stop_policy" jsonb,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_started_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("started_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "workspace_runtime_services_company_workspace_status_idx" ON "workspace_runtime_services" USING btree ("company_id","project_workspace_id","status");
CREATE INDEX "workspace_runtime_services_company_project_status_idx" ON "workspace_runtime_services" USING btree ("company_id","project_id","status");
CREATE INDEX "workspace_runtime_services_run_idx" ON "workspace_runtime_services" USING btree ("started_by_run_id");
CREATE INDEX "workspace_runtime_services_company_updated_idx" ON "workspace_runtime_services" USING btree ("company_id","updated_at");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('605fae9ea9f92718a263550180e9102dc8f53d58827b236b8c6a3453cb0e9c64', 1773089625430);

-- >>> Migration: 0027_tranquil_tenebrous.sql <<<
ALTER TABLE "issues" ADD COLUMN "execution_workspace_settings" jsonb;
ALTER TABLE "projects" ADD COLUMN "execution_workspace_policy" jsonb;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('d434c7ec995d048f812a74d248e36797eb77e597c9d4b942808f2ee4c53ef3d8', 1773150731736);

-- >>> Migration: 0028_harsh_goliath.sql <<<
CREATE TABLE "document_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"body" text NOT NULL,
	"change_summary" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text,
	"format" text DEFAULT 'markdown' NOT NULL,
	"latest_body" text NOT NULL,
	"latest_revision_id" uuid,
	"latest_revision_number" integer DEFAULT 1 NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "issue_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "documents" ADD CONSTRAINT "documents_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "issue_documents" ADD CONSTRAINT "issue_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issue_documents" ADD CONSTRAINT "issue_documents_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_documents" ADD CONSTRAINT "issue_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "document_revisions_document_revision_uq" ON "document_revisions" USING btree ("document_id","revision_number");
CREATE INDEX "document_revisions_company_document_created_idx" ON "document_revisions" USING btree ("company_id","document_id","created_at");
CREATE INDEX "documents_company_updated_idx" ON "documents" USING btree ("company_id","updated_at");
CREATE INDEX "documents_company_created_idx" ON "documents" USING btree ("company_id","created_at");
CREATE UNIQUE INDEX "issue_documents_company_issue_key_uq" ON "issue_documents" USING btree ("company_id","issue_id","key");
CREATE UNIQUE INDEX "issue_documents_document_uq" ON "issue_documents" USING btree ("document_id");
CREATE INDEX "issue_documents_company_issue_updated_idx" ON "issue_documents" USING btree ("company_id","issue_id","updated_at");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('68a66cce12c03e2e46f84d7a0a282e502b9f9d26e9b452e31b79f6c860928640', 1773432085646);

-- >>> Migration: 0029_plugin_tables.sql <<<
-- Rollback:
--   DROP INDEX IF EXISTS "plugin_logs_level_idx";
--   DROP INDEX IF EXISTS "plugin_logs_plugin_time_idx";
--   DROP INDEX IF EXISTS "plugin_company_settings_company_plugin_uq";
--   DROP INDEX IF EXISTS "plugin_company_settings_plugin_idx";
--   DROP INDEX IF EXISTS "plugin_company_settings_company_idx";
--   DROP INDEX IF EXISTS "plugin_webhook_deliveries_key_idx";
--   DROP INDEX IF EXISTS "plugin_webhook_deliveries_status_idx";
--   DROP INDEX IF EXISTS "plugin_webhook_deliveries_plugin_idx";
--   DROP INDEX IF EXISTS "plugin_job_runs_status_idx";
--   DROP INDEX IF EXISTS "plugin_job_runs_plugin_idx";
--   DROP INDEX IF EXISTS "plugin_job_runs_job_idx";
--   DROP INDEX IF EXISTS "plugin_jobs_unique_idx";
--   DROP INDEX IF EXISTS "plugin_jobs_next_run_idx";
--   DROP INDEX IF EXISTS "plugin_jobs_plugin_idx";
--   DROP INDEX IF EXISTS "plugin_entities_external_idx";
--   DROP INDEX IF EXISTS "plugin_entities_scope_idx";
--   DROP INDEX IF EXISTS "plugin_entities_type_idx";
--   DROP INDEX IF EXISTS "plugin_entities_plugin_idx";
--   DROP INDEX IF EXISTS "plugin_state_plugin_scope_idx";
--   DROP INDEX IF EXISTS "plugin_config_plugin_id_idx";
--   DROP INDEX IF EXISTS "plugins_status_idx";
--   DROP INDEX IF EXISTS "plugins_plugin_key_idx";
--   DROP TABLE IF EXISTS "plugin_logs";
--   DROP TABLE IF EXISTS "plugin_company_settings";
--   DROP TABLE IF EXISTS "plugin_webhook_deliveries";
--   DROP TABLE IF EXISTS "plugin_job_runs";
--   DROP TABLE IF EXISTS "plugin_jobs";
--   DROP TABLE IF EXISTS "plugin_entities";
--   DROP TABLE IF EXISTS "plugin_state";
--   DROP TABLE IF EXISTS "plugin_config";
--   DROP TABLE IF EXISTS "plugins";

CREATE TABLE "plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_key" text NOT NULL,
	"package_name" text NOT NULL,
	"package_path" text,
	"version" text NOT NULL,
	"api_version" integer DEFAULT 1 NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"status" text DEFAULT 'installed' NOT NULL,
	"install_order" integer,
	"last_error" text,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "plugin_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "plugin_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text,
	"namespace" text DEFAULT 'default' NOT NULL,
	"state_key" text NOT NULL,
	"value_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_state_unique_entry_idx" UNIQUE NULLS NOT DISTINCT("plugin_id","scope_kind","scope_id","namespace","state_key")
);

CREATE TABLE "plugin_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text,
	"external_id" text,
	"title" text,
	"status" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "plugin_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"job_key" text NOT NULL,
	"schedule" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "plugin_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_ms" integer,
	"error" text,
	"logs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "plugin_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"webhook_key" text NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_ms" integer,
	"error" text,
	"payload" jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "plugin_company_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);

CREATE TABLE "plugin_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"plugin_id" uuid NOT NULL,
	"level" text NOT NULL DEFAULT 'info',
	"message" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "plugin_config" ADD CONSTRAINT "plugin_config_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plugin_state" ADD CONSTRAINT "plugin_state_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plugin_entities" ADD CONSTRAINT "plugin_entities_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plugin_jobs" ADD CONSTRAINT "plugin_jobs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plugin_job_runs" ADD CONSTRAINT "plugin_job_runs_job_id_plugin_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."plugin_jobs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plugin_job_runs" ADD CONSTRAINT "plugin_job_runs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plugin_webhook_deliveries" ADD CONSTRAINT "plugin_webhook_deliveries_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plugin_company_settings" ADD CONSTRAINT "plugin_company_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plugin_company_settings" ADD CONSTRAINT "plugin_company_settings_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plugin_logs" ADD CONSTRAINT "plugin_logs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "plugins_plugin_key_idx" ON "plugins" USING btree ("plugin_key");
CREATE INDEX "plugins_status_idx" ON "plugins" USING btree ("status");
CREATE UNIQUE INDEX "plugin_config_plugin_id_idx" ON "plugin_config" USING btree ("plugin_id");
CREATE INDEX "plugin_state_plugin_scope_idx" ON "plugin_state" USING btree ("plugin_id","scope_kind");
CREATE INDEX "plugin_entities_plugin_idx" ON "plugin_entities" USING btree ("plugin_id");
CREATE INDEX "plugin_entities_type_idx" ON "plugin_entities" USING btree ("entity_type");
CREATE INDEX "plugin_entities_scope_idx" ON "plugin_entities" USING btree ("scope_kind","scope_id");
CREATE UNIQUE INDEX "plugin_entities_external_idx" ON "plugin_entities" USING btree ("plugin_id","entity_type","external_id");
CREATE INDEX "plugin_jobs_plugin_idx" ON "plugin_jobs" USING btree ("plugin_id");
CREATE INDEX "plugin_jobs_next_run_idx" ON "plugin_jobs" USING btree ("next_run_at");
CREATE UNIQUE INDEX "plugin_jobs_unique_idx" ON "plugin_jobs" USING btree ("plugin_id","job_key");
CREATE INDEX "plugin_job_runs_job_idx" ON "plugin_job_runs" USING btree ("job_id");
CREATE INDEX "plugin_job_runs_plugin_idx" ON "plugin_job_runs" USING btree ("plugin_id");
CREATE INDEX "plugin_job_runs_status_idx" ON "plugin_job_runs" USING btree ("status");
CREATE INDEX "plugin_webhook_deliveries_plugin_idx" ON "plugin_webhook_deliveries" USING btree ("plugin_id");
CREATE INDEX "plugin_webhook_deliveries_status_idx" ON "plugin_webhook_deliveries" USING btree ("status");
CREATE INDEX "plugin_webhook_deliveries_key_idx" ON "plugin_webhook_deliveries" USING btree ("webhook_key");
CREATE INDEX "plugin_company_settings_company_idx" ON "plugin_company_settings" USING btree ("company_id");
CREATE INDEX "plugin_company_settings_plugin_idx" ON "plugin_company_settings" USING btree ("plugin_id");
CREATE UNIQUE INDEX "plugin_company_settings_company_plugin_uq" ON "plugin_company_settings" USING btree ("company_id","plugin_id");
CREATE INDEX "plugin_logs_plugin_time_idx" ON "plugin_logs" USING btree ("plugin_id","created_at");
CREATE INDEX "plugin_logs_level_idx" ON "plugin_logs" USING btree ("level");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('893ff5bd4351dd79a5c51658beac7cbd6c92d1247eb76ac6364c87f763a4c8e2', 1773417600000);

-- >>> Migration: 0030_rich_magneto.sql <<<
CREATE TABLE "company_logos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "company_logos" ADD CONSTRAINT "company_logos_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "company_logos" ADD CONSTRAINT "company_logos_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "company_logos_company_uq" ON "company_logos" USING btree ("company_id");
CREATE UNIQUE INDEX "company_logos_asset_uq" ON "company_logos" USING btree ("asset_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('ec7e4985166e9cb3abcb9ccaabf3d79771e96ccbaaf789028f9e5120044af51a', 1773670925214);

-- >>> Migration: 0031_zippy_magma.sql <<<
CREATE TABLE "finance_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"issue_id" uuid,
	"project_id" uuid,
	"goal_id" uuid,
	"heartbeat_run_id" uuid,
	"cost_event_id" uuid,
	"billing_code" text,
	"description" text,
	"event_kind" text NOT NULL,
	"direction" text DEFAULT 'debit' NOT NULL,
	"biller" text NOT NULL,
	"provider" text,
	"execution_adapter_type" text,
	"pricing_tier" text,
	"region" text,
	"model" text,
	"quantity" integer,
	"unit" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"estimated" boolean DEFAULT false NOT NULL,
	"external_invoice_id" text,
	"metadata_json" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "cost_events" ADD COLUMN "heartbeat_run_id" uuid;
ALTER TABLE "cost_events" ADD COLUMN "biller" text DEFAULT 'unknown' NOT NULL;
ALTER TABLE "cost_events" ADD COLUMN "billing_type" text DEFAULT 'unknown' NOT NULL;
ALTER TABLE "cost_events" ADD COLUMN "cached_input_tokens" integer DEFAULT 0 NOT NULL;
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "finance_events_company_occurred_idx" ON "finance_events" USING btree ("company_id","occurred_at");
CREATE INDEX "finance_events_company_biller_occurred_idx" ON "finance_events" USING btree ("company_id","biller","occurred_at");
CREATE INDEX "finance_events_company_kind_occurred_idx" ON "finance_events" USING btree ("company_id","event_kind","occurred_at");
CREATE INDEX "finance_events_company_direction_occurred_idx" ON "finance_events" USING btree ("company_id","direction","occurred_at");
CREATE INDEX "finance_events_company_heartbeat_run_idx" ON "finance_events" USING btree ("company_id","heartbeat_run_id");
CREATE INDEX "finance_events_company_cost_event_idx" ON "finance_events" USING btree ("company_id","cost_event_id");
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "cost_events_company_provider_occurred_idx" ON "cost_events" USING btree ("company_id","provider","occurred_at");
CREATE INDEX "cost_events_company_biller_occurred_idx" ON "cost_events" USING btree ("company_id","biller","occurred_at");
CREATE INDEX "cost_events_company_heartbeat_run_idx" ON "cost_events" USING btree ("company_id","heartbeat_run_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('7ba5b686d334d3c0efbe6283ed9bb75aab35498c0b1b6fc363716e90b5572256', 1773511922713);

-- >>> Migration: 0032_pretty_doctor_octopus.sql <<<
CREATE TABLE "budget_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"window_kind" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"threshold_type" text NOT NULL,
	"amount_limit" integer NOT NULL,
	"amount_observed" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"approval_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "budget_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"metric" text DEFAULT 'billed_cents' NOT NULL,
	"window_kind" text NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"warn_percent" integer DEFAULT 80 NOT NULL,
	"hard_stop_enabled" boolean DEFAULT true NOT NULL,
	"notify_enabled" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "agents" ADD COLUMN "pause_reason" text;
ALTER TABLE "agents" ADD COLUMN "paused_at" timestamp with time zone;
ALTER TABLE "projects" ADD COLUMN "pause_reason" text;
ALTER TABLE "projects" ADD COLUMN "paused_at" timestamp with time zone;
INSERT INTO "budget_policies" (
	"company_id",
	"scope_type",
	"scope_id",
	"metric",
	"window_kind",
	"amount",
	"warn_percent",
	"hard_stop_enabled",
	"notify_enabled",
	"is_active"
)
SELECT
	"id",
	'company',
	"id",
	'billed_cents',
	'calendar_month_utc',
	"budget_monthly_cents",
	80,
	true,
	true,
	true
FROM "companies"
WHERE "budget_monthly_cents" > 0;
INSERT INTO "budget_policies" (
	"company_id",
	"scope_type",
	"scope_id",
	"metric",
	"window_kind",
	"amount",
	"warn_percent",
	"hard_stop_enabled",
	"notify_enabled",
	"is_active"
)
SELECT
	"company_id",
	'agent',
	"id",
	'billed_cents',
	'calendar_month_utc',
	"budget_monthly_cents",
	80,
	true,
	true,
	true
FROM "agents"
WHERE "budget_monthly_cents" > 0;
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_policy_id_budget_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "budget_policies" ADD CONSTRAINT "budget_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "budget_incidents_company_status_idx" ON "budget_incidents" USING btree ("company_id","status");
CREATE INDEX "budget_incidents_company_scope_idx" ON "budget_incidents" USING btree ("company_id","scope_type","scope_id","status");
CREATE UNIQUE INDEX "budget_incidents_policy_window_threshold_idx" ON "budget_incidents" USING btree ("policy_id","window_start","threshold_type");
CREATE INDEX "budget_policies_company_scope_active_idx" ON "budget_policies" USING btree ("company_id","scope_type","scope_id","is_active");
CREATE INDEX "budget_policies_company_window_idx" ON "budget_policies" USING btree ("company_id","window_kind","metric");
CREATE UNIQUE INDEX "budget_policies_company_scope_metric_unique_idx" ON "budget_policies" USING btree ("company_id","scope_type","scope_id","metric","window_kind");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('cc46d46a7167c57d3373827e6cf79d0807c093e29fb3ad90ac0092b42dd1deaa', 1773542934499);

-- >>> Migration: 0033_shiny_black_tarantula.sql <<<
ALTER TABLE "companies" ADD COLUMN "pause_reason" text;
ALTER TABLE "companies" ADD COLUMN "paused_at" timestamp with time zone;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('d4616d35c778c192e8a46d8b6b5942fd95ede5ed3f8dbc95c276221539fe8b0e', 1773664961967);

-- >>> Migration: 0034_fat_dormammu.sql <<<
DROP INDEX "budget_incidents_policy_window_threshold_idx";
CREATE UNIQUE INDEX "budget_incidents_policy_window_threshold_idx" ON "budget_incidents" USING btree ("policy_id","window_start","threshold_type") WHERE "budget_incidents"."status" <> 'dismissed';

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('b3e8c916f07608ad6ab220df5783c49d6d76e5640042ee1b2a64f8f2dc27189f', 1773697572188);

-- >>> Migration: 0035_marvelous_satana.sql <<<
CREATE TABLE "execution_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_workspace_id" uuid,
	"source_issue_id" uuid,
	"mode" text NOT NULL,
	"strategy_type" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cwd" text,
	"repo_url" text,
	"base_ref" text,
	"branch_name" text,
	"provider_type" text DEFAULT 'local_fs' NOT NULL,
	"provider_ref" text,
	"derived_from_execution_workspace_id" uuid,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"cleanup_eligible_at" timestamp with time zone,
	"cleanup_reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "issue_work_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"issue_id" uuid NOT NULL,
	"execution_workspace_id" uuid,
	"runtime_service_id" uuid,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text,
	"title" text NOT NULL,
	"url" text,
	"status" text NOT NULL,
	"review_state" text DEFAULT 'none' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"summary" text,
	"metadata" jsonb,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "issues" ADD COLUMN "project_workspace_id" uuid;
ALTER TABLE "issues" ADD COLUMN "execution_workspace_id" uuid;
ALTER TABLE "issues" ADD COLUMN "execution_workspace_preference" text;
ALTER TABLE "project_workspaces" ADD COLUMN "source_type" text DEFAULT 'local_path' NOT NULL;
ALTER TABLE "project_workspaces" ADD COLUMN "default_ref" text;
ALTER TABLE "project_workspaces" ADD COLUMN "visibility" text DEFAULT 'default' NOT NULL;
ALTER TABLE "project_workspaces" ADD COLUMN "setup_command" text;
ALTER TABLE "project_workspaces" ADD COLUMN "cleanup_command" text;
ALTER TABLE "project_workspaces" ADD COLUMN "remote_provider" text;
ALTER TABLE "project_workspaces" ADD COLUMN "remote_workspace_ref" text;
ALTER TABLE "project_workspaces" ADD COLUMN "shared_workspace_key" text;
ALTER TABLE "workspace_runtime_services" ADD COLUMN "execution_workspace_id" uuid;
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_derived_from_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("derived_from_execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_runtime_service_id_workspace_runtime_services_id_fk" FOREIGN KEY ("runtime_service_id") REFERENCES "public"."workspace_runtime_services"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "execution_workspaces_company_project_status_idx" ON "execution_workspaces" USING btree ("company_id","project_id","status");
CREATE INDEX "execution_workspaces_company_project_workspace_status_idx" ON "execution_workspaces" USING btree ("company_id","project_workspace_id","status");
CREATE INDEX "execution_workspaces_company_source_issue_idx" ON "execution_workspaces" USING btree ("company_id","source_issue_id");
CREATE INDEX "execution_workspaces_company_last_used_idx" ON "execution_workspaces" USING btree ("company_id","last_used_at");
CREATE INDEX "execution_workspaces_company_branch_idx" ON "execution_workspaces" USING btree ("company_id","branch_name");
CREATE INDEX "issue_work_products_company_issue_type_idx" ON "issue_work_products" USING btree ("company_id","issue_id","type");
CREATE INDEX "issue_work_products_company_execution_workspace_type_idx" ON "issue_work_products" USING btree ("company_id","execution_workspace_id","type");
CREATE INDEX "issue_work_products_company_provider_external_id_idx" ON "issue_work_products" USING btree ("company_id","provider","external_id");
CREATE INDEX "issue_work_products_company_updated_idx" ON "issue_work_products" USING btree ("company_id","updated_at");
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "issues" ADD CONSTRAINT "issues_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "issues_company_project_workspace_idx" ON "issues" USING btree ("company_id","project_workspace_id");
CREATE INDEX "issues_company_execution_workspace_idx" ON "issues" USING btree ("company_id","execution_workspace_id");
CREATE INDEX "project_workspaces_project_source_type_idx" ON "project_workspaces" USING btree ("project_id","source_type");
CREATE INDEX "project_workspaces_company_shared_key_idx" ON "project_workspaces" USING btree ("company_id","shared_workspace_key");
CREATE UNIQUE INDEX "project_workspaces_project_remote_ref_idx" ON "project_workspaces" USING btree ("project_id","remote_provider","remote_workspace_ref");
CREATE INDEX "workspace_runtime_services_company_execution_workspace_status_idx" ON "workspace_runtime_services" USING btree ("company_id","execution_workspace_id","status");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e79ecacc261720c947b887a45b5ed99bd6bab8d924e887fe98336a24e636ca35', 1773698696169);

-- >>> Migration: 0036_cheerful_nitro.sql <<<
CREATE TABLE "instance_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'default' NOT NULL,
	"experimental" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "instance_settings_singleton_key_idx" ON "instance_settings" USING btree ("singleton_key");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f224c54bc3a5cea815854966d5ebab451eecc9fa4d1b9a1880efdf43c424cac4', 1773756213455);

-- >>> Migration: 0037_friendly_eddie_brock.sql <<<
CREATE TABLE "workspace_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"execution_workspace_id" uuid,
	"heartbeat_run_id" uuid,
	"phase" text NOT NULL,
	"command" text,
	"cwd" text,
	"status" text DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"log_store" text,
	"log_ref" text,
	"log_bytes" bigint,
	"log_sha256" text,
	"log_compressed" boolean DEFAULT false NOT NULL,
	"stdout_excerpt" text,
	"stderr_excerpt" text,
	"metadata" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "workspace_operations_company_run_started_idx" ON "workspace_operations" USING btree ("company_id","heartbeat_run_id","started_at");
CREATE INDEX "workspace_operations_company_workspace_started_idx" ON "workspace_operations" USING btree ("company_id","execution_workspace_id","started_at");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('8a8c9b444812583524c2776edac092cb9b8c05ba1ee7fa89241789d9e7a69272', 1773756922363);

-- >>> Migration: 0038_careless_iron_monger.sql <<<
ALTER TABLE "heartbeat_runs" ADD COLUMN "process_pid" integer;
ALTER TABLE "heartbeat_runs" ADD COLUMN "process_started_at" timestamp with time zone;
ALTER TABLE "heartbeat_runs" ADD COLUMN "retry_of_run_id" uuid;
ALTER TABLE "heartbeat_runs" ADD COLUMN "process_loss_retry_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_retry_of_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("retry_of_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('359de5cfcaaaa5f4362f47f158e8a4d97d145896f6052ff118f44e23a2bae6b6', 1773931592563);

-- >>> Migration: 0039_fat_magneto.sql <<<
CREATE TABLE IF NOT EXISTS "routine_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"trigger_id" uuid,
	"source" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text,
	"trigger_payload" jsonb,
	"linked_issue_id" uuid,
	"coalesced_into_run_id" uuid,
	"failure_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "routine_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"cron_expression" text,
	"timezone" text,
	"next_run_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"public_id" text,
	"secret_id" uuid,
	"signing_mode" text,
	"replay_window_sec" integer,
	"last_rotated_at" timestamp with time zone,
	"last_result" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid,
	"parent_issue_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"assignee_agent_id" uuid NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"concurrency_policy" text DEFAULT 'coalesce_if_active' NOT NULL,
	"catch_up_policy" text DEFAULT 'skip_missed' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"last_triggered_at" timestamp with time zone,
	"last_enqueued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "origin_kind" text DEFAULT 'manual' NOT NULL;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "origin_id" text;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "origin_run_id" text;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_runs_company_id_companies_id_fk') THEN
  ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_runs_routine_id_routines_id_fk') THEN
  ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_runs_trigger_id_routine_triggers_id_fk') THEN
  ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_trigger_id_routine_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."routine_triggers"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_runs_linked_issue_id_issues_id_fk') THEN
  ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_triggers_company_id_companies_id_fk') THEN
  ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_triggers_routine_id_routines_id_fk') THEN
  ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_triggers_secret_id_company_secrets_id_fk') THEN
  ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_triggers_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_triggers_updated_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_company_id_companies_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_project_id_projects_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_goal_id_goals_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_parent_issue_id_issues_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_parent_issue_id_issues_id_fk" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_assignee_agent_id_agents_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_updated_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS "routine_runs_company_routine_idx" ON "routine_runs" USING btree ("company_id","routine_id","created_at");
CREATE INDEX IF NOT EXISTS "routine_runs_trigger_idx" ON "routine_runs" USING btree ("trigger_id","created_at");
CREATE INDEX IF NOT EXISTS "routine_runs_linked_issue_idx" ON "routine_runs" USING btree ("linked_issue_id");
CREATE INDEX IF NOT EXISTS "routine_runs_trigger_idempotency_idx" ON "routine_runs" USING btree ("trigger_id","idempotency_key");
CREATE INDEX IF NOT EXISTS "routine_triggers_company_routine_idx" ON "routine_triggers" USING btree ("company_id","routine_id");
CREATE INDEX IF NOT EXISTS "routine_triggers_company_kind_idx" ON "routine_triggers" USING btree ("company_id","kind");
CREATE INDEX IF NOT EXISTS "routine_triggers_next_run_idx" ON "routine_triggers" USING btree ("next_run_at");
CREATE INDEX IF NOT EXISTS "routine_triggers_public_id_idx" ON "routine_triggers" USING btree ("public_id");
CREATE INDEX IF NOT EXISTS "routines_company_status_idx" ON "routines" USING btree ("company_id","status");
CREATE INDEX IF NOT EXISTS "routines_company_assignee_idx" ON "routines" USING btree ("company_id","assignee_agent_id");
CREATE INDEX IF NOT EXISTS "routines_company_project_idx" ON "routines" USING btree ("company_id","project_id");
CREATE INDEX IF NOT EXISTS "issues_company_origin_idx" ON "issues" USING btree ("company_id","origin_kind","origin_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('dd1854c43854dd238055dc6ed9bcd5b06f43feebc0fbb8306766e7292f19bc04', 1773926116580);

-- >>> Migration: 0040_eager_shotgun.sql <<<
CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_routine_execution_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'routine_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');
CREATE UNIQUE INDEX IF NOT EXISTS "routine_triggers_public_id_uq" ON "routine_triggers" USING btree ("public_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('0b14055c4f5617b8b944b8e15d51472cd919be335881aa63f942677ad19c56ec', 1773927102783);

-- >>> Migration: 0041_curly_maria_hill.sql <<<
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "general" jsonb DEFAULT '{}'::jsonb NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('5bd65ef2947bd724b0ae5495db4527f4f191225a5fb425925f79294ebce7a03c', 1774011294562);

-- >>> Migration: 0042_spotty_the_renegades.sql <<<
CREATE TABLE IF NOT EXISTS "company_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"markdown" text NOT NULL,
	"source_type" text DEFAULT 'local_path' NOT NULL,
	"source_locator" text,
	"source_ref" text,
	"trust_level" text DEFAULT 'markdown_only' NOT NULL,
	"compatibility" text DEFAULT 'compatible' NOT NULL,
	"file_inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_skills_company_id_companies_id_fk') THEN
  ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "company_skills_company_key_idx" ON "company_skills" USING btree ("company_id","key");
CREATE INDEX IF NOT EXISTS "company_skills_company_name_idx" ON "company_skills" USING btree ("company_id","name");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('3772e9aada1d394b95cc588ac8e3756da7a5f57fcad8e9f661f96b4303820f53', 1774031825634);

-- >>> Migration: 0043_reflective_captain_universe.sql <<<
DROP INDEX IF EXISTS "issues_open_routine_execution_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_routine_execution_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'routine_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."execution_run_id" is not null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e1119e9fdc94b36a0d77f806980a6d987b2d2e75b299727d1a5b02c9f8de03c8', 1774008910991);

-- >>> Migration: 0044_illegal_toad.sql <<<
CREATE TABLE IF NOT EXISTS "board_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "cli_auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_hash" text NOT NULL,
	"command" text NOT NULL,
	"client_name" text,
	"requested_access" text DEFAULT 'board' NOT NULL,
	"requested_company_id" uuid,
	"pending_key_hash" text NOT NULL,
	"pending_key_name" text NOT NULL,
	"approved_by_user_id" text,
	"board_api_key_id" uuid,
	"approved_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "general" jsonb DEFAULT '{}'::jsonb NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'board_api_keys_user_id_user_id_fk') THEN
  ALTER TABLE "board_api_keys" ADD CONSTRAINT "board_api_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cli_auth_challenges_requested_company_id_companies_id_fk') THEN
  ALTER TABLE "cli_auth_challenges" ADD CONSTRAINT "cli_auth_challenges_requested_company_id_companies_id_fk" FOREIGN KEY ("requested_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cli_auth_challenges_approved_by_user_id_user_id_fk') THEN
  ALTER TABLE "cli_auth_challenges" ADD CONSTRAINT "cli_auth_challenges_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cli_auth_challenges_board_api_key_id_board_api_keys_id_fk') THEN
  ALTER TABLE "cli_auth_challenges" ADD CONSTRAINT "cli_auth_challenges_board_api_key_id_board_api_keys_id_fk" FOREIGN KEY ("board_api_key_id") REFERENCES "public"."board_api_keys"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DROP INDEX IF EXISTS "board_api_keys_key_hash_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "board_api_keys_key_hash_idx" ON "board_api_keys" USING btree ("key_hash");
CREATE INDEX IF NOT EXISTS "board_api_keys_user_idx" ON "board_api_keys" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "cli_auth_challenges_secret_hash_idx" ON "cli_auth_challenges" USING btree ("secret_hash");
CREATE INDEX IF NOT EXISTS "cli_auth_challenges_approved_by_idx" ON "cli_auth_challenges" USING btree ("approved_by_user_id");
CREATE INDEX IF NOT EXISTS "cli_auth_challenges_requested_company_idx" ON "cli_auth_challenges" USING btree ("requested_company_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('d0dda5d7787eff4aefe1ece4e6d25b7947acd08c95e80fa34b170fd1474a04ab', 1774269579794);

-- >>> Migration: 0045_workable_shockwave.sql <<<
CREATE TABLE "issue_inbox_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DROP INDEX "board_api_keys_key_hash_idx";
ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "issue_inbox_archives_company_issue_idx" ON "issue_inbox_archives" USING btree ("company_id","issue_id");
CREATE INDEX "issue_inbox_archives_company_user_idx" ON "issue_inbox_archives" USING btree ("company_id","user_id");
CREATE UNIQUE INDEX "issue_inbox_archives_company_issue_user_idx" ON "issue_inbox_archives" USING btree ("company_id","issue_id","user_id");
CREATE UNIQUE INDEX "board_api_keys_key_hash_idx" ON "board_api_keys" USING btree ("key_hash");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('fe897560c8d543587b37891f0b422b7c334ed9a6a10355c86bd4fbce566c5454', 1774530504348);

-- >>> Migration: 0046_smooth_sentinels.sql <<<
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "format" text;
ALTER TABLE "document_revisions" ALTER COLUMN "format" SET DEFAULT 'markdown';

UPDATE "document_revisions" AS "dr"
SET
  "title" = COALESCE("dr"."title", "d"."title"),
  "format" = COALESCE("dr"."format", "d"."format", 'markdown')
FROM "documents" AS "d"
WHERE "d"."id" = "dr"."document_id";
ALTER TABLE "document_revisions" ALTER COLUMN "format" SET NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('278631f7fd69ff46fd4d0b54c876fa81b317f7409c25790adb05c910b9a1dad7', 1774960197878);

-- >>> Migration: 0047_overjoyed_groot.sql <<<
CREATE TABLE IF NOT EXISTS "feedback_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"feedback_vote_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"project_id" uuid,
	"author_user_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"vote" text NOT NULL,
	"status" text DEFAULT 'local_only' NOT NULL,
	"destination" text,
	"export_id" text,
	"consent_version" text,
	"schema_version" text DEFAULT 'paperclip-feedback-envelope-v2' NOT NULL,
	"bundle_version" text DEFAULT 'paperclip-feedback-bundle-v2' NOT NULL,
	"payload_version" text DEFAULT 'paperclip-feedback-v1' NOT NULL,
	"payload_digest" text,
	"payload_snapshot" jsonb,
	"target_summary" jsonb NOT NULL,
	"redaction_summary" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"exported_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "feedback_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"vote" text NOT NULL,
	"reason" text,
	"shared_with_labs" boolean DEFAULT false NOT NULL,
	"shared_at" timestamp with time zone,
	"consent_version" text,
	"redaction_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "feedback_data_sharing_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "feedback_data_sharing_consent_at" timestamp with time zone;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "feedback_data_sharing_consent_by_user_id" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "feedback_data_sharing_terms_version" text;
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "created_by_run_id" uuid;
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "created_by_run_id" uuid;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feedback_exports_company_id_companies_id_fk') THEN
  ALTER TABLE "feedback_exports" ADD CONSTRAINT "feedback_exports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feedback_exports_feedback_vote_id_feedback_votes_id_fk') THEN
  ALTER TABLE "feedback_exports" ADD CONSTRAINT "feedback_exports_feedback_vote_id_feedback_votes_id_fk" FOREIGN KEY ("feedback_vote_id") REFERENCES "public"."feedback_votes"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feedback_exports_issue_id_issues_id_fk') THEN
  ALTER TABLE "feedback_exports" ADD CONSTRAINT "feedback_exports_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feedback_exports_project_id_projects_id_fk') THEN
  ALTER TABLE "feedback_exports" ADD CONSTRAINT "feedback_exports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feedback_votes_company_id_companies_id_fk') THEN
  ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feedback_votes_issue_id_issues_id_fk') THEN
  ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "feedback_exports_feedback_vote_idx" ON "feedback_exports" USING btree ("feedback_vote_id");
CREATE INDEX IF NOT EXISTS "feedback_exports_company_created_idx" ON "feedback_exports" USING btree ("company_id","created_at");
CREATE INDEX IF NOT EXISTS "feedback_exports_company_status_idx" ON "feedback_exports" USING btree ("company_id","status","created_at");
CREATE INDEX IF NOT EXISTS "feedback_exports_company_issue_idx" ON "feedback_exports" USING btree ("company_id","issue_id","created_at");
CREATE INDEX IF NOT EXISTS "feedback_exports_company_project_idx" ON "feedback_exports" USING btree ("company_id","project_id","created_at");
CREATE INDEX IF NOT EXISTS "feedback_exports_company_author_idx" ON "feedback_exports" USING btree ("company_id","author_user_id","created_at");
CREATE INDEX IF NOT EXISTS "feedback_votes_company_issue_idx" ON "feedback_votes" USING btree ("company_id","issue_id");
CREATE INDEX IF NOT EXISTS "feedback_votes_issue_target_idx" ON "feedback_votes" USING btree ("issue_id","target_type","target_id");
CREATE INDEX IF NOT EXISTS "feedback_votes_author_idx" ON "feedback_votes" USING btree ("author_user_id","created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "feedback_votes_company_target_author_idx" ON "feedback_votes" USING btree ("company_id","target_type","target_id","author_user_id");
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_revisions_created_by_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_comments_created_by_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('31ef6263f4dde97af16f2fbcf520646883295cc852213cfb99062eb504d349f9', 1775137972687);

-- >>> Migration: 0048_flashy_marrow.sql <<<
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "variables" jsonb DEFAULT '[]'::jsonb NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('5b6c43f3d2b5fa8a1998cbf14bcbf6ee0c5067317d539e20b13b6487d48b8d42', 1775145655557);

-- >>> Migration: 0049_flawless_abomination.sql <<<
CREATE TABLE "issue_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"related_issue_id" uuid NOT NULL,
	"type" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_type_check" CHECK ("type" IN ('blocks'));
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_related_issue_id_issues_id_fk" FOREIGN KEY ("related_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "issue_relations_company_issue_idx" ON "issue_relations" USING btree ("company_id","issue_id");
CREATE INDEX "issue_relations_company_related_issue_idx" ON "issue_relations" USING btree ("company_id","related_issue_id");
CREATE INDEX "issue_relations_company_type_idx" ON "issue_relations" USING btree ("company_id","type");
CREATE UNIQUE INDEX "issue_relations_company_edge_uq" ON "issue_relations" USING btree ("company_id","issue_id","related_issue_id","type");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('7d25e72a806b086a94e6f548e764a7393f1e4d917c9afcee4d051e54643028fc', 1775349863293);

-- >>> Migration: 0050_stiff_luckman.sql <<<
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "env" jsonb;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('0432fd6dda492288eea238a155ffb46e146bbe55efac99ab81a99a290bb528fb', 1775487782768);

-- >>> Migration: 0051_young_korg.sql <<<
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "issue_comments_body_search_idx" ON "issue_comments" USING gin ("body" gin_trgm_ops);
CREATE INDEX "issues_title_search_idx" ON "issues" USING gin ("title" gin_trgm_ops);
CREATE INDEX "issues_identifier_search_idx" ON "issues" USING gin ("identifier" gin_trgm_ops);
CREATE INDEX "issues_description_search_idx" ON "issues" USING gin ("description" gin_trgm_ops);


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('b6467b62ce525d470df92b97b0678c2568ae9d1ba8e6ca9d8a48ca2597899501', 1775524651831);

-- >>> Migration: 0052_mushy_trauma.sql <<<
CREATE TABLE "issue_execution_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"stage_type" text NOT NULL,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"outcome" text NOT NULL,
	"body" text NOT NULL,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "heartbeat_runs" ADD COLUMN "issue_comment_status" text DEFAULT 'not_applicable' NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN "issue_comment_satisfied_by_comment_id" uuid;
ALTER TABLE "heartbeat_runs" ADD COLUMN "issue_comment_retry_queued_at" timestamp with time zone;
ALTER TABLE "issues" ADD COLUMN "execution_policy" jsonb;
ALTER TABLE "issues" ADD COLUMN "execution_state" jsonb;
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "issue_execution_decisions_company_issue_idx" ON "issue_execution_decisions" USING btree ("company_id","issue_id");
CREATE INDEX "issue_execution_decisions_stage_idx" ON "issue_execution_decisions" USING btree ("issue_id","stage_id","created_at");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('27fb10df284e95ecdf9e4029efa4df1a3b381b4073b9eeffb59b53cf4abc8c48', 1775571715162);

-- >>> Migration: 0053_sharp_wild_child.sql <<<
CREATE TABLE IF NOT EXISTS "inbox_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"item_key" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "inbox_dismissals" ADD CONSTRAINT "inbox_dismissals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "inbox_dismissals_company_user_idx" ON "inbox_dismissals" USING btree ("company_id","user_id");
CREATE INDEX IF NOT EXISTS "inbox_dismissals_company_item_idx" ON "inbox_dismissals" USING btree ("company_id","item_key");
CREATE UNIQUE INDEX IF NOT EXISTS "inbox_dismissals_company_user_item_idx" ON "inbox_dismissals" USING btree ("company_id","user_id","item_key");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f8ec8fad6aa7bca5068720c2f0a4ea74efbafc40f53ad709fd31b8727412457c', 1775604018515);

-- >>> Migration: 0054_draft_routines.sql <<<
ALTER TABLE "routines" ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "routines" ALTER COLUMN "assignee_agent_id" DROP NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f21d1da197bb83eced58f6074e9ac74e003b266afd51eac0cfafe0c2083af1e8', 1775750400000);

-- >>> Migration: 0055_kind_weapon_omega.sql <<<
ALTER TABLE "heartbeat_runs" ADD COLUMN "process_group_id" integer;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('d7b227b28f8ea3621cedcee0ec46d06203a9a75872dd48d181bcf8eef8d7cec7', 1775825256196);

-- >>> Migration: 0056_spooky_ultragirl.sql <<<
CREATE TABLE "company_user_sidebar_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"project_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "user_sidebar_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"company_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "company_user_sidebar_preferences" ADD CONSTRAINT "company_user_sidebar_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "company_user_sidebar_preferences_company_idx" ON "company_user_sidebar_preferences" USING btree ("company_id");
CREATE INDEX "company_user_sidebar_preferences_user_idx" ON "company_user_sidebar_preferences" USING btree ("user_id");
CREATE UNIQUE INDEX "company_user_sidebar_preferences_company_user_uq" ON "company_user_sidebar_preferences" USING btree ("company_id","user_id");
CREATE UNIQUE INDEX "user_sidebar_preferences_user_uq" ON "user_sidebar_preferences" USING btree ("user_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f305ae7da5d1b5df1701152ef2fe9b200cc7c1c50814c08cc274ca1e9d9a150b', 1776084034244);

-- >>> Migration: 0057_tidy_join_requests.sql <<<
WITH ranked_user_requests AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, requesting_user_id
      ORDER BY created_at ASC, id ASC
    ) AS rank
  FROM join_requests
  WHERE request_type = 'human'
    AND status = 'pending_approval'
    AND requesting_user_id IS NOT NULL
)
UPDATE join_requests
SET
  status = 'rejected',
  rejected_at = COALESCE(rejected_at, now()),
  updated_at = now()
WHERE id IN (
  SELECT id
  FROM ranked_user_requests
  WHERE rank > 1
);

WITH ranked_email_requests AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, lower(request_email_snapshot)
      ORDER BY created_at ASC, id ASC
    ) AS rank
  FROM join_requests
  WHERE request_type = 'human'
    AND status = 'pending_approval'
    AND request_email_snapshot IS NOT NULL
)
UPDATE join_requests
SET
  status = 'rejected',
  rejected_at = COALESCE(rejected_at, now()),
  updated_at = now()
WHERE id IN (
  SELECT id
  FROM ranked_email_requests
  WHERE rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "join_requests_pending_human_user_uq"
ON "join_requests" USING btree ("company_id", "requesting_user_id")
WHERE "request_type" = 'human'
  AND "status" = 'pending_approval'
  AND "requesting_user_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "join_requests_pending_human_email_uq"
ON "join_requests" USING btree ("company_id", lower("request_email_snapshot"))
WHERE "request_type" = 'human'
  AND "status" = 'pending_approval'
  AND "request_email_snapshot" IS NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('cb435f82a01b567b72e27ceed83e3049502a2b284a08cfd32275e912c2f51741', 1776309613598);

-- >>> Migration: 0058_wealthy_starbolt.sql <<<
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "liveness_state" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "liveness_reason" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "continuation_attempt" integer DEFAULT 0 NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_useful_action_at" timestamp with time zone;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "next_action" text;
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_liveness_idx" ON "heartbeat_runs" USING btree ("company_id","liveness_state","created_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f0b1525c737e32381bb9f5bef42751a08703b3e5cbf67128a13bd4de342bfcfe', 1776542245004);

-- >>> Migration: 0059_plugin_database_namespaces.sql <<<
CREATE TABLE IF NOT EXISTS "plugin_database_namespaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"namespace_name" text NOT NULL,
	"namespace_mode" text DEFAULT 'schema' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "plugin_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"namespace_name" text NOT NULL,
	"migration_key" text NOT NULL,
	"checksum" text NOT NULL,
	"plugin_version" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"error_message" text
);

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugin_database_namespaces_plugin_id_plugins_id_fk') THEN
  ALTER TABLE "plugin_database_namespaces" ADD CONSTRAINT "plugin_database_namespaces_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugin_migrations_plugin_id_plugins_id_fk') THEN
  ALTER TABLE "plugin_migrations" ADD CONSTRAINT "plugin_migrations_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_database_namespaces_plugin_idx" ON "plugin_database_namespaces" USING btree ("plugin_id");
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_database_namespaces_namespace_idx" ON "plugin_database_namespaces" USING btree ("namespace_name");
CREATE INDEX IF NOT EXISTS "plugin_database_namespaces_status_idx" ON "plugin_database_namespaces" USING btree ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_migrations_plugin_key_idx" ON "plugin_migrations" USING btree ("plugin_id","migration_key");
CREATE INDEX IF NOT EXISTS "plugin_migrations_plugin_idx" ON "plugin_migrations" USING btree ("plugin_id");
CREATE INDEX IF NOT EXISTS "plugin_migrations_status_idx" ON "plugin_migrations" USING btree ("status");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('578ea35e2a3c828dec0c666305b59aaf6f16035be160a53a4bfc6d4b7eb7ad83', 1776542246000);

-- >>> Migration: 0060_orange_annihilus.sql <<<
CREATE TABLE IF NOT EXISTS "issue_reference_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"target_issue_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_record_id" uuid,
	"document_key" text,
	"matched_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_reference_mentions_company_id_companies_id_fk') THEN
  ALTER TABLE "issue_reference_mentions" ADD CONSTRAINT "issue_reference_mentions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_reference_mentions_source_issue_id_issues_id_fk') THEN
  ALTER TABLE "issue_reference_mentions" ADD CONSTRAINT "issue_reference_mentions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_reference_mentions_target_issue_id_issues_id_fk') THEN
  ALTER TABLE "issue_reference_mentions" ADD CONSTRAINT "issue_reference_mentions_target_issue_id_issues_id_fk" FOREIGN KEY ("target_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS "issue_reference_mentions_company_source_issue_idx" ON "issue_reference_mentions" USING btree ("company_id","source_issue_id");
CREATE INDEX IF NOT EXISTS "issue_reference_mentions_company_target_issue_idx" ON "issue_reference_mentions" USING btree ("company_id","target_issue_id");
CREATE INDEX IF NOT EXISTS "issue_reference_mentions_company_issue_pair_idx" ON "issue_reference_mentions" USING btree ("company_id","source_issue_id","target_issue_id");
DELETE FROM "issue_reference_mentions"
WHERE "id" IN (
	SELECT "id"
	FROM (
		SELECT
			"id",
			row_number() OVER (
				PARTITION BY "company_id", "source_issue_id", "target_issue_id", "source_kind", "source_record_id"
				ORDER BY "created_at", "id"
			) AS "row_number"
		FROM "issue_reference_mentions"
	) AS "duplicates"
	WHERE "duplicates"."row_number" > 1
);
DROP INDEX IF EXISTS "issue_reference_mentions_company_source_mention_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "issue_reference_mentions_company_source_mention_record_uq" ON "issue_reference_mentions" USING btree ("company_id","source_issue_id","target_issue_id","source_kind","source_record_id") WHERE "source_record_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "issue_reference_mentions_company_source_mention_null_record_uq" ON "issue_reference_mentions" USING btree ("company_id","source_issue_id","target_issue_id","source_kind") WHERE "source_record_id" IS NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('a1467b361ef79eb72a49d9474111775b2baaec62d86f98591c239658250e4c15', 1776717606743);

-- >>> Migration: 0061_lively_thor_girl.sql <<<
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "scheduled_retry_at" timestamp with time zone;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "scheduled_retry_attempt" integer DEFAULT 0 NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "scheduled_retry_reason" text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('da9b4301a9d02f5f44d173c595341d5a651b7a176837118d48df4ce5cd603b23', 1776785165389);

-- >>> Migration: 0062_routine_run_dispatch_fingerprint.sql <<<
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "dispatch_fingerprint" text;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "origin_fingerprint" text DEFAULT 'default' NOT NULL;
DROP INDEX IF EXISTS "issues_open_routine_execution_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_routine_execution_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id","origin_fingerprint") WHERE "issues"."origin_kind" = 'routine_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."execution_run_id" is not null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');
CREATE INDEX IF NOT EXISTS "routine_runs_dispatch_fingerprint_idx" ON "routine_runs" USING btree ("routine_id","dispatch_fingerprint");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('7ccc4880585927e45a2100c9faf0be169f198859e9ccb48102d8cf430138cc9c', 1776780000000);

-- >>> Migration: 0063_issue_thread_interactions.sql <<<
CREATE TABLE IF NOT EXISTS "issue_thread_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"continuation_policy" text DEFAULT 'wake_assignee' NOT NULL,
	"source_comment_id" uuid,
	"source_run_id" uuid,
	"title" text,
	"summary" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"resolved_by_agent_id" uuid,
	"resolved_by_user_id" text,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_thread_interactions_company_id_companies_id_fk') THEN
  ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_thread_interactions_issue_id_issues_id_fk') THEN
  ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_thread_interactions_source_comment_id_issue_comments_id_fk') THEN
  ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_source_comment_id_issue_comments_id_fk" FOREIGN KEY ("source_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_thread_interactions_source_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_thread_interactions_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_thread_interactions_resolved_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;

CREATE INDEX IF NOT EXISTS "issue_thread_interactions_issue_idx" ON "issue_thread_interactions" USING btree ("issue_id");

CREATE INDEX IF NOT EXISTS "issue_thread_interactions_company_issue_created_at_idx" ON "issue_thread_interactions" USING btree ("company_id","issue_id","created_at");

CREATE INDEX IF NOT EXISTS "issue_thread_interactions_company_issue_status_idx" ON "issue_thread_interactions" USING btree ("company_id","issue_id","status");

CREATE INDEX IF NOT EXISTS "issue_thread_interactions_source_comment_idx" ON "issue_thread_interactions" USING btree ("source_comment_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('a5859c4305fdf8719d4d1949d44e7029242286efb46a7ba7c4e5c5343d77ade3', 1776780001000);

-- >>> Migration: 0064_issue_thread_interaction_idempotency.sql <<<
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
CREATE UNIQUE INDEX IF NOT EXISTS "issue_thread_interactions_company_issue_idempotency_uq"
  ON "issue_thread_interactions" USING btree ("company_id","issue_id","idempotency_key")
  WHERE "issue_thread_interactions"."idempotency_key" IS NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('9e32e1e4a4dbd752ff087f5672de594668c3485553262a80257ca480286170fb', 1776780002000);

-- >>> Migration: 0065_environments.sql <<<
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"driver" text DEFAULT 'local' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "environment_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"execution_workspace_id" uuid,
	"issue_id" uuid,
	"heartbeat_run_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"lease_policy" text DEFAULT 'ephemeral' NOT NULL,
	"provider" text,
	"provider_lease_id" text,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"failure_reason" text,
	"cleanup_status" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "environments" ADD CONSTRAINT "environments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "environments_company_status_idx" ON "environments" USING btree ("company_id","status");
CREATE UNIQUE INDEX "environments_company_driver_idx" ON "environments" USING btree ("company_id","driver");
CREATE INDEX "environments_company_name_idx" ON "environments" USING btree ("company_id","name");
CREATE INDEX "environment_leases_company_environment_status_idx" ON "environment_leases" USING btree ("company_id","environment_id","status");
CREATE INDEX "environment_leases_company_execution_workspace_idx" ON "environment_leases" USING btree ("company_id","execution_workspace_id");
CREATE INDEX "environment_leases_company_issue_idx" ON "environment_leases" USING btree ("company_id","issue_id");
CREATE INDEX "environment_leases_heartbeat_run_idx" ON "environment_leases" USING btree ("heartbeat_run_id");
CREATE INDEX "environment_leases_company_last_used_idx" ON "environment_leases" USING btree ("company_id","last_used_at");
CREATE INDEX "environment_leases_provider_lease_idx" ON "environment_leases" USING btree ("provider_lease_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('280988e07dea328fe9815cb8c80dd16691ac1427ff9069cd2118038d4b2bb5cc', 1776903900000);

-- >>> Migration: 0066_issue_tree_holds.sql <<<
CREATE TABLE IF NOT EXISTS "issue_tree_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"root_issue_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"release_policy" jsonb,
	"created_by_actor_type" text DEFAULT 'system' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"released_at" timestamp with time zone,
	"released_by_actor_type" text,
	"released_by_agent_id" uuid,
	"released_by_user_id" text,
	"released_by_run_id" uuid,
	"release_reason" text,
	"release_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "issue_tree_hold_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"parent_issue_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"issue_identifier" text,
	"issue_title" text NOT NULL,
	"issue_status" text NOT NULL,
	"assignee_agent_id" uuid,
	"assignee_user_id" text,
	"active_run_id" uuid,
	"active_run_status" text,
	"skipped" boolean DEFAULT false NOT NULL,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_tree_holds_company_id_companies_id_fk') THEN
  ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_tree_holds_root_issue_id_issues_id_fk') THEN
  ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_root_issue_id_issues_id_fk" FOREIGN KEY ("root_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_tree_holds_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_tree_holds_created_by_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_tree_holds_released_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_released_by_agent_id_agents_id_fk" FOREIGN KEY ("released_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_tree_holds_released_by_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_released_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("released_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_tree_hold_members_company_id_companies_id_fk') THEN
  ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_tree_hold_members_hold_id_issue_tree_holds_id_fk') THEN
  ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_hold_id_issue_tree_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."issue_tree_holds"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_tree_hold_members_issue_id_issues_id_fk') THEN
  ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_tree_hold_members_parent_issue_id_issues_id_fk') THEN
  ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_parent_issue_id_issues_id_fk" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_tree_hold_members_assignee_agent_id_agents_id_fk') THEN
  ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_tree_hold_members_active_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_active_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS "issue_tree_holds_company_root_status_idx" ON "issue_tree_holds" USING btree ("company_id","root_issue_id","status");
CREATE INDEX IF NOT EXISTS "issue_tree_holds_company_status_mode_idx" ON "issue_tree_holds" USING btree ("company_id","status","mode");
CREATE UNIQUE INDEX IF NOT EXISTS "issue_tree_hold_members_hold_issue_uq" ON "issue_tree_hold_members" USING btree ("hold_id","issue_id");
CREATE INDEX IF NOT EXISTS "issue_tree_hold_members_company_issue_idx" ON "issue_tree_hold_members" USING btree ("company_id","issue_id");
CREATE INDEX IF NOT EXISTS "issue_tree_hold_members_hold_depth_idx" ON "issue_tree_hold_members" USING btree ("hold_id","depth");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('1a5aadd183ecaf557ee23801ceb9725a6d56dab78a4e4df539280b551ed82ef1', 1776903901000);

-- >>> Migration: 0067_agent_default_environment.sql <<<
ALTER TABLE "agents" ADD COLUMN "default_environment_id" uuid;
ALTER TABLE "agents" ADD CONSTRAINT "agents_default_environment_id_environments_id_fk" FOREIGN KEY ("default_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "agents_company_default_environment_idx" ON "agents" USING btree ("company_id","default_environment_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('a1e43ea1a68770252d36ff1a5c00e660dcbea2a05222559ab3d6b4ca84ed2ea9', 1776904200000);

-- >>> Migration: 0068_environment_local_driver_unique.sql <<<
DROP INDEX IF EXISTS "environments_company_driver_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "environments_company_driver_idx" ON "environments" USING btree ("company_id","driver") WHERE "driver" = 'local';


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('bbcbf800852e0e8f992db48b4653af73cd0478e494cbb71439f0ad664cc12cb8', 1776959400000);

-- >>> Migration: 0069_liveness_recovery_dedupe.sql <<<
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_liveness_recovery_incident_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "origin_kind" = 'harness_liveness_escalation'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');

CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_liveness_recovery_leaf_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_fingerprint")
  WHERE "origin_kind" = 'harness_liveness_escalation'
    AND "origin_fingerprint" <> 'default'
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('fbc93ff9b93ad70bafe93cc44ac231ef73a6ea91983a4ab2e1b128ea9f8bd4a1', 1776780003000);

-- >>> Migration: 0070_active_run_output_watchdog.sql <<<
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_at" timestamp with time zone;

ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_seq" integer DEFAULT 0 NOT NULL;

ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_stream" text;

ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_bytes" bigint;

CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_status_last_output_idx"
  ON "heartbeat_runs" USING btree ("company_id","status","last_output_at");

CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_status_process_started_idx"
  ON "heartbeat_runs" USING btree ("company_id","status","process_started_at");

CREATE TABLE IF NOT EXISTS "heartbeat_run_watchdog_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "evaluation_issue_id" uuid,
  "decision" text NOT NULL,
  "snoozed_until" timestamp with time zone,
  "reason" text,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_by_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_evaluation_issue_id_issues_id_fk" FOREIGN KEY ("evaluation_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "heartbeat_run_watchdog_decisions_company_run_created_idx"
  ON "heartbeat_run_watchdog_decisions" USING btree ("company_id","run_id","created_at");

CREATE INDEX IF NOT EXISTS "heartbeat_run_watchdog_decisions_company_run_snooze_idx"
  ON "heartbeat_run_watchdog_decisions" USING btree ("company_id","run_id","snoozed_until");

CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_stale_run_evaluation_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "origin_kind" = 'stale_active_run_evaluation'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('132aaa7a1ce516b815c26985a390ef78a1632730b939f82543fa8ea0e7b0246f', 1776780004000);

-- >>> Migration: 0071_default_hire_approval_off.sql <<<
ALTER TABLE "companies" ALTER COLUMN "require_board_approval_for_new_agents" SET DEFAULT false;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('3b19e1d26124a927d13adc090864357667e3d73dac33a85594fe7bb0fdc610e9', 1777131234000);

-- >>> Migration: 0072_large_sandman.sql <<<
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_stranded_issue_recovery_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "origin_kind" = 'stranded_issue_recovery'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('008c2aab9a0e319f61018f2e7b4748e1454e24fa974eb404692fb6f4eac17cec', 1777305216238);

-- >>> Migration: 0073_shiny_salo.sql <<<
ALTER TABLE "companies" ADD COLUMN "attachment_max_bytes" integer DEFAULT 10485760 NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('cc105a068340f86984758d5b012343d7bfb3bf85fc636d93381361ef6f88270f', 1777382021347);

-- >>> Migration: 0074_striped_genesis.sql <<<
CREATE UNIQUE INDEX "issues_active_productivity_review_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'issue_productivity_review'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."status" not in ('done', 'cancelled');


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('5b4f58288af4351b14fce3e066255d8075e7a5a9732638b3038c910ecee00866', 1777384535070);

-- >>> Migration: 0075_cultured_sebastian_shaw.sql <<<
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_next_check_at" timestamp with time zone;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_wake_requested_at" timestamp with time zone;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_last_triggered_at" timestamp with time zone;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_attempt_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_notes" text;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_scheduled_by" text;
CREATE INDEX IF NOT EXISTS "issues_company_monitor_due_idx" ON "issues" USING btree ("company_id","monitor_next_check_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('dc1f8c66a5088068819954aadff948e5bde26b2d7c3222f27f0ebb649639f144', 1777572332006);

-- >>> Migration: 0076_useful_elektra.sql <<<
CREATE TABLE IF NOT EXISTS "plugin_managed_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_key" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"defaults_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "plugin_managed_resources" ADD CONSTRAINT "plugin_managed_resources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "plugin_managed_resources" ADD CONSTRAINT "plugin_managed_resources_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "plugin_managed_resources_company_idx" ON "plugin_managed_resources" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "plugin_managed_resources_plugin_idx" ON "plugin_managed_resources" USING btree ("plugin_id");
CREATE INDEX IF NOT EXISTS "plugin_managed_resources_resource_idx" ON "plugin_managed_resources" USING btree ("resource_kind","resource_id");
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_managed_resources_company_plugin_resource_uq" ON "plugin_managed_resources" USING btree ("company_id","plugin_id","resource_kind","resource_key");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('601931acc7e344c9738f4ff52a64f9aae544c9c60c4292eb73e6fff5cd916f12', 1777675301279);

-- >>> Migration: 0077_unusual_karnak.sql <<<
CREATE TABLE IF NOT EXISTS "routine_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"snapshot" jsonb NOT NULL,
	"change_summary" text,
	"restored_from_revision_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "latest_revision_id" uuid;
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "latest_revision_number" integer DEFAULT 1 NOT NULL;
DO $$ BEGIN
	ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_restored_from_revision_id_routine_revisions_id_fk" FOREIGN KEY ("restored_from_revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "routine_revisions_routine_revision_uq" ON "routine_revisions" USING btree ("routine_id","revision_number");
CREATE INDEX IF NOT EXISTS "routine_revisions_company_routine_created_idx" ON "routine_revisions" USING btree ("company_id","routine_id","created_at");

WITH inserted_revisions AS (
	INSERT INTO "routine_revisions" (
		"id",
		"company_id",
		"routine_id",
		"revision_number",
		"title",
		"description",
		"snapshot",
		"change_summary",
		"created_by_agent_id",
		"created_by_user_id",
		"created_at"
	)
	SELECT
		gen_random_uuid(),
		r."company_id",
		r."id",
		1,
		r."title",
		r."description",
		jsonb_build_object(
			'version', 1,
			'routine', jsonb_build_object(
				'id', r."id",
				'companyId', r."company_id",
				'projectId', r."project_id",
				'goalId', r."goal_id",
				'parentIssueId', r."parent_issue_id",
				'title', r."title",
				'description', r."description",
				'assigneeAgentId', r."assignee_agent_id",
				'priority', r."priority",
				'status', r."status",
				'concurrencyPolicy', r."concurrency_policy",
				'catchUpPolicy', r."catch_up_policy",
				'variables', coalesce(r."variables", '[]'::jsonb)
			),
			'triggers', coalesce(
				(
					SELECT jsonb_agg(
						jsonb_build_object(
							'id', rt."id",
							'kind', rt."kind",
							'label', rt."label",
							'enabled', rt."enabled",
							'cronExpression', rt."cron_expression",
							'timezone', rt."timezone",
							'publicId', rt."public_id",
							'signingMode', rt."signing_mode",
							'replayWindowSec', rt."replay_window_sec"
						)
						ORDER BY rt."created_at", rt."id"
					)
					FROM "routine_triggers" rt
					WHERE rt."routine_id" = r."id"
						AND rt."company_id" = r."company_id"
				),
				'[]'::jsonb
			)
		),
		'Initial routine revision backfill',
		r."created_by_agent_id",
		r."created_by_user_id",
		r."created_at"
	FROM "routines" r
	WHERE NOT EXISTS (
		SELECT 1
		FROM "routine_revisions" rr
		WHERE rr."routine_id" = r."id"
			AND rr."revision_number" = 1
	)
	RETURNING "id", "routine_id"
)
UPDATE "routines" r
SET
	"latest_revision_id" = inserted_revisions."id",
	"latest_revision_number" = 1
FROM inserted_revisions
WHERE r."id" = inserted_revisions."routine_id";

UPDATE "routines" r
SET
	"latest_revision_id" = rr."id",
	"latest_revision_number" = rr."revision_number"
FROM "routine_revisions" rr
WHERE rr."routine_id" = r."id"
	AND rr."revision_number" = 1
	AND r."latest_revision_id" IS NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('48fe3461dd7d75e0bf8d66f260f480d5cdad40895314352d5dc41e62cded344e', 1777933347806);

-- >>> Migration: 0078_white_darwin.sql <<<
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "author_type" text;
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "presentation" jsonb;
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "metadata" jsonb;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('11573ddf41de1208831980dcbfb143922bbb374fe4e20ba5eaa96f6820033767', 1778004024976);

-- >>> Migration: 0079_company_search_document_indexes.sql <<<
CREATE INDEX IF NOT EXISTS "documents_title_search_idx" ON "documents" USING gin ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "documents_latest_body_search_idx" ON "documents" USING gin ("latest_body" gin_trgm_ops);


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2b5a14a99abf4c6cbd753f52d806b8a999e4fb03a95b00493873f2c1227745a9', 1777821410992);

-- >>> Migration: 0080_company_search_fuzzystrmatch.sql <<<
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('49c738698d5efa84a54c06def568721654d399427d4ae4ff05fad2646a0a3e1e', 1777849000000);

-- >>> Migration: 0081_optimal_dormammu.sql <<<
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "work_mode" text DEFAULT 'standard' NOT NULL;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('79676a9996c0a8979ba19812c10393961d361ced758fa14d447d346300d8b334', 1778067785040);

-- >>> Migration: 0082_dry_vision.sql <<<
CREATE TABLE IF NOT EXISTS "company_secret_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"config_path" text NOT NULL,
	"version_selector" text DEFAULT 'latest' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "secret_access_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"version" integer,
	"provider" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"consumer_type" text NOT NULL,
	"consumer_id" text NOT NULL,
	"config_path" text,
	"issue_id" uuid,
	"heartbeat_run_id" uuid,
	"plugin_id" uuid,
	"outcome" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "key" text;
UPDATE "company_secrets"
SET "key" = left(
	regexp_replace(
		regexp_replace(lower(trim(coalesce("name", "id"::text))), '[^a-z0-9_.-]+', '-', 'g'),
		'^-+|-+$',
		'',
		'g'
	),
	120
)
WHERE "key" IS NULL;
UPDATE "company_secrets"
SET "key" = "id"::text
WHERE "key" IS NULL OR "key" = '';
ALTER TABLE "company_secrets" ALTER COLUMN "key" SET NOT NULL;
WITH ranked AS (
	SELECT
		"id",
		"key",
		row_number() OVER (PARTITION BY "company_id", "key" ORDER BY "created_at", "id") AS rn
	FROM "company_secrets"
)
UPDATE "company_secrets"
SET "key" = left(ranked."key", 100) || '-' || ranked.rn::text
FROM ranked
WHERE "company_secrets"."id" = ranked."id"
	AND ranked.rn > 1;
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "managed_mode" text DEFAULT 'paperclip_managed' NOT NULL;
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "provider_config_id" text;
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "provider_metadata" jsonb;
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "last_resolved_at" timestamp with time zone;
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "last_rotated_at" timestamp with time zone;
UPDATE "company_secrets"
SET "last_rotated_at" = "updated_at"
WHERE "last_rotated_at" IS NULL;
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
ALTER TABLE "company_secret_versions" ADD COLUMN IF NOT EXISTS "provider_version_ref" text;
ALTER TABLE "company_secret_versions" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'current' NOT NULL;
ALTER TABLE "company_secret_versions" ADD COLUMN IF NOT EXISTS "fingerprint_sha256" text;
UPDATE "company_secret_versions"
SET "fingerprint_sha256" = "value_sha256"
WHERE "fingerprint_sha256" IS NULL;
ALTER TABLE "company_secret_versions" ALTER COLUMN "fingerprint_sha256" SET NOT NULL;
ALTER TABLE "company_secret_versions" ADD COLUMN IF NOT EXISTS "rotation_job_id" text;
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_bindings_company_id_companies_id_fk') THEN
		ALTER TABLE "company_secret_bindings" ADD CONSTRAINT "company_secret_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_bindings_secret_id_company_secrets_id_fk') THEN
		ALTER TABLE "company_secret_bindings" ADD CONSTRAINT "company_secret_bindings_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_company_id_companies_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_secret_id_company_secrets_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_issue_id_issues_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_heartbeat_run_id_heartbeat_runs_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_plugin_id_plugins_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
CREATE INDEX IF NOT EXISTS "company_secret_bindings_company_idx" ON "company_secret_bindings" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "company_secret_bindings_secret_idx" ON "company_secret_bindings" USING btree ("secret_id");
CREATE INDEX IF NOT EXISTS "company_secret_bindings_target_idx" ON "company_secret_bindings" USING btree ("company_id","target_type","target_id");
CREATE UNIQUE INDEX IF NOT EXISTS "company_secret_bindings_target_path_uq" ON "company_secret_bindings" USING btree ("company_id","target_type","target_id","config_path");
CREATE INDEX IF NOT EXISTS "secret_access_events_company_created_idx" ON "secret_access_events" USING btree ("company_id","created_at");
CREATE INDEX IF NOT EXISTS "secret_access_events_secret_created_idx" ON "secret_access_events" USING btree ("secret_id","created_at");
CREATE INDEX IF NOT EXISTS "secret_access_events_consumer_idx" ON "secret_access_events" USING btree ("company_id","consumer_type","consumer_id");
CREATE INDEX IF NOT EXISTS "secret_access_events_run_idx" ON "secret_access_events" USING btree ("heartbeat_run_id");
CREATE INDEX IF NOT EXISTS "company_secret_versions_fingerprint_idx" ON "company_secret_versions" USING btree ("fingerprint_sha256");
CREATE UNIQUE INDEX IF NOT EXISTS "company_secrets_company_key_uq" ON "company_secrets" USING btree ("company_id","key");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2b6660781a0bc51fb4b255ecf90bd1a533888f6514114f324bd86e3c40b9bcb5', 1778067785041);

-- >>> Migration: 0083_company_secret_provider_configs.sql <<<
CREATE TABLE IF NOT EXISTS "company_secret_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health_status" text,
	"health_checked_at" timestamp with time zone,
	"health_message" text,
	"health_details" jsonb,
	"disabled_at" timestamp with time zone,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_provider_configs_company_id_companies_id_fk') THEN
		ALTER TABLE "company_secret_provider_configs" ADD CONSTRAINT "company_secret_provider_configs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_provider_configs_created_by_agent_id_agents_id_fk') THEN
		ALTER TABLE "company_secret_provider_configs" ADD CONSTRAINT "company_secret_provider_configs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

UPDATE "company_secrets"
SET "provider_config_id" = NULL
WHERE "provider_config_id" IS NOT NULL
	AND "provider_config_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

ALTER TABLE "company_secrets" ALTER COLUMN "provider_config_id" TYPE uuid USING "provider_config_id"::uuid;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secrets_provider_config_id_company_secret_provider_configs_id_fk') THEN
		ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_provider_config_id_company_secret_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."company_secret_provider_configs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS "company_secret_provider_configs_company_idx" ON "company_secret_provider_configs" USING btree ("company_id");

CREATE INDEX IF NOT EXISTS "company_secret_provider_configs_company_provider_idx" ON "company_secret_provider_configs" USING btree ("company_id","provider");

CREATE UNIQUE INDEX IF NOT EXISTS "company_secret_provider_configs_default_uq" ON "company_secret_provider_configs" USING btree ("company_id","provider") WHERE "is_default" = true;

CREATE INDEX IF NOT EXISTS "company_secrets_provider_config_idx" ON "company_secrets" USING btree ("provider_config_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('a97be2bb8f67b0f5cf2782d43ea01d6ca8117e4b78bf600c9ebf6e9250578685', 1778074536410);

-- >>> Migration: 0084_issue_recovery_actions.sql <<<
CREATE TABLE IF NOT EXISTS "issue_recovery_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"recovery_issue_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_type" text DEFAULT 'agent' NOT NULL,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"previous_owner_agent_id" uuid,
	"return_owner_agent_id" uuid,
	"cause" text NOT NULL,
	"fingerprint" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_action" text NOT NULL,
	"wake_policy" jsonb,
	"monitor_policy" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer,
	"timeout_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"outcome" text,
	"resolution_note" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_company_id_companies_id_fk') THEN
		ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_source_issue_id_issues_id_fk') THEN
		ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_recovery_issue_id_issues_id_fk') THEN
		ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_recovery_issue_id_issues_id_fk" FOREIGN KEY ("recovery_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_owner_agent_id_agents_id_fk') THEN
		ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_previous_owner_agent_id_agents_id_fk') THEN
		ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_previous_owner_agent_id_agents_id_fk" FOREIGN KEY ("previous_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_return_owner_agent_id_agents_id_fk') THEN
		ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_return_owner_agent_id_agents_id_fk" FOREIGN KEY ("return_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
CREATE INDEX IF NOT EXISTS "issue_recovery_actions_company_source_status_idx" ON "issue_recovery_actions" USING btree ("company_id","source_issue_id","status");
CREATE INDEX IF NOT EXISTS "issue_recovery_actions_company_owner_status_idx" ON "issue_recovery_actions" USING btree ("company_id","owner_agent_id","status");
CREATE INDEX IF NOT EXISTS "issue_recovery_actions_company_recovery_issue_idx" ON "issue_recovery_actions" USING btree ("company_id","recovery_issue_id");
CREATE UNIQUE INDEX IF NOT EXISTS "issue_recovery_actions_active_source_uq" ON "issue_recovery_actions" USING btree ("company_id","source_issue_id") WHERE "issue_recovery_actions"."status" in ('active', 'escalated');
CREATE UNIQUE INDEX IF NOT EXISTS "issue_recovery_actions_active_fingerprint_uq" ON "issue_recovery_actions" USING btree ("company_id","source_issue_id","cause","fingerprint") WHERE "issue_recovery_actions"."status" in ('active', 'escalated');


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('84ea5e794c63599a55fc15fbb4c9eaa098bcc0da4d4195ee515d4c3ce702cf51', 1778355326070);

-- >>> Migration: 0085_tranquil_the_executioner.sql <<<
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "locked_at" timestamp with time zone;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "locked_by_agent_id" uuid;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "locked_by_user_id" text;
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_locked_by_agent_id_agents_id_fk') THEN
		ALTER TABLE "documents" ADD CONSTRAINT "documents_locked_by_agent_id_agents_id_fk" FOREIGN KEY ("locked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f9852e06c19b1ff4fcebb34bcda456d2995fb24beeac5b70432deee9b6d7b229', 1778787362162);

-- >>> Migration: 0086_routine_env_runtime_contract.sql <<<
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "env" jsonb;
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "routine_revision_id" uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_runs_routine_revision_id_routine_revisions_id_fk') THEN
    ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_revision_id_routine_revisions_id_fk" FOREIGN KEY ("routine_revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "routine_runs_revision_idx" ON "routine_runs" USING btree ("routine_revision_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('8ca00a87e4b1ca0b43411534f1218ca8b46ba0f601caa2159b33b9c1c6646e59', 1778976000000);

-- >>> Migration: 0087_backfill_environment_manage_human_defaults.sql <<<
INSERT INTO "principal_permission_grants" (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key",
  "scope",
  "granted_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  "company_id",
  'user',
  "principal_id",
  'environments:manage',
  NULL,
  NULL,
  now(),
  now()
FROM "company_memberships"
WHERE "principal_type" = 'user'
  AND "status" = 'active'
  AND "membership_role" IN ('owner', 'admin')
ON CONFLICT (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key"
) DO NOTHING;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('7a723ac2b61af1182f78a6a22af028a8bca4511b1a8f977eaecdd2131c80504d', 1779360000000);

-- >>> Migration: 0088_backfill_principal_access_compatibility.sql <<<
INSERT INTO "company_memberships" (
  "company_id",
  "principal_type",
  "principal_id",
  "status",
  "membership_role",
  "created_at",
  "updated_at"
)
SELECT
  "company_id",
  'agent',
  "id",
  'active',
  'member',
  now(),
  now()
FROM "agents"
WHERE "status" NOT IN ('pending_approval', 'terminated')
ON CONFLICT (
  "company_id",
  "principal_type",
  "principal_id"
) DO NOTHING;

INSERT INTO "principal_permission_grants" (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key",
  "scope",
  "granted_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  memberships."company_id",
  'user',
  memberships."principal_id",
  role_defaults."permission_key",
  NULL,
  NULL,
  now(),
  now()
FROM "company_memberships" memberships
JOIN (
  VALUES
    ('owner', 'agents:create'),
    ('owner', 'environments:manage'),
    ('owner', 'users:invite'),
    ('owner', 'users:manage_permissions'),
    ('owner', 'tasks:assign'),
    ('owner', 'joins:approve'),
    ('admin', 'agents:create'),
    ('admin', 'environments:manage'),
    ('admin', 'users:invite'),
    ('admin', 'tasks:assign'),
    ('admin', 'joins:approve'),
    ('operator', 'tasks:assign')
) AS role_defaults("membership_role", "permission_key")
  ON role_defaults."membership_role" = CASE
    WHEN memberships."membership_role" = 'owner' THEN 'owner'
    WHEN memberships."membership_role" = 'admin' THEN 'admin'
    WHEN memberships."membership_role" = 'viewer' THEN 'viewer'
    WHEN memberships."membership_role" = 'member' THEN 'operator'
    ELSE 'operator'
  END
WHERE memberships."principal_type" = 'user'
  AND memberships."status" = 'active'
ON CONFLICT (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key"
) DO NOTHING;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('4decca1b322d15430512bec78ae3b5caecaf5ea7a3754f5f7608ed3f0d59fe0d', 1779446400000);

-- >>> Migration: 0089_cloud_upstreams.sql <<<
CREATE TABLE IF NOT EXISTS "cloud_upstream_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "remote_url" text NOT NULL,
  "source_instance_id" text NOT NULL,
  "source_instance_fingerprint" text NOT NULL,
  "source_public_key" text NOT NULL,
  "private_key_pem" text NOT NULL,
  "token_status" text NOT NULL,
  "scopes" text[] DEFAULT '{}' NOT NULL,
  "authorized_global_user_id" text,
  "access_token" text,
  "token_id" text,
  "token_expires_at" timestamp with time zone,
  "target_stack_id" text NOT NULL,
  "target_stack_slug" text,
  "target_stack_display_name" text,
  "target_company_id" text NOT NULL,
  "target_origin" text NOT NULL,
  "target_primary_host" text NOT NULL,
  "target_product" text NOT NULL,
  "target_schema_major" integer NOT NULL,
  "target_max_chunk_bytes" integer NOT NULL,
  "pending_state" text,
  "pending_code_verifier" text,
  "pending_redirect_uri" text,
  "pending_token_url" text,
  "last_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "cloud_upstream_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "remote_run_id" text,
  "status" text NOT NULL,
  "active_step" text NOT NULL,
  "progress_percent" integer DEFAULT 0 NOT NULL,
  "dry_run" boolean DEFAULT false NOT NULL,
  "retry_of_run_id" uuid,
  "summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "events" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "report" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "idempotency_key" text NOT NULL,
  "manifest_hash" text NOT NULL,
  "target_url" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cloud_upstream_connections_company_id_companies_id_fk') THEN
    ALTER TABLE "cloud_upstream_connections" ADD CONSTRAINT "cloud_upstream_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cloud_upstream_runs_connection_id_cloud_upstream_connections_id_fk') THEN
    ALTER TABLE "cloud_upstream_runs" ADD CONSTRAINT "cloud_upstream_runs_connection_id_cloud_upstream_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."cloud_upstream_connections"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cloud_upstream_runs_company_id_companies_id_fk') THEN
    ALTER TABLE "cloud_upstream_runs" ADD CONSTRAINT "cloud_upstream_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "cloud_upstream_connections_company_idx" ON "cloud_upstream_connections" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "cloud_upstream_runs_company_created_idx" ON "cloud_upstream_runs" USING btree ("company_id","created_at");
CREATE INDEX IF NOT EXISTS "cloud_upstream_runs_connection_idx" ON "cloud_upstream_runs" USING btree ("connection_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2a71008cbd4f11e8301d3d8b88431681ddc27c0ad8054484f1af01506a06f62a', 1779129600000);

-- >>> Migration: 0090_resource_memberships.sql <<<
CREATE TABLE IF NOT EXISTS "agent_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state" text DEFAULT 'joined' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "project_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state" text DEFAULT 'joined' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memberships_company_id_companies_id_fk') THEN
		ALTER TABLE "agent_memberships" ADD CONSTRAINT "agent_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memberships_agent_id_agents_id_fk') THEN
		ALTER TABLE "agent_memberships" ADD CONSTRAINT "agent_memberships_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_memberships_company_id_companies_id_fk') THEN
		ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_memberships_project_id_projects_id_fk') THEN
		ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS "agent_memberships_company_user_idx" ON "agent_memberships" USING btree ("company_id","user_id");

CREATE INDEX IF NOT EXISTS "agent_memberships_agent_idx" ON "agent_memberships" USING btree ("agent_id");

CREATE UNIQUE INDEX IF NOT EXISTS "agent_memberships_company_user_agent_uq" ON "agent_memberships" USING btree ("company_id","user_id","agent_id");

CREATE INDEX IF NOT EXISTS "project_memberships_company_user_idx" ON "project_memberships" USING btree ("company_id","user_id");

CREATE INDEX IF NOT EXISTS "project_memberships_project_idx" ON "project_memberships" USING btree ("project_id");

CREATE UNIQUE INDEX IF NOT EXISTS "project_memberships_company_user_project_uq" ON "project_memberships" USING btree ("company_id","user_id","project_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e044d13426fa26e95175cffe7e4f058a19052b4f55bbbbacc2ba6755bde20175', 1779573019125);

-- >>> Migration: 0091_old_swarm.sql <<<
CREATE TABLE IF NOT EXISTS "document_annotation_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"anchor_state" text DEFAULT 'active' NOT NULL,
	"original_revision_id" uuid,
	"original_revision_number" integer NOT NULL,
	"current_revision_id" uuid,
	"current_revision_number" integer NOT NULL,
	"selected_text" text NOT NULL,
	"prefix_text" text DEFAULT '' NOT NULL,
	"suffix_text" text DEFAULT '' NOT NULL,
	"normalized_start" integer NOT NULL,
	"normalized_end" integer NOT NULL,
	"markdown_start" integer NOT NULL,
	"markdown_end" integer NOT NULL,
	"anchor_confidence" text DEFAULT 'exact' NOT NULL,
	"anchor_selector" jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"resolved_by_agent_id" uuid,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "document_annotation_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_type" text NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "document_annotation_anchor_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"from_revision_id" uuid,
	"from_revision_number" integer,
	"to_revision_id" uuid,
	"to_revision_number" integer NOT NULL,
	"previous_anchor" jsonb NOT NULL,
	"next_anchor" jsonb,
	"anchor_state" text NOT NULL,
	"anchor_confidence" text NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_threads_company_id_companies_id_fk') THEN
		ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_threads_issue_id_issues_id_fk') THEN
		ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_threads_document_id_documents_id_fk') THEN
		ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_threads_original_revision_id_document_revisions_id_fk') THEN
		ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_original_revision_id_document_revisions_id_fk" FOREIGN KEY ("original_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_threads_current_revision_id_document_revisions_id_fk') THEN
		ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_current_revision_id_document_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_threads_created_by_agent_id_agents_id_fk') THEN
		ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_threads_resolved_by_agent_id_agents_id_fk') THEN
		ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_comments_company_id_companies_id_fk') THEN
		ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_comments_thread_id_document_annotation_threads_id_fk') THEN
		ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_thread_id_document_annotation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."document_annotation_threads"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_comments_issue_id_issues_id_fk') THEN
		ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_comments_document_id_documents_id_fk') THEN
		ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_comments_author_agent_id_agents_id_fk') THEN
		ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_comments_created_by_run_id_heartbeat_runs_id_fk') THEN
		ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_anchor_snapshots_company_id_companies_id_fk') THEN
		ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_anchor_snapshots_thread_id_document_annotation_threads_id_fk') THEN
		ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_thread_id_document_annotation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."document_annotation_threads"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_anchor_snapshots_document_id_documents_id_fk') THEN
		ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_anchor_snapshots_from_revision_id_document_revisions_id_fk') THEN
		ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_from_revision_id_document_revisions_id_fk" FOREIGN KEY ("from_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_annotation_anchor_snapshots_to_revision_id_document_revisions_id_fk') THEN
		ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_to_revision_id_document_revisions_id_fk" FOREIGN KEY ("to_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS "document_annotation_threads_company_document_status_idx" ON "document_annotation_threads" USING btree ("company_id","document_id","status");

CREATE INDEX IF NOT EXISTS "document_annotation_threads_company_issue_status_idx" ON "document_annotation_threads" USING btree ("company_id","issue_id","status");

CREATE INDEX IF NOT EXISTS "document_annotation_threads_company_current_revision_open_idx" ON "document_annotation_threads" USING btree ("company_id","document_id","current_revision_id","status");

CREATE INDEX IF NOT EXISTS "document_annotation_threads_company_anchor_state_idx" ON "document_annotation_threads" USING btree ("company_id","anchor_state");

CREATE INDEX IF NOT EXISTS "document_annotation_comments_company_thread_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","thread_id","created_at");

CREATE INDEX IF NOT EXISTS "document_annotation_comments_company_issue_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","issue_id","created_at");

CREATE INDEX IF NOT EXISTS "document_annotation_comments_company_document_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","document_id","created_at");

CREATE INDEX IF NOT EXISTS "document_annotation_comments_body_search_idx" ON "document_annotation_comments" USING gin ("body" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "document_annotation_anchor_snapshots_company_thread_created_at_idx" ON "document_annotation_anchor_snapshots" USING btree ("company_id","thread_id","created_at");

CREATE INDEX IF NOT EXISTS "document_annotation_anchor_snapshots_company_document_revision_idx" ON "document_annotation_anchor_snapshots" USING btree ("company_id","document_id","to_revision_number");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('3db3cadcf2d0720a3c7c3adbe20d841f60f9361729204bbe1246fba46bd195b2', 1778810394522);

-- >>> Migration: 0092_mighty_puma.sql <<<
CREATE TABLE "issue_plan_decompositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"accepted_plan_revision_id" uuid NOT NULL,
	"accepted_interaction_id" uuid,
	"status" text DEFAULT 'in_flight' NOT NULL,
	"request_fingerprint" text NOT NULL,
	"requested_child_count" integer DEFAULT 0 NOT NULL,
	"requested_children" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"child_issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"owner_run_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "issue_plan_decompositions" ADD CONSTRAINT "issue_plan_decompositions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "issue_plan_decompositions" ADD CONSTRAINT "issue_plan_decompositions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_plan_decompositions" ADD CONSTRAINT "issue_plan_decompositions_accepted_plan_revision_id_document_revisions_id_fk" FOREIGN KEY ("accepted_plan_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_plan_decompositions" ADD CONSTRAINT "issue_plan_decompositions_accepted_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("accepted_interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "issue_plan_decompositions" ADD CONSTRAINT "issue_plan_decompositions_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "issue_plan_decompositions" ADD CONSTRAINT "issue_plan_decompositions_owner_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("owner_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "issue_plan_decompositions_company_source_status_idx" ON "issue_plan_decompositions" USING btree ("company_id","source_issue_id","status");
CREATE INDEX "issue_plan_decompositions_active_owner_idx" ON "issue_plan_decompositions" USING btree ("company_id","owner_agent_id") WHERE "issue_plan_decompositions"."status" = 'in_flight';
CREATE UNIQUE INDEX "issue_plan_decompositions_source_revision_uq" ON "issue_plan_decompositions" USING btree ("company_id","source_issue_id","accepted_plan_revision_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('c579402bcedfd5d380726b686fac9de79f5b6cdfcb25fc4520511a5887bb5149', 1779999768200);

-- >>> Migration: 0093_giant_green_goblin.sql <<<
ALTER TABLE "execution_workspaces" DROP CONSTRAINT "execution_workspaces_company_id_companies_id_fk";

ALTER TABLE "workspace_operations" DROP CONSTRAINT "workspace_operations_company_id_companies_id_fk";

ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('8524a4ba6635512364f7814d48d4fef98b08cb7edcfe9de290d333586a841fa3', 1780040470886);

-- >>> Migration: 0094_backfill_archived_company_agent_pauses.sql <<<
UPDATE "agents" AS a
SET
  "status" = 'paused',
  "pause_reason" = 'company_archived',
  "paused_at" = now(),
  "updated_at" = now()
FROM "companies" AS c
WHERE c."id" = a."company_id"
  AND c."status" = 'archived'
  AND a."status" NOT IN ('paused', 'terminated', 'pending_approval');


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('371e08277bee0124438802f192b2e4dd01dff7956f0eb2451eac841f80bcac30', 1780533900000);

-- >>> Migration: 0095_issue_comment_tombstones.sql <<<
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "deleted_by_type" text;
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "deleted_by_agent_id" uuid;
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "deleted_by_user_id" text;
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "deleted_by_run_id" uuid;
DO $$ BEGIN
 ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_deleted_by_agent_id_agents_id_fk" FOREIGN KEY ("deleted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_deleted_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("deleted_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f067265dd6fc675bd0522f575ae2ef3607568538c190cd94281ef2dc824c6af8', 1780507597454);

-- >>> Migration: 0096_document_annotation_issue_comment_links.sql <<<
ALTER TABLE "document_annotation_comments" ADD COLUMN IF NOT EXISTS "issue_comment_id" uuid;
DO $$ BEGIN
 ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_issue_comment_id_issue_comments_id_fk" FOREIGN KEY ("issue_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "document_annotation_comments_issue_comment_idx" ON "document_annotation_comments" USING btree ("issue_comment_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('531673a6d8a7b9a448e3745874daeecfa6af36359c7dd44927860f22e8fd7ac5', 1780507597455);

-- >>> Migration: 0097_low_trust_source_trust.sql <<<
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "source_trust" jsonb;
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "source_trust" jsonb;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_trust" jsonb;
ALTER TABLE "issue_work_products" ADD COLUMN IF NOT EXISTS "source_trust" jsonb;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('97ce068d4819ab1e9fc7f1849c2d7e6eeb6adc72a361450eb77af8af527446ee', 1780534000000);

-- >>> Migration: 0098_project_icon.sql <<<
ALTER TABLE "projects" ADD COLUMN "icon" text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('9ec97f5d6513e1eb9de764b04cadbb49935eed4afab1b67f1a2e5257beb1729d', 1780534200000);

-- >>> Migration: 0099_skills_store_foundation.sql <<<
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "icon_url" text;
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "color" text;
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "tagline" text;
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "author_name" text;
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "homepage_url" text;
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "categories" text[] NOT NULL DEFAULT '{}';
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "sharing_scope" text NOT NULL DEFAULT 'company';
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "public_share_token" text;
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "forked_from_skill_id" uuid;
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "forked_from_company_id" uuid;
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "star_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "install_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "fork_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "current_version_id" uuid;
CREATE TABLE IF NOT EXISTS "company_skill_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "company_skill_id" uuid NOT NULL,
  "revision_number" integer NOT NULL,
  "label" text,
  "file_inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "author_agent_id" uuid,
  "author_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "company_skill_stars" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "company_skill_id" uuid NOT NULL,
  "agent_id" uuid,
  "user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "company_skill_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "company_skill_id" uuid NOT NULL,
  "parent_comment_id" uuid,
  "author_agent_id" uuid,
  "author_user_id" text,
  "body" text NOT NULL,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_forked_from_skill_id_company_skills_id_fk" FOREIGN KEY ("forked_from_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_forked_from_company_id_companies_id_fk" FOREIGN KEY ("forked_from_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_versions" ADD CONSTRAINT "company_skill_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_versions" ADD CONSTRAINT "company_skill_versions_company_skill_id_company_skills_id_fk" FOREIGN KEY ("company_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_versions" ADD CONSTRAINT "company_skill_versions_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_current_version_id_company_skill_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."company_skill_versions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_stars" ADD CONSTRAINT "company_skill_stars_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_stars" ADD CONSTRAINT "company_skill_stars_company_skill_id_company_skills_id_fk" FOREIGN KEY ("company_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_stars" ADD CONSTRAINT "company_skill_stars_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_comments" ADD CONSTRAINT "company_skill_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_comments" ADD CONSTRAINT "company_skill_comments_company_skill_id_company_skills_id_fk" FOREIGN KEY ("company_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_comments" ADD CONSTRAINT "company_skill_comments_parent_comment_id_company_skill_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."company_skill_comments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_comments" ADD CONSTRAINT "company_skill_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "company_skills_company_categories_idx" ON "company_skills" USING gin ("categories");
CREATE INDEX IF NOT EXISTS "company_skills_company_sharing_scope_idx" ON "company_skills" USING btree ("company_id","sharing_scope");
CREATE INDEX IF NOT EXISTS "company_skills_company_current_version_idx" ON "company_skills" USING btree ("company_id","current_version_id");
CREATE INDEX IF NOT EXISTS "company_skills_company_forked_from_idx" ON "company_skills" USING btree ("company_id","forked_from_skill_id");
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_versions_skill_revision_idx" ON "company_skill_versions" USING btree ("company_skill_id","revision_number");
CREATE INDEX IF NOT EXISTS "company_skill_versions_company_skill_created_idx" ON "company_skill_versions" USING btree ("company_id","company_skill_id","created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_stars_skill_agent_idx" ON "company_skill_stars" USING btree ("company_skill_id","agent_id");
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_stars_skill_user_idx" ON "company_skill_stars" USING btree ("company_skill_id","user_id");
CREATE INDEX IF NOT EXISTS "company_skill_stars_company_skill_created_idx" ON "company_skill_stars" USING btree ("company_id","company_skill_id","created_at");
CREATE INDEX IF NOT EXISTS "company_skill_comments_company_skill_created_idx" ON "company_skill_comments" USING btree ("company_id","company_skill_id","created_at");
CREATE INDEX IF NOT EXISTS "company_skill_comments_parent_idx" ON "company_skill_comments" USING btree ("parent_comment_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('aabfee13a3ac7dd59342a7f2398dbe1a6c87e75fcaead1f08f9d1a77fc829b3e', 1781130000000);

-- >>> Migration: 0100_skill_install_count_backfill.sql <<<
UPDATE "company_skills" SET "install_count" = 0 WHERE "install_count" IS NULL;
ALTER TABLE "company_skills" ALTER COLUMN "install_count" SET DEFAULT 0;
ALTER TABLE "company_skills" ALTER COLUMN "install_count" SET NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('9ac7e19e6a5a8eb6fa8c3ab5166a046306ed3e028fd43ad78b4367ca0f16e1ce', 1781480000000);

-- >>> Migration: 0101_plugin_company_id_tenant_isolation.sql <<<
DROP INDEX "plugin_entities_external_idx";
ALTER TABLE "plugin_entities" ADD COLUMN "company_id" uuid;
ALTER TABLE "plugin_job_runs" ADD COLUMN "company_id" uuid;
ALTER TABLE "plugin_logs" ADD COLUMN "company_id" uuid;
ALTER TABLE "plugin_webhook_deliveries" ADD COLUMN "company_id" uuid;
ALTER TABLE "plugin_entities" ADD CONSTRAINT "plugin_entities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plugin_job_runs" ADD CONSTRAINT "plugin_job_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plugin_logs" ADD CONSTRAINT "plugin_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plugin_webhook_deliveries" ADD CONSTRAINT "plugin_webhook_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "plugin_entities_company_idx" ON "plugin_entities" USING btree ("company_id");
CREATE INDEX "plugin_job_runs_company_idx" ON "plugin_job_runs" USING btree ("company_id");
CREATE INDEX "plugin_logs_company_idx" ON "plugin_logs" USING btree ("company_id");
CREATE INDEX "plugin_webhook_deliveries_company_idx" ON "plugin_webhook_deliveries" USING btree ("company_id");
ALTER TABLE "plugin_entities" ADD CONSTRAINT "plugin_entities_external_idx" UNIQUE NULLS NOT DISTINCT("company_id","plugin_id","entity_type","external_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('ed4ee607e26dd12cdfa491985360abd5de698997adefe9b77226c5274ef9b333', 1781490000000);

-- >>> Migration: 0102_managed_sandbox_dedup_index.sql <<<
-- One-shot dedup of any pre-existing managed sandbox rows duplicated per company.
-- Keeps the oldest row per (company_id) where driver='sandbox' AND metadata.managedByPaperclip is true.
-- Scoped to Paperclip-managed rows only: tenant-created sandbox envs (without the marker) are untouched.
DO $$
DECLARE
  deleted_count integer;
BEGIN
  WITH ranked AS (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY company_id
        ORDER BY created_at ASC, id ASC
      ) AS rn
    FROM environments
    WHERE driver = 'sandbox'
      AND (metadata ->> 'managedByPaperclip')::boolean = true
  ),
  deleted AS (
    DELETE FROM environments
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    RETURNING 1
  )
  SELECT count(*) INTO deleted_count FROM deleted;

  IF deleted_count > 0 THEN
    RAISE NOTICE 'environments_company_managed_sandbox_idx dedup removed % duplicate managed-sandbox row(s)', deleted_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "environments_company_managed_sandbox_idx"
  ON "environments" ("company_id")
  WHERE driver = 'sandbox' AND (metadata ->> 'managedByPaperclip')::boolean = true;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('24b91cd38c63c70953a8653ed30ab1948a163a684056fe59718104e6a066e13a', 1781490100000);

-- >>> Migration: 0103_agent_error_reason.sql <<<
ALTER TABLE "agents" ADD COLUMN "error_reason" text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('9866d69c19e1e68647f9afb87fe1c40044a9a3657771b442decfb58a22d442f3', 1781490200000);

-- >>> Migration: 0104_issue_watchdogs.sql <<<
CREATE TABLE IF NOT EXISTS "issue_watchdogs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "watchdog_agent_id" uuid NOT NULL,
  "instructions" text,
  "status" text DEFAULT 'active' NOT NULL,
  "watchdog_issue_id" uuid,
  "last_observed_fingerprint" text,
  "last_reviewed_fingerprint" text,
  "last_triggered_at" timestamp with time zone,
  "last_completed_at" timestamp with time zone,
  "trigger_count" integer DEFAULT 0 NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_by_run_id" uuid,
  "updated_by_agent_id" uuid,
  "updated_by_user_id" text,
  "updated_by_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_watchdog_agent_id_agents_id_fk" FOREIGN KEY ("watchdog_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_watchdog_issue_id_issues_id_fk" FOREIGN KEY ("watchdog_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_updated_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("updated_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "issue_watchdogs_company_issue_uq"
  ON "issue_watchdogs" USING btree ("company_id","issue_id");

CREATE INDEX IF NOT EXISTS "issue_watchdogs_company_status_idx"
  ON "issue_watchdogs" USING btree ("company_id","status");

CREATE INDEX IF NOT EXISTS "issue_watchdogs_company_agent_idx"
  ON "issue_watchdogs" USING btree ("company_id","watchdog_agent_id");

CREATE UNIQUE INDEX IF NOT EXISTS "issue_watchdogs_company_watchdog_issue_uq"
  ON "issue_watchdogs" USING btree ("company_id","watchdog_issue_id")
  WHERE "watchdog_issue_id" is not null;

CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_task_watchdog_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "origin_kind" = 'task_watchdog'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('d2dd64cfcb2125552b132a301bad2c0b27af76db8a33137689b4a31397e39192', 1781733000000);

-- >>> Migration: 0105_instance_scoped_environments.sql <<<
ALTER TABLE "environments" ADD COLUMN "env_vars" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "instance_settings" ADD COLUMN "default_environment_id" uuid;
DO $$
BEGIN
  CREATE TEMP TABLE environment_migration_map (
    old_id uuid PRIMARY KEY,
    new_id uuid NOT NULL
  ) ON COMMIT DROP;

  WITH ranked AS (
    SELECT
      e.id,
      CASE
        -- Only collapse classes that are globally singleton by design.
        -- Named remote environments may legitimately differ across companies
        -- even when they share the same display name.
        WHEN e.driver = 'local' THEN '__paperclip_builtin_local__'
        WHEN e.driver = 'sandbox' AND (e.metadata ->> 'managedByPaperclip')::boolean = true
          THEN '__paperclip_managed_sandbox__'
        ELSE e.id::text
      END AS group_key,
      row_number() OVER (
        PARTITION BY CASE
          WHEN e.driver = 'local' THEN '__paperclip_builtin_local__'
          WHEN e.driver = 'sandbox' AND (e.metadata ->> 'managedByPaperclip')::boolean = true
            THEN '__paperclip_managed_sandbox__'
          ELSE e.id::text
        END
        ORDER BY e.created_at ASC, e.id ASC
      ) AS rn
    FROM "environments" e
  ),
  canonical AS (
    SELECT
      ranked.group_key,
      ranked.id AS canonical_id
    FROM ranked
    WHERE ranked.rn = 1
  )
  INSERT INTO environment_migration_map (old_id, new_id)
  SELECT ranked.id, canonical.canonical_id
  FROM ranked
  JOIN canonical ON canonical.group_key = ranked.group_key;

  UPDATE "agents" AS agents
  SET "default_environment_id" = map.new_id
  FROM environment_migration_map AS map
  WHERE agents."default_environment_id" = map.old_id
    AND agents."default_environment_id" IS DISTINCT FROM map.new_id;

  UPDATE "environment_leases" AS leases
  SET "environment_id" = map.new_id
  FROM environment_migration_map AS map
  WHERE leases."environment_id" = map.old_id
    AND leases."environment_id" IS DISTINCT FROM map.new_id;

  DELETE FROM "environments" AS environments
  USING environment_migration_map AS map
  WHERE environments."id" = map.old_id
    AND map.old_id <> map.new_id;
END $$;

UPDATE "issues"
SET "execution_workspace_settings" = "execution_workspace_settings" - 'environmentId'
WHERE jsonb_typeof("execution_workspace_settings") = 'object'
  AND "execution_workspace_settings" ? 'environmentId';

DROP INDEX IF EXISTS "environments_company_managed_sandbox_idx";
DROP INDEX IF EXISTS "environments_company_status_idx";
DROP INDEX IF EXISTS "environments_company_driver_idx";
DROP INDEX IF EXISTS "environments_company_name_idx";
ALTER TABLE "environments" DROP CONSTRAINT IF EXISTS "environments_company_id_companies_id_fk";
ALTER TABLE "environments" DROP COLUMN "company_id";
INSERT INTO "environments" (
  "id",
  "name",
  "description",
  "driver",
  "status",
  "config",
  "env_vars",
  "metadata",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  'Local',
  'Default execution environment for Paperclip runs on this machine.',
  'local',
  'active',
  '{}'::jsonb,
  '{}'::jsonb,
  '{"managedByPaperclip": true, "defaultForInstance": true}'::jsonb,
  now(),
  now()
WHERE NOT EXISTS (
  SELECT 1
  FROM "environments"
  WHERE "driver" = 'local'
);

UPDATE "environments"
SET
  "metadata" = COALESCE("metadata", '{}'::jsonb) || '{"managedByPaperclip": true, "defaultForInstance": true}'::jsonb,
  "updated_at" = now()
WHERE "driver" = 'local';

WITH duplicate_names AS (
  SELECT
    "id",
    "name",
    "driver",
    row_number() OVER (PARTITION BY "name" ORDER BY "created_at" ASC, "id" ASC) AS rn
  FROM "environments"
)
UPDATE "environments" AS environments
SET
  "name" = duplicate_names."name" || ' (' || duplicate_names."driver" || ' ' || substring(duplicate_names."id"::text from 1 for 8) || ')',
  "updated_at" = now()
FROM duplicate_names
WHERE environments."id" = duplicate_names."id"
  AND duplicate_names.rn > 1;

INSERT INTO "instance_settings" (
  "id",
  "singleton_key",
  "default_environment_id",
  "general",
  "experimental",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  'default',
  local_env."id",
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
FROM (
  SELECT "id"
  FROM "environments"
  WHERE "driver" = 'local'
  ORDER BY "created_at" ASC, "id" ASC
  LIMIT 1
) AS local_env
ON CONFLICT ("singleton_key") DO UPDATE
SET
  "default_environment_id" = EXCLUDED."default_environment_id",
  "updated_at" = now();

ALTER TABLE "instance_settings"
  ADD CONSTRAINT "instance_settings_default_environment_id_environments_id_fk"
  FOREIGN KEY ("default_environment_id")
  REFERENCES "public"."environments"("id")
  ON DELETE set null
  ON UPDATE no action;

CREATE INDEX "environments_status_idx" ON "environments" USING btree ("status");
CREATE UNIQUE INDEX "environments_local_driver_idx"
  ON "environments" USING btree ("driver")
  WHERE "driver" = 'local';

CREATE UNIQUE INDEX "environments_managed_sandbox_idx"
  ON "environments" USING btree ("driver")
  WHERE "driver" = 'sandbox' AND ("metadata" ->> 'managedByPaperclip')::boolean = true;

CREATE UNIQUE INDEX "environments_name_idx" ON "environments" USING btree ("name");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('a24935c1f8e9a244fc27240f6379d818f0006ce1c8f55906131c34511d5bb2e9', 1781902000000);

-- >>> Migration: 0106_external_object_references.sql <<<
CREATE TABLE IF NOT EXISTS "external_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "provider_key" text NOT NULL,
  "plugin_id" uuid,
  "object_type" text NOT NULL,
  "external_id" text NOT NULL,
  "sanitized_canonical_url" text,
  "canonical_identity_hash" text,
  "display_title" text,
  "status_key" text,
  "status_label" text,
  "status_category" text DEFAULT 'unknown' NOT NULL,
  "status_tone" text DEFAULT 'neutral' NOT NULL,
  "liveness" text DEFAULT 'unknown' NOT NULL,
  "is_terminal" boolean DEFAULT false NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "remote_version" text,
  "etag" text,
  "last_resolved_at" timestamp with time zone,
  "last_changed_at" timestamp with time zone,
  "last_error_at" timestamp with time zone,
  "next_refresh_at" timestamp with time zone,
  "last_error_code" text,
  "last_error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "external_object_mentions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "source_issue_id" uuid NOT NULL,
  "source_kind" text NOT NULL,
  "source_record_id" uuid,
  "document_key" text,
  "property_key" text,
  "matched_text_redacted" text,
  "sanitized_display_url" text,
  "canonical_identity_hash" text,
  "canonical_identity" jsonb,
  "object_id" uuid,
  "provider_key" text,
  "detector_key" text,
  "object_type" text,
  "confidence" text DEFAULT 'exact' NOT NULL,
  "created_by_plugin_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "external_objects" ADD CONSTRAINT "external_objects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "external_objects" ADD CONSTRAINT "external_objects_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "external_object_mentions" ADD CONSTRAINT "external_object_mentions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "external_object_mentions" ADD CONSTRAINT "external_object_mentions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "external_object_mentions" ADD CONSTRAINT "external_object_mentions_object_id_external_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."external_objects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "external_object_mentions" ADD CONSTRAINT "external_object_mentions_created_by_plugin_id_plugins_id_fk" FOREIGN KEY ("created_by_plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "external_objects_company_provider_object_idx" ON "external_objects" USING btree ("company_id","provider_key","object_type");

CREATE INDEX IF NOT EXISTS "external_objects_company_provider_status_idx" ON "external_objects" USING btree ("company_id","provider_key","status_category");

CREATE INDEX IF NOT EXISTS "external_objects_company_refresh_idx" ON "external_objects" USING btree ("company_id","next_refresh_at");

CREATE UNIQUE INDEX IF NOT EXISTS "external_objects_company_external_id_uq" ON "external_objects" USING btree ("company_id","provider_key","object_type","external_id");

CREATE UNIQUE INDEX IF NOT EXISTS "external_objects_company_identity_uq" ON "external_objects" USING btree ("company_id","provider_key","object_type","canonical_identity_hash");

CREATE INDEX IF NOT EXISTS "external_object_mentions_company_source_issue_idx" ON "external_object_mentions" USING btree ("company_id","source_issue_id");

CREATE INDEX IF NOT EXISTS "external_object_mentions_company_object_idx" ON "external_object_mentions" USING btree ("company_id","object_id");

CREATE INDEX IF NOT EXISTS "external_object_mentions_company_provider_idx" ON "external_object_mentions" USING btree ("company_id","provider_key","object_type");

CREATE UNIQUE INDEX IF NOT EXISTS "external_object_mentions_company_source_record_uq" ON "external_object_mentions" USING btree ("company_id","source_issue_id","source_kind","source_record_id","document_key","property_key","canonical_identity_hash") WHERE "source_record_id" is not null and "canonical_identity_hash" is not null;

CREATE UNIQUE INDEX IF NOT EXISTS "external_object_mentions_company_source_null_record_uq" ON "external_object_mentions" USING btree ("company_id","source_issue_id","source_kind","document_key","property_key","canonical_identity_hash") WHERE "source_record_id" is null and "canonical_identity_hash" is not null;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('4def4f4d44b38a6db75141cacbb3762f976191ce97d95acda76bca993288d586', 1781902100000);

-- >>> Migration: 0107_external_object_display_metadata.sql <<<
ALTER TABLE "external_objects" ADD COLUMN IF NOT EXISTS "display_key" text;

ALTER TABLE "external_objects" ADD COLUMN IF NOT EXISTS "icon_key" text;

ALTER TABLE "external_objects" ADD COLUMN IF NOT EXISTS "status_icon_key" text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('dd410e04746f3952997e83cd22a5d90129919676149c71c5e4f3914fa01361e9', 1782165200000);

-- >>> Migration: 0108_workspace_operations_issue_id.sql <<<
ALTER TABLE "workspace_operations" ADD COLUMN IF NOT EXISTS "issue_id" uuid;

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'workspace_operations_issue_id_issues_id_fk'
	) THEN
		ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

WITH "run_issue_candidates" AS (
	SELECT
		"heartbeat_runs"."id" AS "run_id",
		"heartbeat_runs"."company_id" AS "company_id",
		CASE
			WHEN "heartbeat_runs"."context_snapshot" ? 'issueId'
				AND "heartbeat_runs"."context_snapshot"->>'issueId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			THEN ("heartbeat_runs"."context_snapshot"->>'issueId')::uuid
			ELSE NULL
		END AS "issue_id"
	FROM "heartbeat_runs"
),
"run_issue_attribution" AS (
	SELECT
		"run_issue_candidates"."run_id",
		"issues"."id" AS "issue_id"
	FROM "run_issue_candidates"
	INNER JOIN "issues"
		ON "issues"."id" = "run_issue_candidates"."issue_id"
		AND "issues"."company_id" = "run_issue_candidates"."company_id"
	WHERE "run_issue_candidates"."issue_id" IS NOT NULL
)
UPDATE "workspace_operations"
SET
	"issue_id" = "run_issue_attribution"."issue_id",
	"updated_at" = now()
FROM "run_issue_attribution"
WHERE "workspace_operations"."heartbeat_run_id" = "run_issue_attribution"."run_id"
	AND "workspace_operations"."issue_id" IS NULL;

CREATE INDEX IF NOT EXISTS "workspace_operations_company_workspace_issue_started_idx" ON "workspace_operations" USING btree ("company_id","execution_workspace_id","issue_id","started_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('fab257c41a95fbae8196d802bad35e1db05e1123c133f2961150a2a3b79fab1f', 1781902200000);

-- >>> Migration: 0109_routine_description_annotations.sql <<<
CREATE TABLE IF NOT EXISTS "routine_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'routine_documents_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "routine_documents" ADD CONSTRAINT "routine_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'routine_documents_routine_id_routines_id_fk'
	) THEN
		ALTER TABLE "routine_documents" ADD CONSTRAINT "routine_documents_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'routine_documents_document_id_documents_id_fk'
	) THEN
		ALTER TABLE "routine_documents" ADD CONSTRAINT "routine_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "routine_documents_company_routine_key_uq" ON "routine_documents" USING btree ("company_id","routine_id","key");

CREATE UNIQUE INDEX IF NOT EXISTS "routine_documents_document_uq" ON "routine_documents" USING btree ("document_id");

CREATE INDEX IF NOT EXISTS "routine_documents_company_routine_updated_idx" ON "routine_documents" USING btree ("company_id","routine_id","updated_at");

ALTER TABLE "document_annotation_threads" ADD COLUMN IF NOT EXISTS "routine_id" uuid;

ALTER TABLE "document_annotation_comments" ADD COLUMN IF NOT EXISTS "routine_id" uuid;

ALTER TABLE "document_annotation_threads" ALTER COLUMN "issue_id" DROP NOT NULL;

ALTER TABLE "document_annotation_comments" ALTER COLUMN "issue_id" DROP NOT NULL;

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'document_annotation_threads_routine_id_routines_id_fk'
	) THEN
		ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'document_annotation_comments_routine_id_routines_id_fk'
	) THEN
		ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'document_annotation_threads_owner_check'
	) THEN
		ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_owner_check" CHECK ("issue_id" IS NOT NULL OR "routine_id" IS NOT NULL);
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'document_annotation_comments_owner_check'
	) THEN
		ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_owner_check" CHECK ("issue_id" IS NOT NULL OR "routine_id" IS NOT NULL);
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS "document_annotation_threads_company_routine_status_idx" ON "document_annotation_threads" USING btree ("company_id","routine_id","status");

CREATE INDEX IF NOT EXISTS "document_annotation_comments_company_routine_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","routine_id","created_at");

DO $$
DECLARE
	routine_row RECORD;
	created_document_id uuid;
	created_revision_id uuid;
BEGIN
	FOR routine_row IN
		SELECT *
		FROM "routines"
		WHERE NOT EXISTS (
			SELECT 1
			FROM "routine_documents"
			WHERE "routine_documents"."routine_id" = "routines"."id"
				AND "routine_documents"."key" = 'description'
		)
	LOOP
		INSERT INTO "documents" (
			"company_id",
			"title",
			"format",
			"latest_body",
			"latest_revision_number",
			"created_by_agent_id",
			"created_by_user_id",
			"updated_by_agent_id",
			"updated_by_user_id",
			"created_at",
			"updated_at"
		)
		VALUES (
			routine_row."company_id",
			'routine description',
			'markdown',
			coalesce(routine_row."description", ''),
			1,
			routine_row."created_by_agent_id",
			routine_row."created_by_user_id",
			routine_row."updated_by_agent_id",
			routine_row."updated_by_user_id",
			coalesce(routine_row."created_at", now()),
			coalesce(routine_row."updated_at", now())
		)
		RETURNING "id" INTO created_document_id;

		INSERT INTO "document_revisions" (
			"company_id",
			"document_id",
			"revision_number",
			"title",
			"format",
			"body",
			"change_summary",
			"created_by_agent_id",
			"created_by_user_id",
			"created_at"
		)
		VALUES (
			routine_row."company_id",
			created_document_id,
			1,
			'routine description',
			'markdown',
			coalesce(routine_row."description", ''),
			'Backfilled routine description',
			routine_row."created_by_agent_id",
			routine_row."created_by_user_id",
			coalesce(routine_row."created_at", now())
		)
		RETURNING "id" INTO created_revision_id;

		UPDATE "documents"
		SET "latest_revision_id" = created_revision_id
		WHERE "id" = created_document_id;

		INSERT INTO "routine_documents" ("company_id", "routine_id", "document_id", "key", "created_at", "updated_at")
		VALUES (
			routine_row."company_id",
			routine_row."id",
			created_document_id,
			'description',
			coalesce(routine_row."created_at", now()),
			coalesce(routine_row."updated_at", now())
		)
		ON CONFLICT DO NOTHING;
	END LOOP;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e3086f4da253c6965b0a54c0532b6b16139c870fda7a0838f76b778b85708c65', 1781902300000);

-- >>> Migration: 0110_document_company_cascade.sql <<<
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'document_revisions_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "document_revisions" DROP CONSTRAINT "document_revisions_company_id_companies_id_fk";
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'document_revisions_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'documents_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "documents" DROP CONSTRAINT "documents_company_id_companies_id_fk";
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'documents_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('bd980c083453ee6e009694950c97e92c751b9d0d440a7776b855b76d61719027', 1781902400000);

-- >>> Migration: 0111_backfill_skill_create_human_defaults.sql <<<
INSERT INTO "principal_permission_grants" (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key",
  "scope",
  "granted_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  "company_id",
  'user',
  "principal_id",
  'skills:create',
  NULL,
  NULL,
  now(),
  now()
FROM "company_memberships"
WHERE "principal_type" = 'user'
  AND "status" = 'active'
  AND "membership_role" IN ('owner', 'admin')
ON CONFLICT (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key"
) DO NOTHING;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('c20c975d288f6afeea24658f07030b86992cebf03852dfbec7c50a1f052642b4', 1781902500000);

-- >>> Migration: 0112_rename_skill_create_permission_key.sql <<<
INSERT INTO "principal_permission_grants" (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key",
  "scope",
  "granted_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  "company_id",
  "principal_type",
  "principal_id",
  'skills:create',
  "scope",
  "granted_by_user_id",
  "created_at",
  now()
FROM "principal_permission_grants"
WHERE "permission_key" = 'skill:create'
ON CONFLICT (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key"
) DO NOTHING;

DELETE FROM "principal_permission_grants"
WHERE "permission_key" = 'skill:create';


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('0969f2f5bcd1468f39bc08a6f08035c43be1503f4f7de78dc66827a8ba7b8f1e', 1781902600000);

-- >>> Migration: 0113_pipeline_foundation.sql <<<
CREATE TABLE IF NOT EXISTS "pipeline_automation_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"automation_id" text NOT NULL,
	"triggering_event_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"status" text NOT NULL,
	"execution_issue_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_automation_executions_status_check" CHECK ("pipeline_automation_executions"."status" in ('succeeded', 'failed'))
);

CREATE TABLE IF NOT EXISTS "pipeline_case_blockers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"blocked_by_case_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_case_blockers_no_self_block_check" CHECK ("pipeline_case_blockers"."case_id" <> "pipeline_case_blockers"."blocked_by_case_id")
);

CREATE TABLE IF NOT EXISTS "pipeline_case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" text,
	"actor_agent_id" uuid,
	"run_id" uuid,
	"from_stage_id" uuid,
	"to_stage_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_case_events_type_check" CHECK ("pipeline_case_events"."type" in (
        'ingested',
        'updated',
        'claimed',
        'lease_released',
        'lease_expired',
        'transitioned',
        'transition_suggested',
        'suggestion_resolved',
        'review_decided',
        'conversation_opened',
        'issue_linked',
        'automation_executed',
        'automation_failed',
        'blockers_set',
        'blockers_resolved',
        'children_terminal'
      )),
	CONSTRAINT "pipeline_case_events_actor_type_check" CHECK ("pipeline_case_events"."actor_type" in ('user', 'agent', 'system')),
	CONSTRAINT "pipeline_case_events_agent_run_check" CHECK ("pipeline_case_events"."actor_type" <> 'agent' or "pipeline_case_events"."run_id" is not null)
);

CREATE TABLE IF NOT EXISTS "pipeline_case_issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_case_issue_links_role_check" CHECK ("pipeline_case_issue_links"."role" in ('origin', 'conversation', 'work', 'automation'))
);

CREATE TABLE IF NOT EXISTS "pipeline_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"case_key" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workspace_ref" jsonb,
	"parent_case_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"pending_suggestion" jsonb,
	"lease_owner_type" text,
	"lease_agent_id" uuid,
	"lease_user_id" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"terminal_kind" text,
	"terminal_at" timestamp with time zone,
	"child_count" integer DEFAULT 0 NOT NULL,
	"terminal_child_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"origin_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_cases_terminal_kind_check" CHECK ("pipeline_cases"."terminal_kind" is null or "pipeline_cases"."terminal_kind" in ('done', 'cancelled')),
	CONSTRAINT "pipeline_cases_lease_owner_type_check" CHECK ("pipeline_cases"."lease_owner_type" is null or "pipeline_cases"."lease_owner_type" in ('user', 'agent'))
);

CREATE TABLE IF NOT EXISTS "pipeline_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_stages_kind_check" CHECK ("pipeline_stages"."kind" in ('open', 'working', 'review', 'done', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS "pipeline_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"from_stage_id" uuid NOT NULL,
	"to_stage_id" uuid NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enforce_transitions" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "pipeline_automation_executions" ADD CONSTRAINT "pipeline_automation_executions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_automation_executions" ADD CONSTRAINT "pipeline_automation_executions_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_automation_executions" ADD CONSTRAINT "pipeline_automation_executions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_automation_executions" ADD CONSTRAINT "pipeline_automation_executions_execution_issue_id_issues_id_fk" FOREIGN KEY ("execution_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_case_blockers" ADD CONSTRAINT "pipeline_case_blockers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_case_blockers" ADD CONSTRAINT "pipeline_case_blockers_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_case_blockers" ADD CONSTRAINT "pipeline_case_blockers_blocked_by_case_id_pipeline_cases_id_fk" FOREIGN KEY ("blocked_by_case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_from_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_to_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_case_issue_links" ADD CONSTRAINT "pipeline_case_issue_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_case_issue_links" ADD CONSTRAINT "pipeline_case_issue_links_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_case_issue_links" ADD CONSTRAINT "pipeline_case_issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_parent_case_id_pipeline_cases_id_fk" FOREIGN KEY ("parent_case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_lease_agent_id_agents_id_fk" FOREIGN KEY ("lease_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_documents" ADD CONSTRAINT "pipeline_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_documents" ADD CONSTRAINT "pipeline_documents_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_documents" ADD CONSTRAINT "pipeline_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_transitions" ADD CONSTRAINT "pipeline_transitions_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_transitions" ADD CONSTRAINT "pipeline_transitions_from_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_transitions" ADD CONSTRAINT "pipeline_transitions_to_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_automation_executions_idempotency_uq" ON "pipeline_automation_executions" USING btree ("case_id","automation_id","triggering_event_id");
CREATE INDEX IF NOT EXISTS "pipeline_automation_executions_company_case_idx" ON "pipeline_automation_executions" USING btree ("company_id","case_id");
CREATE INDEX IF NOT EXISTS "pipeline_automation_executions_routine_idx" ON "pipeline_automation_executions" USING btree ("routine_id");
CREATE INDEX IF NOT EXISTS "pipeline_automation_executions_execution_issue_idx" ON "pipeline_automation_executions" USING btree ("execution_issue_id");
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_case_blockers_case_blocked_by_uq" ON "pipeline_case_blockers" USING btree ("case_id","blocked_by_case_id");
CREATE INDEX IF NOT EXISTS "pipeline_case_blockers_blocked_by_idx" ON "pipeline_case_blockers" USING btree ("blocked_by_case_id");
CREATE INDEX IF NOT EXISTS "pipeline_case_blockers_company_case_idx" ON "pipeline_case_blockers" USING btree ("company_id","case_id");
CREATE INDEX IF NOT EXISTS "pipeline_case_events_case_created_idx" ON "pipeline_case_events" USING btree ("case_id","created_at");
CREATE INDEX IF NOT EXISTS "pipeline_case_events_company_case_idx" ON "pipeline_case_events" USING btree ("company_id","case_id");
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_case_issue_links_case_issue_uq" ON "pipeline_case_issue_links" USING btree ("case_id","issue_id");
CREATE INDEX IF NOT EXISTS "pipeline_case_issue_links_issue_idx" ON "pipeline_case_issue_links" USING btree ("issue_id");
CREATE INDEX IF NOT EXISTS "pipeline_case_issue_links_company_case_idx" ON "pipeline_case_issue_links" USING btree ("company_id","case_id");
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_cases_pipeline_case_key_uq" ON "pipeline_cases" USING btree ("pipeline_id","case_key");
CREATE INDEX IF NOT EXISTS "pipeline_cases_company_idx" ON "pipeline_cases" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "pipeline_cases_pipeline_stage_idx" ON "pipeline_cases" USING btree ("pipeline_id","stage_id");
CREATE INDEX IF NOT EXISTS "pipeline_cases_parent_idx" ON "pipeline_cases" USING btree ("parent_case_id");
CREATE INDEX IF NOT EXISTS "pipeline_cases_lease_expires_idx" ON "pipeline_cases" USING btree ("lease_expires_at") WHERE "pipeline_cases"."lease_expires_at" is not null;
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_documents_company_pipeline_key_uq" ON "pipeline_documents" USING btree ("company_id","pipeline_id","key");
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_documents_document_uq" ON "pipeline_documents" USING btree ("document_id");
CREATE INDEX IF NOT EXISTS "pipeline_documents_company_pipeline_updated_idx" ON "pipeline_documents" USING btree ("company_id","pipeline_id","updated_at");
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_stages_pipeline_key_uq" ON "pipeline_stages" USING btree ("pipeline_id","key");
CREATE INDEX IF NOT EXISTS "pipeline_stages_pipeline_position_idx" ON "pipeline_stages" USING btree ("pipeline_id","position");
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_transitions_pipeline_edge_uq" ON "pipeline_transitions" USING btree ("pipeline_id","from_stage_id","to_stage_id");
CREATE INDEX IF NOT EXISTS "pipeline_transitions_pipeline_from_idx" ON "pipeline_transitions" USING btree ("pipeline_id","from_stage_id");
CREATE INDEX IF NOT EXISTS "pipeline_transitions_pipeline_to_idx" ON "pipeline_transitions" USING btree ("pipeline_id","to_stage_id");
CREATE UNIQUE INDEX IF NOT EXISTS "pipelines_company_key_uq" ON "pipelines" USING btree ("company_id","key");
CREATE INDEX IF NOT EXISTS "pipelines_company_idx" ON "pipelines" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "pipelines_company_project_idx" ON "pipelines" USING btree ("company_id","project_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('c0156b2cf2cc87932d840c30d252a185143c8be67d250cfd6d686948d0531fc1', 1781902700000);

-- >>> Migration: 0114_pipeline_case_issue_unlinked_event.sql <<<
-- Event-type constraint expansion is consolidated in 0121_pipeline_automation_retry_effects.sql.
-- Keep this journal entry as an idempotent placeholder for old branch-number upgrades.
ALTER TABLE "pipeline_case_events" DROP CONSTRAINT IF EXISTS "pipeline_case_events_0114_placeholder";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e9b0149172f59ce1524dce011c1f2637ab23d7271f92f3682e9ae3c5b56bf4e7', 1781902800000);

-- >>> Migration: 0115_pipeline_routine_origin.sql <<<
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "origin_kind" text DEFAULT 'manual' NOT NULL;
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "origin_id" text;
CREATE INDEX IF NOT EXISTS "routines_company_origin_idx" ON "routines" USING btree ("company_id","origin_kind","origin_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f08433ee3e7126d56abffa9d1305512b62627a301450f331541fdaea8b399e6e', 1781902900000);

-- >>> Migration: 0116_pipeline_upstream_drift_event.sql <<<
-- Event-type constraint expansion is consolidated in 0121_pipeline_automation_retry_effects.sql.
-- Keep this journal entry as an idempotent placeholder for old branch-number upgrades.
ALTER TABLE "pipeline_case_events" DROP CONSTRAINT IF EXISTS "pipeline_case_events_0116_placeholder";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('b297028be5a5f23f4e55441062182146ce312e9e58ab807c529744839ceecb95', 1781903000000);

-- >>> Migration: 0117_pipeline_transition_forced_event.sql <<<
-- Event-type constraint expansion is consolidated in 0121_pipeline_automation_retry_effects.sql.
-- Keep this journal entry as an idempotent placeholder for old branch-number upgrades.
ALTER TABLE "pipeline_case_events" DROP CONSTRAINT IF EXISTS "pipeline_case_events_0117_placeholder";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('01b7fb1d1e9325a7ad482ec3ccaae8ae96f0277a5c62667e21880dd700954ac5', 1781903100000);

-- >>> Migration: 0118_pipeline_case_agent_fanout.sql <<<
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "parent_case_version" integer;
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "request_key" text;
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_cases_parent_request_key_uq" ON "pipeline_cases" USING btree ("parent_case_id","request_key");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('5cdb096ac90c1f1287d3ccd245bd8005749e66f4e5c7ed2686937e9b46fc3ec2', 1781903200000);

-- >>> Migration: 0119_pipeline_drift_acknowledged_event.sql <<<
-- Event-type constraint expansion is consolidated in 0121_pipeline_automation_retry_effects.sql.
-- Keep this journal entry as an idempotent placeholder for old branch-number upgrades.
ALTER TABLE "pipeline_case_events" DROP CONSTRAINT IF EXISTS "pipeline_case_events_0119_placeholder";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('032e13b12757813e9149339e199a6f74d0be32763ec126c0fecfe66a745703bb', 1781903300000);

-- >>> Migration: 0120_pipeline_stage_working_primitives.sql <<<
UPDATE "pipeline_stages"
SET "kind" = 'working'
WHERE "kind" = 'open';

ALTER TABLE "pipeline_stages" DROP CONSTRAINT IF EXISTS "pipeline_stages_kind_check";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pipeline_stages_kind_check'
      AND conrelid = '"pipeline_stages"'::regclass
  ) THEN
    ALTER TABLE "pipeline_stages"
      ADD CONSTRAINT "pipeline_stages_kind_check"
      CHECK ("pipeline_stages"."kind" in ('working', 'review', 'done', 'cancelled'));
  END IF;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('b1a32f697fe739185c03ce695906ef962d263144bc4ae413e0b9685b24fc595d', 1781903400000);

-- >>> Migration: 0121_pipeline_automation_retry_effects.sql <<<
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "automation_attempt_id" uuid;
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "retired_by_attempt_id" uuid;
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "retired_reason" text;
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "hidden_from_board_at" timestamp with time zone;
ALTER TABLE "pipeline_case_issue_links" ADD COLUMN IF NOT EXISTS "automation_attempt_id" uuid;
ALTER TABLE "pipeline_case_issue_links" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
ALTER TABLE "pipeline_case_issue_links" ADD COLUMN IF NOT EXISTS "retired_by_attempt_id" uuid;
ALTER TABLE "pipeline_case_issue_links" ADD COLUMN IF NOT EXISTS "retired_reason" text;
ALTER TABLE "pipeline_automation_executions" ADD COLUMN IF NOT EXISTS "retry_of_execution_id" uuid;
ALTER TABLE "pipeline_automation_executions" ADD COLUMN IF NOT EXISTS "generation" integer DEFAULT 1 NOT NULL;
DROP INDEX IF EXISTS "pipeline_cases_parent_request_key_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_cases_parent_request_key_uq" ON "pipeline_cases" USING btree ("parent_case_id","request_key") WHERE "pipeline_cases"."request_key" is not null and "pipeline_cases"."retired_at" is null;
CREATE INDEX IF NOT EXISTS "pipeline_cases_automation_attempt_idx" ON "pipeline_cases" USING btree ("automation_attempt_id");
CREATE INDEX IF NOT EXISTS "pipeline_cases_retired_idx" ON "pipeline_cases" USING btree ("company_id","retired_at");
CREATE INDEX IF NOT EXISTS "pipeline_case_issue_links_automation_attempt_idx" ON "pipeline_case_issue_links" USING btree ("automation_attempt_id");
CREATE INDEX IF NOT EXISTS "pipeline_automation_executions_retry_of_execution_idx" ON "pipeline_automation_executions" USING btree ("retry_of_execution_id");
ALTER TABLE "pipeline_case_events" DROP CONSTRAINT IF EXISTS "pipeline_case_events_type_check";
ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_type_check" CHECK ("pipeline_case_events"."type" in (
        'ingested',
        'updated',
        'claimed',
        'lease_released',
        'lease_expired',
        'transitioned',
        'transition_forced',
        'transition_suggested',
        'suggestion_resolved',
        'review_decided',
        'conversation_opened',
        'issue_linked',
        'issue_unlinked',
        'automation_executed',
        'automation_failed',
        'automation_retry_requested',
        'automation_effects_retired',
        'automation_retry_dispatched',
        'blockers_set',
        'blockers_resolved',
        'children_terminal',
        'upstream_drift',
        'drift_acknowledged'
      ));


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('cd74d31745d9eb497577b1985a90fbb5e53a1af1e00a8272ed527c9a85709bc6', 1781903500000);

-- >>> Migration: 0122_pipeline_case_documents.sql <<<
CREATE TABLE IF NOT EXISTS "pipeline_case_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "pipeline_case_documents" ADD CONSTRAINT "pipeline_case_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_case_documents" ADD CONSTRAINT "pipeline_case_documents_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pipeline_case_documents" ADD CONSTRAINT "pipeline_case_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_case_documents_company_case_key_uq" ON "pipeline_case_documents" USING btree ("company_id","case_id","key");
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_case_documents_document_uq" ON "pipeline_case_documents" USING btree ("document_id");
CREATE INDEX IF NOT EXISTS "pipeline_case_documents_company_case_updated_idx" ON "pipeline_case_documents" USING btree ("company_id","case_id","updated_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('eead2cf41c1ac1e3413f6f56ef556b9c8895f40c1be84571ad313bcede68c36f', 1781903600000);

-- >>> Migration: 0123_document_annotation_source_trust.sql <<<
ALTER TABLE "document_annotation_comments" ADD COLUMN IF NOT EXISTS "source_trust" jsonb;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('858a19e7b436cd064fbf3c5462fee3055653667d336a2620a2c18a4a5012455a', 1781903700000);

-- >>> Migration: 0124_agent_api_key_scope_config.sql <<<
ALTER TABLE "agent_api_keys" ADD COLUMN IF NOT EXISTS "scope_config" jsonb;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('93ff6c94e14600c5f0e43aec79ce02b04cb344b2d1791df190c59a771a08e99f', 1782440000000);

-- >>> Migration: 0125_environment_custom_image_templates.sql <<<
CREATE TABLE "environment_custom_image_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "environment_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "template_kind" text DEFAULT 'unknown' NOT NULL,
  "template_ref" text NOT NULL,
  "source_template_ref" text,
  "source_environment_config_fingerprint" text,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by_user_id" text,
  "created_by_agent_id" uuid,
  "captured_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "superseded_by_template_id" uuid,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "environment_custom_image_setup_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "environment_id" uuid NOT NULL,
  "template_id" uuid,
  "promoted_template_id" uuid,
  "provider" text NOT NULL,
  "provider_lease_id" text,
  "environment_lease_id" uuid,
  "status" text DEFAULT 'starting' NOT NULL,
  "started_by_user_id" text,
  "started_by_agent_id" uuid,
  "base_template_ref" text,
  "expires_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "failure_reason" text,
  "connection_summary" jsonb,
  "connection_secret_ref" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "environment_custom_image_templates"
  ADD CONSTRAINT "environment_custom_image_templates_company_id_companies_id_fk"
  FOREIGN KEY ("company_id")
  REFERENCES "public"."companies"("id")
  ON DELETE cascade
  ON UPDATE no action;

ALTER TABLE "environment_custom_image_templates"
  ADD CONSTRAINT "environment_custom_image_templates_environment_id_environments_id_fk"
  FOREIGN KEY ("environment_id")
  REFERENCES "public"."environments"("id")
  ON DELETE cascade
  ON UPDATE no action;

ALTER TABLE "environment_custom_image_templates"
  ADD CONSTRAINT "environment_custom_image_templates_created_by_agent_id_agents_id_fk"
  FOREIGN KEY ("created_by_agent_id")
  REFERENCES "public"."agents"("id")
  ON DELETE set null
  ON UPDATE no action;

ALTER TABLE "environment_custom_image_templates"
  ADD CONSTRAINT "environment_custom_image_templates_superseded_by_template_id_fk"
  FOREIGN KEY ("superseded_by_template_id")
  REFERENCES "public"."environment_custom_image_templates"("id")
  ON DELETE set null
  ON UPDATE no action;

ALTER TABLE "environment_custom_image_setup_sessions"
  ADD CONSTRAINT "environment_custom_image_setup_sessions_company_id_companies_id_fk"
  FOREIGN KEY ("company_id")
  REFERENCES "public"."companies"("id")
  ON DELETE cascade
  ON UPDATE no action;

ALTER TABLE "environment_custom_image_setup_sessions"
  ADD CONSTRAINT "environment_custom_image_setup_sessions_environment_id_environments_id_fk"
  FOREIGN KEY ("environment_id")
  REFERENCES "public"."environments"("id")
  ON DELETE cascade
  ON UPDATE no action;

ALTER TABLE "environment_custom_image_setup_sessions"
  ADD CONSTRAINT "environment_custom_image_setup_sessions_template_id_fk"
  FOREIGN KEY ("template_id")
  REFERENCES "public"."environment_custom_image_templates"("id")
  ON DELETE set null
  ON UPDATE no action;

ALTER TABLE "environment_custom_image_setup_sessions"
  ADD CONSTRAINT "environment_custom_image_setup_sessions_promoted_template_id_fk"
  FOREIGN KEY ("promoted_template_id")
  REFERENCES "public"."environment_custom_image_templates"("id")
  ON DELETE set null
  ON UPDATE no action;

ALTER TABLE "environment_custom_image_setup_sessions"
  ADD CONSTRAINT "environment_custom_image_setup_sessions_environment_lease_id_environment_leases_id_fk"
  FOREIGN KEY ("environment_lease_id")
  REFERENCES "public"."environment_leases"("id")
  ON DELETE set null
  ON UPDATE no action;

ALTER TABLE "environment_custom_image_setup_sessions"
  ADD CONSTRAINT "environment_custom_image_setup_sessions_started_by_agent_id_agents_id_fk"
  FOREIGN KEY ("started_by_agent_id")
  REFERENCES "public"."agents"("id")
  ON DELETE set null
  ON UPDATE no action;

CREATE INDEX "environment_custom_image_templates_company_environment_status_idx"
  ON "environment_custom_image_templates" USING btree ("company_id", "environment_id", "status");

CREATE INDEX "environment_custom_image_templates_company_provider_status_idx"
  ON "environment_custom_image_templates" USING btree ("company_id", "provider", "status");

CREATE UNIQUE INDEX "environment_custom_image_templates_company_environment_active_uq"
  ON "environment_custom_image_templates" USING btree ("company_id", "environment_id")
  WHERE "status" = 'active';

CREATE INDEX "environment_custom_image_templates_superseded_by_idx"
  ON "environment_custom_image_templates" USING btree ("superseded_by_template_id");

CREATE INDEX "environment_custom_image_templates_company_last_used_idx"
  ON "environment_custom_image_templates" USING btree ("company_id", "last_used_at");

CREATE INDEX "environment_custom_image_setup_sessions_company_environment_status_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "environment_id", "status");

CREATE UNIQUE INDEX "environment_custom_image_setup_sessions_company_environment_active_uq"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "environment_id")
  WHERE "status" IN ('starting', 'waiting_for_user', 'capturing');

CREATE INDEX "environment_custom_image_setup_sessions_company_template_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "template_id");

CREATE INDEX "environment_custom_image_setup_sessions_company_promoted_template_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "promoted_template_id");

CREATE INDEX "environment_custom_image_setup_sessions_company_expires_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "expires_at");

CREATE INDEX "environment_custom_image_setup_sessions_provider_lease_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("provider", "provider_lease_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('6e7bb3ab7b6fbf9926d79a1ead40e205e1bb26d08f5ddcd93cbfa64cca1d6001', 1782440100000);

-- >>> Migration: 0127_environment_custom_images_instance_scoped.sql <<<
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "environment_custom_image_templates"
    WHERE "status" = 'active'
    GROUP BY "environment_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot migrate environment custom image templates to environment scope while multiple active templates exist for the same environment. Revoke or supersede the extra active templates before retrying.';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "environment_custom_image_setup_sessions"
    WHERE "status" IN ('starting', 'waiting_for_user', 'capturing')
    GROUP BY "environment_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot migrate environment custom image setup sessions to environment scope while multiple active sessions exist for the same environment. Finish or cancel the extra sessions before retrying.';
  END IF;
END $$;

UPDATE "environment_custom_image_templates"
SET
  "metadata" = jsonb_set(
    COALESCE("metadata", '{}'::jsonb),
    '{setupRpcCompanyId}',
    to_jsonb("company_id"::text),
    true
  ),
  "updated_at" = now()
WHERE "company_id" IS NOT NULL
  AND COALESCE("metadata" ->> 'setupRpcCompanyId', '') = '';

UPDATE "environment_custom_image_setup_sessions"
SET
  "metadata" = jsonb_set(
    COALESCE("metadata", '{}'::jsonb),
    '{setupRpcCompanyId}',
    to_jsonb("company_id"::text),
    true
  ),
  "updated_at" = now()
WHERE "company_id" IS NOT NULL
  AND COALESCE("metadata" ->> 'setupRpcCompanyId', '') = '';

DROP INDEX IF EXISTS "environment_custom_image_templates_company_environment_status_idx";

DROP INDEX IF EXISTS "environment_custom_image_templates_company_provider_status_idx";

DROP INDEX IF EXISTS "environment_custom_image_templates_company_environment_active_uq";

DROP INDEX IF EXISTS "environment_custom_image_templates_company_last_used_idx";

DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_environment_status_idx";

DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_environment_active_uq";

DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_template_idx";

DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_promoted_template_idx";

DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_expires_idx";

ALTER TABLE "environment_custom_image_templates"
  DROP CONSTRAINT IF EXISTS "environment_custom_image_templates_company_id_companies_id_fk";

ALTER TABLE "environment_custom_image_setup_sessions"
  DROP CONSTRAINT IF EXISTS "environment_custom_image_setup_sessions_company_id_companies_id_fk";

ALTER TABLE "environment_custom_image_templates" DROP COLUMN IF EXISTS "company_id";

ALTER TABLE "environment_custom_image_setup_sessions" DROP COLUMN IF EXISTS "company_id";

CREATE INDEX "environment_custom_image_templates_environment_status_idx"
  ON "environment_custom_image_templates" USING btree ("environment_id", "status");

CREATE INDEX "environment_custom_image_templates_environment_provider_status_idx"
  ON "environment_custom_image_templates" USING btree ("environment_id", "provider", "status");

CREATE UNIQUE INDEX "environment_custom_image_templates_environment_active_uq"
  ON "environment_custom_image_templates" USING btree ("environment_id")
  WHERE "status" = 'active';

CREATE INDEX "environment_custom_image_templates_last_used_idx"
  ON "environment_custom_image_templates" USING btree ("last_used_at");

CREATE INDEX "environment_custom_image_setup_sessions_environment_status_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("environment_id", "status");

CREATE UNIQUE INDEX "environment_custom_image_setup_sessions_environment_active_uq"
  ON "environment_custom_image_setup_sessions" USING btree ("environment_id")
  WHERE "status" IN ('starting', 'waiting_for_user', 'capturing');

CREATE INDEX "environment_custom_image_setup_sessions_template_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("template_id");

CREATE INDEX "environment_custom_image_setup_sessions_promoted_template_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("promoted_template_id");

CREATE INDEX "environment_custom_image_setup_sessions_expires_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("expires_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('d8cfa7214ff61af7d8a1d7219e1d13a93017b825df14b9061fc0faa3d5a70fa6', 1782526500000);

-- >>> Migration: 0128_user_specific_secrets.sql <<<
CREATE TABLE IF NOT EXISTS "user_secret_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"provider" text DEFAULT 'local_encrypted' NOT NULL,
	"managed_mode" text DEFAULT 'paperclip_managed' NOT NULL,
	"provider_config_id" uuid,
	"provider_metadata" jsonb,
	"usage_guidance" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "user_secret_declarations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_secret_definition_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"config_path" text NOT NULL,
	"env_key" text NOT NULL,
	"version_selector" text DEFAULT 'latest' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"allow_missing_override" boolean DEFAULT false NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'company' NOT NULL;

ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "owner_user_id" text;

ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "user_secret_definition_id" uuid;

UPDATE "company_secrets"
SET "scope" = 'company'
WHERE "scope" IS NULL;

ALTER TABLE "secret_access_events" ALTER COLUMN "secret_id" DROP NOT NULL;

ALTER TABLE "secret_access_events" ADD COLUMN IF NOT EXISTS "user_secret_definition_id" uuid;

ALTER TABLE "secret_access_events" ADD COLUMN IF NOT EXISTS "secret_scope" text DEFAULT 'company' NOT NULL;

ALTER TABLE "secret_access_events" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;

ALTER TABLE "secret_access_events" ADD COLUMN IF NOT EXISTS "credential_owner_user_id" text;

ALTER TABLE "secret_access_events" ADD COLUMN IF NOT EXISTS "credential_subject_type" text;

ALTER TABLE "secret_access_events" ADD COLUMN IF NOT EXISTS "credential_subject_id" text;

ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;

ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;

ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;

ALTER TABLE "routine_revisions" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;

ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_secret_definitions_company_id_companies_id_fk') THEN
		ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_secret_definitions_provider_config_id_company_secret_provider_configs_id_fk') THEN
		ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_provider_config_id_company_secret_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."company_secret_provider_configs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_secret_definitions_created_by_agent_id_agents_id_fk') THEN
		ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_secret_definitions_updated_by_agent_id_agents_id_fk') THEN
		ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_secret_declarations_company_id_companies_id_fk') THEN
		ALTER TABLE "user_secret_declarations" ADD CONSTRAINT "user_secret_declarations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_secret_declarations_user_secret_definition_id_user_secret_definitions_id_fk') THEN
		ALTER TABLE "user_secret_declarations" ADD CONSTRAINT "user_secret_declarations_user_secret_definition_id_user_secret_definitions_id_fk" FOREIGN KEY ("user_secret_definition_id") REFERENCES "public"."user_secret_definitions"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secrets_user_secret_definition_id_user_secret_definitions_id_fk') THEN
		ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_user_secret_definition_id_user_secret_definitions_id_fk" FOREIGN KEY ("user_secret_definition_id") REFERENCES "public"."user_secret_definitions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_user_secret_definition_id_user_secret_definitions_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_user_secret_definition_id_user_secret_definitions_id_fk" FOREIGN KEY ("user_secret_definition_id") REFERENCES "public"."user_secret_definitions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secrets_scope_shape_check') THEN
		ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_scope_shape_check" CHECK (
			("scope" = 'company' AND "owner_user_id" IS NULL AND "user_secret_definition_id" IS NULL)
			OR
			("scope" = 'user' AND "owner_user_id" IS NOT NULL AND "user_secret_definition_id" IS NOT NULL)
		);
	END IF;
END $$;

DROP INDEX IF EXISTS "company_secrets_company_name_uq";

DROP INDEX IF EXISTS "company_secrets_company_key_uq";

CREATE INDEX IF NOT EXISTS "user_secret_definitions_company_status_idx" ON "user_secret_definitions" USING btree ("company_id","status");

CREATE INDEX IF NOT EXISTS "user_secret_definitions_company_provider_idx" ON "user_secret_definitions" USING btree ("company_id","provider");

CREATE INDEX IF NOT EXISTS "user_secret_definitions_provider_config_idx" ON "user_secret_definitions" USING btree ("provider_config_id");

CREATE UNIQUE INDEX IF NOT EXISTS "user_secret_definitions_company_key_uq" ON "user_secret_definitions" USING btree ("company_id","key") WHERE "user_secret_definitions"."deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "user_secret_declarations_company_idx" ON "user_secret_declarations" USING btree ("company_id");

CREATE INDEX IF NOT EXISTS "user_secret_declarations_definition_idx" ON "user_secret_declarations" USING btree ("user_secret_definition_id");

CREATE INDEX IF NOT EXISTS "user_secret_declarations_target_idx" ON "user_secret_declarations" USING btree ("company_id","target_type","target_id");

CREATE INDEX IF NOT EXISTS "user_secret_declarations_company_required_idx" ON "user_secret_declarations" USING btree ("company_id","required");

CREATE UNIQUE INDEX IF NOT EXISTS "user_secret_declarations_target_path_uq" ON "user_secret_declarations" USING btree ("company_id","target_type","target_id","config_path");

CREATE INDEX IF NOT EXISTS "user_secret_declarations_required_override_idx" ON "user_secret_declarations" USING btree ("company_id","allow_missing_override") WHERE "user_secret_declarations"."allow_missing_override" = true;

CREATE INDEX IF NOT EXISTS "company_secrets_company_scope_idx" ON "company_secrets" USING btree ("company_id","scope");

CREATE INDEX IF NOT EXISTS "company_secrets_company_owner_idx" ON "company_secrets" USING btree ("company_id","owner_user_id");

CREATE INDEX IF NOT EXISTS "company_secrets_user_definition_owner_idx" ON "company_secrets" USING btree ("company_id","user_secret_definition_id","owner_user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "company_secrets_company_name_uq" ON "company_secrets" USING btree ("company_id","name") WHERE "company_secrets"."scope" = 'company' AND "company_secrets"."deleted_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "company_secrets_company_key_uq" ON "company_secrets" USING btree ("company_id","key") WHERE "company_secrets"."scope" = 'company' AND "company_secrets"."deleted_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "company_secrets_user_definition_owner_uq" ON "company_secrets" USING btree ("company_id","user_secret_definition_id","owner_user_id") WHERE "company_secrets"."scope" = 'user' AND "company_secrets"."deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "secret_access_events_user_definition_created_idx" ON "secret_access_events" USING btree ("user_secret_definition_id","created_at");

CREATE INDEX IF NOT EXISTS "secret_access_events_company_credential_owner_idx" ON "secret_access_events" USING btree ("company_id","credential_owner_user_id","created_at");

CREATE INDEX IF NOT EXISTS "issues_company_responsible_user_idx" ON "issues" USING btree ("company_id","responsible_user_id");

CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_responsible_user_idx" ON "heartbeat_runs" USING btree ("company_id","responsible_user_id","created_at");

CREATE INDEX IF NOT EXISTS "routines_company_responsible_user_idx" ON "routines" USING btree ("company_id","responsible_user_id");

CREATE INDEX IF NOT EXISTS "routine_revisions_company_responsible_user_idx" ON "routine_revisions" USING btree ("company_id","responsible_user_id","created_at");

CREATE INDEX IF NOT EXISTS "routine_runs_company_responsible_user_idx" ON "routine_runs" USING btree ("company_id","responsible_user_id","created_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2d9414e39118d66da51a1c314deb040ffc845ae8d56fbfb1ab4c309f37facdc9', 1782923938661);

-- >>> Migration: 0129_agent_api_key_responsible_user.sql <<<
ALTER TABLE "agent_api_keys" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;

UPDATE "agent_api_keys" AS key
SET "responsible_user_id" = created_by."responsible_user_id"
FROM (
  SELECT DISTINCT ON (key_id)
    key_id,
    responsible_user_id
  FROM (
    SELECT
      log.details ->> 'keyId' AS key_id,
      log.actor_id AS responsible_user_id,
      log.created_at
    FROM "activity_log" AS log
    WHERE log.action = 'agent.key_created'
      AND log.actor_type = 'user'
      AND log.details ->> 'keyId' IS NOT NULL
      AND log.actor_id IS NOT NULL
      AND log.actor_id <> ''

    UNION ALL

    SELECT
      log.entity_id AS key_id,
      request.approved_by_user_id AS responsible_user_id,
      log.created_at
    FROM "activity_log" AS log
    INNER JOIN "join_requests" AS request
      ON request.id::text = log.details ->> 'joinRequestId'
    WHERE log.action = 'agent_api_key.claimed'
      AND log.entity_type = 'agent_api_key'
      AND log.entity_id IS NOT NULL
      AND request.approved_by_user_id IS NOT NULL
      AND request.approved_by_user_id <> ''
  ) AS candidates
  WHERE responsible_user_id IS NOT NULL
    AND responsible_user_id <> ''
  ORDER BY key_id, created_at ASC
) AS created_by
WHERE key.id::text = created_by.key_id
  AND key.responsible_user_id IS NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('a4a8e487517fba73b569a2f9aadbdf870b77a34e01b8bea0a43c3d4c88ce2a50', 1783025124120);

-- >>> Migration: 0131_repair_run_responsible_user_context_refs.sql <<<
WITH extracted_run_refs AS (
  SELECT
    h."id" AS "run_id",
    h."company_id",
    NULLIF(h."context_snapshot" ->> 'issueId', '') AS "issue_ref",
    1 AS "ref_priority"
  FROM "heartbeat_runs" AS h
  WHERE h."responsible_user_id" IS NULL
    AND NULLIF(h."context_snapshot" ->> 'issueId', '') IS NOT NULL

  UNION ALL

  SELECT
    h."id" AS "run_id",
    h."company_id",
    NULLIF(h."context_snapshot" ->> 'taskId', '') AS "issue_ref",
    2 AS "ref_priority"
  FROM "heartbeat_runs" AS h
  WHERE h."responsible_user_id" IS NULL
    AND NULLIF(h."context_snapshot" ->> 'taskId', '') IS NOT NULL
),
uuid_run_refs AS (
  SELECT
    "run_id",
    "company_id",
    "issue_ref"::uuid AS "issue_id",
    "ref_priority"
  FROM extracted_run_refs
  WHERE "issue_ref" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
resolved_run_users AS (
  SELECT DISTINCT ON ("run_id")
    "run_id",
    "responsible_user_id"
  FROM (
    SELECT
      refs."run_id",
      i."responsible_user_id",
      refs."ref_priority",
      1 AS "match_priority"
    FROM uuid_run_refs AS refs
    JOIN "issues" AS i
      ON i."id" = refs."issue_id"
     AND i."company_id" = refs."company_id"
    WHERE i."responsible_user_id" IS NOT NULL

    UNION ALL

    SELECT
      refs."run_id",
      i."responsible_user_id",
      refs."ref_priority",
      2 AS "match_priority"
    FROM extracted_run_refs AS refs
    JOIN "issues" AS i
      ON i."identifier" = refs."issue_ref"
     AND i."company_id" = refs."company_id"
    WHERE i."responsible_user_id" IS NOT NULL
  ) AS candidates
  ORDER BY "run_id", "ref_priority" ASC, "match_priority" ASC
)
UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = resolved_run_users."responsible_user_id",
    "updated_at" = now()
FROM resolved_run_users
WHERE h."id" = resolved_run_users."run_id"
  AND h."responsible_user_id" IS NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('658a85151f870f1f89a3d3de61cde0f1b39bbc99a35c4bb27710590762d65a8d', 1783025324120);

-- >>> Migration: 0132_issue_comment_derived_attribution_fast.sql <<<
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "derived_author_agent_id" uuid;
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "derived_created_by_run_id" uuid;
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "derived_author_source" text;
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'issue_comments_derived_author_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_derived_author_agent_id_agents_id_fk" FOREIGN KEY ("derived_author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'issue_comments_derived_created_by_run_id_heartbeat_runs_id_fk'
	) THEN
		ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_derived_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("derived_created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
-- Temporary support for the forward-only backfill. The keyset loop below
-- advances over this partial index by comment id, so each eligible slice is
-- visited once instead of re-scanning issue_comments from the beginning on
-- every batch.
CREATE INDEX IF NOT EXISTS "issue_comments_derived_attribution_backfill_idx"
	ON "issue_comments" USING btree ("id")
	WHERE "author_agent_id" IS NULL
		AND "derived_author_agent_id" IS NULL
		AND "author_user_id" IS NOT NULL
		AND "created_by_run_id" IS NOT NULL;
ANALYZE "issue_comments";
DO $$
DECLARE
	last_comment_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
	next_last_comment_id uuid;
BEGIN
	LOOP
		next_last_comment_id := NULL;

		WITH batch AS MATERIALIZED (
			SELECT c."id" AS comment_id, hr."agent_id", hr."id" AS run_id
			FROM "issue_comments" c
			JOIN "heartbeat_runs" hr ON hr."id" = c."created_by_run_id"
			LEFT JOIN "user" u ON u."id" = c."author_user_id"
			WHERE c."id" > last_comment_id
				AND c."author_agent_id" IS NULL
				AND c."derived_author_agent_id" IS NULL
				AND c."author_user_id" IS NOT NULL
				AND c."created_by_run_id" IS NOT NULL
				AND (
					c."author_user_id" = 'local-board'
					OR u."id" IS NULL
				)
			ORDER BY c."id"
			LIMIT 5000
		),
		updated AS (
			UPDATE "issue_comments" c
			SET "derived_author_agent_id" = b."agent_id",
				"derived_created_by_run_id" = b."run_id",
				"derived_author_source" = 'run_id'
			FROM batch b
			WHERE c."id" = b."comment_id"
			RETURNING c."id"
		)
		SELECT b."comment_id"
		INTO next_last_comment_id
		FROM batch b
		LEFT JOIN updated u ON u."id" = b."comment_id"
		ORDER BY b."comment_id" DESC
		LIMIT 1;

		EXIT WHEN next_last_comment_id IS NULL;
		last_comment_id := next_last_comment_id;
	END LOOP;
END $$;
DROP INDEX IF EXISTS "issue_comments_derived_attribution_backfill_idx";
-- Keep the Option-A cleanup at the end as well, matching the original 0126
-- terminal state if any timing-tier rows are introduced before this migration
-- is retried.
UPDATE "issue_comments"
SET "derived_author_agent_id" = NULL,
	"derived_created_by_run_id" = NULL,
	"derived_author_source" = NULL
WHERE "derived_author_source" IN ('run_window_unique', 'run_window_agent_unique');


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('80408941e435179af5441ec3c8207d7e31a78520d1ff8d18f3b8fe879ebde17d', 1783025424120);

-- >>> Migration: 0133_resource_membership_stars.sql <<<
ALTER TABLE "agent_memberships" ADD COLUMN IF NOT EXISTS "starred_at" timestamp with time zone;

ALTER TABLE "project_memberships" ADD COLUMN IF NOT EXISTS "starred_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "agent_memberships_company_user_starred_idx" ON "agent_memberships" USING btree ("company_id","user_id","starred_at");

CREATE INDEX IF NOT EXISTS "project_memberships_company_user_starred_idx" ON "project_memberships" USING btree ("company_id","user_id","starred_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('c2a7336b58e93aee41c48ffcf9bed6a2ca6255407a9e49b493ddbdf6deccc3b1', 1783034521000);

-- >>> Migration: 0134_run_responsible_user_invariant.sql <<<
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "default_responsible_user_id" text;

WITH owner_defaults AS (
  SELECT DISTINCT ON ("company_id")
    "company_id",
    "principal_id" AS "user_id"
  FROM "company_memberships"
  WHERE "principal_type" = 'user'
    AND "status" = 'active'
    AND "membership_role" = 'owner'
  ORDER BY "company_id", "created_at" ASC, "id" ASC
)
UPDATE "companies" AS c
SET "default_responsible_user_id" = owner_defaults."user_id"
FROM owner_defaults
WHERE c."id" = owner_defaults."company_id"
  AND c."default_responsible_user_id" IS NULL;

WITH RECURSIVE issue_chain AS (
  SELECT
    child."id" AS "issue_id",
    child."company_id",
    child."parent_id",
    child."responsible_user_id",
    child."created_by_user_id",
    0 AS "depth"
  FROM "issues" AS child
  WHERE child."responsible_user_id" IS NULL
  UNION ALL
  SELECT
    issue_chain."issue_id",
    parent."company_id",
    parent."parent_id",
    parent."responsible_user_id",
    parent."created_by_user_id",
    issue_chain."depth" + 1
  FROM issue_chain
  JOIN "issues" AS parent
    ON parent."id" = issue_chain."parent_id"
   AND parent."company_id" = issue_chain."company_id"
  WHERE issue_chain."depth" < 50
),
resolved_issue_users AS (
  SELECT DISTINCT ON ("issue_id")
    "issue_id",
    COALESCE("responsible_user_id", "created_by_user_id") AS "user_id"
  FROM issue_chain
  WHERE COALESCE("responsible_user_id", "created_by_user_id") IS NOT NULL
  ORDER BY "issue_id", "depth" ASC
)
UPDATE "issues" AS i
SET "responsible_user_id" = resolved_issue_users."user_id"
FROM resolved_issue_users
WHERE i."id" = resolved_issue_users."issue_id"
  AND i."responsible_user_id" IS NULL;

UPDATE "issues" AS i
SET "responsible_user_id" = c."default_responsible_user_id"
FROM "companies" AS c
WHERE i."company_id" = c."id"
  AND i."responsible_user_id" IS NULL
  AND c."default_responsible_user_id" IS NOT NULL;

WITH routine_responsible_users AS (
  SELECT
    r."id",
    COALESCE(r."created_by_user_id", parent_issue."responsible_user_id", c."default_responsible_user_id") AS "user_id"
  FROM "routines" AS r
  JOIN "companies" AS c ON c."id" = r."company_id"
  LEFT JOIN "issues" AS parent_issue
    ON parent_issue."id" = r."parent_issue_id"
   AND parent_issue."company_id" = r."company_id"
  WHERE r."responsible_user_id" IS NULL
)
UPDATE "routines" AS r
SET "responsible_user_id" = routine_responsible_users."user_id"
FROM routine_responsible_users
WHERE r."id" = routine_responsible_users."id"
  AND routine_responsible_users."user_id" IS NOT NULL;

WITH routine_revision_responsible_users AS (
  SELECT
    rr."id",
    COALESCE(rr."created_by_user_id", r."responsible_user_id", c."default_responsible_user_id") AS "user_id"
  FROM "routine_revisions" AS rr
  JOIN "routines" AS r
    ON rr."routine_id" = r."id"
   AND rr."company_id" = r."company_id"
  JOIN "companies" AS c ON c."id" = rr."company_id"
  WHERE rr."responsible_user_id" IS NULL
)
UPDATE "routine_revisions" AS rr
SET "responsible_user_id" = routine_revision_responsible_users."user_id"
FROM routine_revision_responsible_users
WHERE rr."id" = routine_revision_responsible_users."id"
  AND routine_revision_responsible_users."user_id" IS NOT NULL;

WITH routine_run_responsible_users AS (
  SELECT
    rr."id",
    COALESCE(linked_issue."responsible_user_id", r."responsible_user_id", c."default_responsible_user_id") AS "user_id"
  FROM "routine_runs" AS rr
  JOIN "routines" AS r
    ON rr."routine_id" = r."id"
   AND rr."company_id" = r."company_id"
  JOIN "companies" AS c ON c."id" = rr."company_id"
  LEFT JOIN "issues" AS linked_issue
    ON linked_issue."id" = rr."linked_issue_id"
   AND linked_issue."company_id" = rr."company_id"
  WHERE rr."responsible_user_id" IS NULL
)
UPDATE "routine_runs" AS rr
SET "responsible_user_id" = routine_run_responsible_users."user_id"
FROM routine_run_responsible_users
WHERE rr."id" = routine_run_responsible_users."id"
  AND routine_run_responsible_users."user_id" IS NOT NULL;

UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = original."responsible_user_id"
FROM "heartbeat_runs" AS original
WHERE h."retry_of_run_id" = original."id"
  AND h."company_id" = original."company_id"
  AND h."responsible_user_id" IS NULL
  AND original."responsible_user_id" IS NOT NULL;

WITH extracted_run_refs AS (
  SELECT
    h."id" AS "run_id",
    h."company_id",
    NULLIF(h."context_snapshot" ->> 'issueId', '') AS "issue_ref",
    1 AS "ref_priority"
  FROM "heartbeat_runs" AS h
  WHERE h."responsible_user_id" IS NULL
    AND NULLIF(h."context_snapshot" ->> 'issueId', '') IS NOT NULL

  UNION ALL

  SELECT
    h."id" AS "run_id",
    h."company_id",
    NULLIF(h."context_snapshot" ->> 'taskId', '') AS "issue_ref",
    2 AS "ref_priority"
  FROM "heartbeat_runs" AS h
  WHERE h."responsible_user_id" IS NULL
    AND NULLIF(h."context_snapshot" ->> 'taskId', '') IS NOT NULL
),
uuid_run_refs AS (
  SELECT
    "run_id",
    "company_id",
    "issue_ref"::uuid AS "issue_id",
    "ref_priority"
  FROM extracted_run_refs
  WHERE "issue_ref" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
resolved_run_users AS (
  SELECT DISTINCT ON ("run_id")
    "run_id",
    "responsible_user_id"
  FROM (
    SELECT
      refs."run_id",
      i."responsible_user_id",
      refs."ref_priority",
      1 AS "match_priority"
    FROM uuid_run_refs AS refs
    JOIN "issues" AS i
      ON i."id" = refs."issue_id"
     AND i."company_id" = refs."company_id"
    WHERE i."responsible_user_id" IS NOT NULL

    UNION ALL

    SELECT
      refs."run_id",
      i."responsible_user_id",
      refs."ref_priority",
      2 AS "match_priority"
    FROM extracted_run_refs AS refs
    JOIN "issues" AS i
      ON i."identifier" = refs."issue_ref"
     AND i."company_id" = refs."company_id"
    WHERE refs."issue_ref" IS NOT NULL
      AND i."responsible_user_id" IS NOT NULL
  ) AS candidates
  ORDER BY "run_id", "ref_priority" ASC, "match_priority" ASC
)
UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = resolved_run_users."responsible_user_id"
FROM resolved_run_users
WHERE h."id" = resolved_run_users."run_id"
  AND h."responsible_user_id" IS NULL;

UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = awr."requested_by_actor_id"
FROM "agent_wakeup_requests" AS awr
WHERE h."wakeup_request_id" = awr."id"
  AND h."company_id" = awr."company_id"
  AND h."responsible_user_id" IS NULL
  AND awr."requested_by_actor_type" = 'user'
  AND awr."requested_by_actor_id" IS NOT NULL;

UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = c."default_responsible_user_id"
FROM "companies" AS c
WHERE h."company_id" = c."id"
  AND h."responsible_user_id" IS NULL
  AND c."default_responsible_user_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "companies_default_responsible_user_idx"
  ON "companies" ("default_responsible_user_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('563b78f4ae4eb586820ecb9cdce5994b64ee840a6edc75e6a0e7feaf1f184630', 1783025624120);

-- >>> Migration: 0135_repair_run_responsible_user_updated_at_sweep.sql <<<
DROP TABLE IF EXISTS "run_responsible_user_updated_at_sweeps";

CREATE TEMP TABLE "run_responsible_user_updated_at_sweeps" ON COMMIT DROP AS
SELECT i."company_id", i."updated_at" AS "sweep_at"
FROM "issues" AS i
WHERE EXISTS (
    SELECT 1
    FROM "heartbeat_runs" AS h
    WHERE h."company_id" = i."company_id"
      AND h."updated_at" = i."updated_at"
  )
  AND EXISTS (
    SELECT 1
    FROM "companies" AS c
    WHERE c."id" = i."company_id"
      AND c."updated_at" = i."updated_at"
  )
GROUP BY i."company_id", i."updated_at"
HAVING count(*) > 100;

UPDATE "issues" AS i
SET "updated_at" = GREATEST(
  i."created_at",
  COALESCE(CASE WHEN i."started_at" <= sweep."sweep_at" THEN i."started_at" END, i."created_at"),
  COALESCE(CASE WHEN i."completed_at" <= sweep."sweep_at" THEN i."completed_at" END, i."created_at"),
  COALESCE(CASE WHEN i."cancelled_at" <= sweep."sweep_at" THEN i."cancelled_at" END, i."created_at"),
  COALESCE(CASE WHEN i."monitor_wake_requested_at" <= sweep."sweep_at" THEN i."monitor_wake_requested_at" END, i."created_at"),
  COALESCE(CASE WHEN i."monitor_last_triggered_at" <= sweep."sweep_at" THEN i."monitor_last_triggered_at" END, i."created_at"),
  COALESCE(
    (
      SELECT max(GREATEST(c."created_at", c."updated_at"))
      FROM "issue_comments" AS c
      WHERE c."company_id" = i."company_id"
        AND c."issue_id" = i."id"
        AND c."created_at" <= sweep."sweep_at"
        AND c."updated_at" <= sweep."sweep_at"
    ),
    i."created_at"
  )
)
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE i."company_id" = sweep."company_id"
  AND i."updated_at" = sweep."sweep_at";

UPDATE "heartbeat_runs" AS h
SET "updated_at" = GREATEST(
  h."created_at",
  COALESCE(CASE WHEN h."started_at" <= sweep."sweep_at" THEN h."started_at" END, h."created_at"),
  COALESCE(CASE WHEN h."process_started_at" <= sweep."sweep_at" THEN h."process_started_at" END, h."created_at"),
  COALESCE(CASE WHEN h."last_output_at" <= sweep."sweep_at" THEN h."last_output_at" END, h."created_at"),
  COALESCE(CASE WHEN h."scheduled_retry_at" <= sweep."sweep_at" THEN h."scheduled_retry_at" END, h."created_at"),
  COALESCE(CASE WHEN h."finished_at" <= sweep."sweep_at" THEN h."finished_at" END, h."created_at")
)
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE h."company_id" = sweep."company_id"
  AND h."updated_at" = sweep."sweep_at";

UPDATE "routine_runs" AS rr
SET "updated_at" = GREATEST(
  rr."created_at",
  COALESCE(CASE WHEN rr."triggered_at" <= sweep."sweep_at" THEN rr."triggered_at" END, rr."created_at"),
  COALESCE(CASE WHEN rr."completed_at" <= sweep."sweep_at" THEN rr."completed_at" END, rr."created_at")
)
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE rr."company_id" = sweep."company_id"
  AND rr."updated_at" = sweep."sweep_at";

UPDATE "routines" AS r
SET "updated_at" = GREATEST(
  r."created_at",
  COALESCE(CASE WHEN r."last_triggered_at" <= sweep."sweep_at" THEN r."last_triggered_at" END, r."created_at"),
  COALESCE(CASE WHEN r."last_enqueued_at" <= sweep."sweep_at" THEN r."last_enqueued_at" END, r."created_at")
)
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE r."company_id" = sweep."company_id"
  AND r."updated_at" = sweep."sweep_at";

UPDATE "companies" AS c
SET "updated_at" = c."created_at"
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE c."id" = sweep."company_id"
  AND c."updated_at" = sweep."sweep_at";

DROP TABLE IF EXISTS "run_responsible_user_updated_at_sweeps";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('fbe54ea1f702caf6241850697cbf6519e7d114641126db6ef469f38375c1815d', 1783025724120);

-- >>> Migration: 0136_acpx_default_engine_migration.sql <<<
WITH migrated_agents AS (
  SELECT
    "id",
    "company_id",
    CASE lower(COALESCE(NULLIF("adapter_config" ->> 'agent', ''), 'claude'))
      WHEN 'codex' THEN 'codex_local'
      ELSE 'claude_local'
    END AS "next_adapter_type",
    CASE lower(COALESCE(NULLIF("adapter_config" ->> 'agent', ''), 'claude'))
      WHEN 'codex' THEN
        (
          "adapter_config"
            - 'agent'
            - 'effort'
            - 'reasoningEffort'
            - 'thinkingEffort'
        )
        || jsonb_build_object('engine', 'acp')
        || CASE
          WHEN COALESCE(
            "adapter_config" -> 'modelReasoningEffort',
            "adapter_config" -> 'reasoningEffort',
            "adapter_config" -> 'thinkingEffort',
            "adapter_config" -> 'effort'
          ) IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object(
            'modelReasoningEffort',
            COALESCE(
              "adapter_config" -> 'modelReasoningEffort',
              "adapter_config" -> 'reasoningEffort',
              "adapter_config" -> 'thinkingEffort',
              "adapter_config" -> 'effort'
            )
          )
        END
      ELSE
        (
          "adapter_config"
            - 'agent'
            - 'modelReasoningEffort'
            - 'reasoningEffort'
            - 'thinkingEffort'
        )
        || jsonb_build_object('engine', 'acp')
        || CASE
          WHEN COALESCE(
            "adapter_config" -> 'effort',
            "adapter_config" -> 'thinkingEffort',
            "adapter_config" -> 'reasoningEffort',
            "adapter_config" -> 'modelReasoningEffort'
          ) IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object(
            'effort',
            COALESCE(
              "adapter_config" -> 'effort',
              "adapter_config" -> 'thinkingEffort',
              "adapter_config" -> 'reasoningEffort',
              "adapter_config" -> 'modelReasoningEffort'
            )
          )
        END
    END AS "next_adapter_config"
  FROM "agents"
  WHERE "adapter_type" = 'acpx_local'
    AND lower(COALESCE(NULLIF("adapter_config" ->> 'agent', ''), 'claude')) IN ('claude', 'codex')
),
updated_agents AS (
  UPDATE "agents"
  SET
    "adapter_type" = migrated_agents."next_adapter_type",
    "adapter_config" = migrated_agents."next_adapter_config",
    "updated_at" = now()
  FROM migrated_agents
  WHERE "agents"."id" = migrated_agents."id"
  RETURNING
    "agents"."id",
    "agents"."company_id",
    migrated_agents."next_adapter_type"
),
cleared_task_sessions AS (
  DELETE FROM "agent_task_sessions"
  USING updated_agents
  WHERE "agent_task_sessions"."agent_id" = updated_agents."id"
    AND "agent_task_sessions"."company_id" = updated_agents."company_id"
    AND "agent_task_sessions"."adapter_type" = 'acpx_local'
  RETURNING "agent_task_sessions"."id"
)
UPDATE "agent_runtime_state"
SET
  "adapter_type" = updated_agents."next_adapter_type",
  "session_id" = NULL,
  "state_json" = '{}'::jsonb,
  "last_error" = NULL,
  "updated_at" = now()
FROM updated_agents
WHERE "agent_runtime_state"."agent_id" = updated_agents."id"
  AND "agent_runtime_state"."company_id" = updated_agents."company_id";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('c9b2d8c4fbb751d67ff118ba66ce7efb6583346bd8883e1a69b62565b48a29b6', 1783555200000);

-- >>> Migration: 0137_skill_studio_server_foundation.sql <<<
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "harness_kind" text;
CREATE INDEX IF NOT EXISTS "issues_company_harness_kind_idx" ON "issues" USING btree ("company_id","harness_kind");
CREATE TABLE IF NOT EXISTS "company_skill_test_inputs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "name" text NOT NULL,
  "content" text NOT NULL,
  "created_by" text,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "company_skill_test_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "input_id" uuid,
  "input_snapshot" text NOT NULL,
  "skill_version_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "agent_config_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "issue_id" uuid NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "output_document_key" text DEFAULT 'output' NOT NULL,
  "output_snapshot" text DEFAULT '' NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "company_skill_test_inputs" ADD CONSTRAINT "company_skill_test_inputs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_test_inputs" ADD CONSTRAINT "company_skill_test_inputs_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_test_runs" ADD CONSTRAINT "company_skill_test_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_test_runs" ADD CONSTRAINT "company_skill_test_runs_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_test_runs" ADD CONSTRAINT "company_skill_test_runs_input_id_company_skill_test_inputs_id_fk" FOREIGN KEY ("input_id") REFERENCES "public"."company_skill_test_inputs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_test_runs" ADD CONSTRAINT "company_skill_test_runs_skill_version_id_company_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."company_skill_versions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_test_runs" ADD CONSTRAINT "company_skill_test_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "company_skill_test_runs" ADD CONSTRAINT "company_skill_test_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "company_skill_test_inputs_company_skill_name_idx" ON "company_skill_test_inputs" USING btree ("company_id","skill_id","name");
CREATE INDEX IF NOT EXISTS "company_skill_test_inputs_company_skill_active_idx" ON "company_skill_test_inputs" USING btree ("company_id","skill_id","deleted_at");
CREATE INDEX IF NOT EXISTS "company_skill_test_runs_company_skill_created_idx" ON "company_skill_test_runs" USING btree ("company_id","skill_id","created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_test_runs_company_issue_idx" ON "company_skill_test_runs" USING btree ("company_id","issue_id");
CREATE INDEX IF NOT EXISTS "company_skill_test_runs_company_input_created_idx" ON "company_skill_test_runs" USING btree ("company_id","input_id","created_at");
CREATE INDEX IF NOT EXISTS "company_skill_test_runs_company_status_idx" ON "company_skill_test_runs" USING btree ("company_id","status");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('7a040c0e0a5b8924ce9d82eadfd324d811fb9f290b28eb4fa882fe0ac9f551b3', 1783555201000);

-- >>> Migration: 0138_skill_studio_run_retention.sql <<<
ALTER TABLE "company_skill_test_runs" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
ALTER TABLE "company_skill_test_runs" ADD COLUMN IF NOT EXISTS "superseded_at" timestamp with time zone;
ALTER TABLE "company_skill_test_runs" ADD COLUMN IF NOT EXISTS "harness_issue_expires_at" timestamp with time zone;
ALTER TABLE "company_skill_test_runs" ADD COLUMN IF NOT EXISTS "harness_issue_deleted_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "company_skill_test_runs_company_harness_expires_idx" ON "company_skill_test_runs" USING btree ("company_id","harness_issue_expires_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e1942e00e81f24b0fbb0f5ba38d87962182bc6be529a70fde7f071dc311e5ebb', 1783555202000);

-- >>> Migration: 0139_skill_studio_run_templates.sql <<<
CREATE TABLE IF NOT EXISTS "company_skill_test_run_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "body" text NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "updated_by_agent_id" uuid,
  "updated_by_user_id" text,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "company_skill_test_run_templates" ADD CONSTRAINT "company_skill_test_run_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "company_skill_test_run_templates" ADD CONSTRAINT "company_skill_test_run_templates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "company_skill_test_run_templates" ADD CONSTRAINT "company_skill_test_run_templates_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "company_skill_test_run_templates_company_active_idx" ON "company_skill_test_run_templates" USING btree ("company_id","deleted_at","name");

ALTER TABLE "company_skill_test_runs" ADD COLUMN IF NOT EXISTS "template_id" text;

ALTER TABLE "company_skill_test_runs" ADD COLUMN IF NOT EXISTS "template_name" text;

ALTER TABLE "company_skill_test_runs" ADD COLUMN IF NOT EXISTS "template_body" text;

ALTER TABLE "company_skill_test_runs" ADD COLUMN IF NOT EXISTS "rendered_template_body" text;

ALTER TABLE "company_skill_test_runs" ADD COLUMN IF NOT EXISTS "harness_issue_description" text DEFAULT '' NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('bc9f1e4e1a969d08b667fffab14fe9ae3a94a13fc194d0749dedc12cff744165', 1783555203000);

-- >>> Migration: 0140_built_in_managed_resources.sql <<<
CREATE TABLE IF NOT EXISTS "built_in_managed_resources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "bundle_key" text NOT NULL,
  "resource_kind" text NOT NULL,
  "resource_key" text NOT NULL,
  "resource_id" uuid NOT NULL,
  "stock_version" text NOT NULL,
  "stock_hash" text NOT NULL,
  "defaults_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);


DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint" c
    JOIN "pg_class" t ON t.oid = c.conrelid
    JOIN "pg_namespace" n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'built_in_managed_resources'
      AND c.conname = 'built_in_managed_resources_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "built_in_managed_resources"
      ADD CONSTRAINT "built_in_managed_resources_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;


CREATE INDEX IF NOT EXISTS "built_in_managed_resources_company_idx"
  ON "built_in_managed_resources" ("company_id");


CREATE INDEX IF NOT EXISTS "built_in_managed_resources_resource_idx"
  ON "built_in_managed_resources" ("resource_kind", "resource_id");


CREATE UNIQUE INDEX IF NOT EXISTS "built_in_managed_resources_company_bundle_resource_uq"
  ON "built_in_managed_resources" ("company_id", "bundle_key", "resource_kind", "resource_key");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('60b0ee743270249998b8c49660cb13930dccf65ebb38fdf01c281d7a9c59e79f', 1783555300000);

-- >>> Migration: 0141_heartbeat_runs_company_created_at_index.sql <<<
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_created_at_desc_idx"
  ON "heartbeat_runs" USING btree ("company_id", "created_at" DESC);


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('a92ce792c68668f356a20240faf505d07be40bb9e097b36c38335904555605c3', 1783555301000);

-- >>> Migration: 0142_company_search_sort_indexes.sql <<<
CREATE INDEX IF NOT EXISTS "issues_company_updated_idx" ON "issues" ("company_id","updated_at");
CREATE INDEX IF NOT EXISTS "issues_company_created_idx" ON "issues" ("company_id","created_at");
CREATE INDEX IF NOT EXISTS "issues_company_priority_idx" ON "issues" ("company_id","priority");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('bd362aced33dfd3cf0f1af3c9db98b9628966908e011ece41c5c0704524b0114', 1783555301100);

-- >>> Migration: 0143_cases_foundation.sql <<<
CREATE TABLE IF NOT EXISTS "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"case_number" integer NOT NULL,
	"identifier" text NOT NULL,
	"case_type" text NOT NULL,
	"key" text,
	"title" text NOT NULL,
	"summary" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parent_case_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_status_check" CHECK ("cases"."status" in ('draft', 'in_progress', 'in_review', 'approved', 'done', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS "case_issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_issue_links_role_check" CHECK ("case_issue_links"."role" in ('origin', 'work', 'reference'))
);

CREATE TABLE IF NOT EXISTS "case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" text,
	"actor_agent_id" uuid,
	"run_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_events_kind_check" CHECK ("case_events"."kind" in (
		'created',
		'updated',
		'fields_changed',
		'status_changed',
		'issue_linked',
		'issue_unlinked',
		'document_revised',
		'child_linked',
		'attachment_added',
		'label_added',
		'label_removed'
	)),
	CONSTRAINT "case_events_actor_type_check" CHECK ("case_events"."actor_type" in ('user', 'agent', 'system'))
);

CREATE TABLE IF NOT EXISTS "case_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "case_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "case_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "cases" ADD CONSTRAINT "cases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "cases" ADD CONSTRAINT "cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "cases" ADD CONSTRAINT "cases_parent_case_id_cases_id_fk" FOREIGN KEY ("parent_case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "cases" ADD CONSTRAINT "cases_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_issue_links" ADD CONSTRAINT "case_issue_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_issue_links" ADD CONSTRAINT "case_issue_links_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_issue_links" ADD CONSTRAINT "case_issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_events" ADD CONSTRAINT "case_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_events" ADD CONSTRAINT "case_events_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_events" ADD CONSTRAINT "case_events_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_documents" ADD CONSTRAINT "case_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_documents" ADD CONSTRAINT "case_documents_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_documents" ADD CONSTRAINT "case_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_labels" ADD CONSTRAINT "case_labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_labels" ADD CONSTRAINT "case_labels_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_labels" ADD CONSTRAINT "case_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "cases_company_case_number_uq" ON "cases" USING btree ("company_id","case_number");

CREATE UNIQUE INDEX IF NOT EXISTS "cases_identifier_uq" ON "cases" USING btree ("identifier");

CREATE UNIQUE INDEX IF NOT EXISTS "cases_company_type_key_uq" ON "cases" USING btree ("company_id","case_type","key");

CREATE INDEX IF NOT EXISTS "cases_company_status_idx" ON "cases" USING btree ("company_id","status");

CREATE INDEX IF NOT EXISTS "cases_company_type_idx" ON "cases" USING btree ("company_id","case_type");

CREATE INDEX IF NOT EXISTS "cases_company_project_idx" ON "cases" USING btree ("company_id","project_id");

CREATE INDEX IF NOT EXISTS "cases_parent_idx" ON "cases" USING btree ("parent_case_id");

CREATE INDEX IF NOT EXISTS "cases_title_search_idx" ON "cases" USING gin ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "cases_identifier_search_idx" ON "cases" USING gin ("identifier" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "cases_summary_search_idx" ON "cases" USING gin ("summary" gin_trgm_ops);

CREATE UNIQUE INDEX IF NOT EXISTS "case_issue_links_case_issue_uq" ON "case_issue_links" USING btree ("case_id","issue_id");

CREATE INDEX IF NOT EXISTS "case_issue_links_company_case_idx" ON "case_issue_links" USING btree ("company_id","case_id");

CREATE INDEX IF NOT EXISTS "case_issue_links_issue_idx" ON "case_issue_links" USING btree ("issue_id");

CREATE INDEX IF NOT EXISTS "case_events_case_created_idx" ON "case_events" USING btree ("case_id","created_at");

CREATE INDEX IF NOT EXISTS "case_events_company_case_idx" ON "case_events" USING btree ("company_id","case_id");

CREATE UNIQUE INDEX IF NOT EXISTS "case_documents_company_case_key_uq" ON "case_documents" USING btree ("company_id","case_id","key");

CREATE UNIQUE INDEX IF NOT EXISTS "case_documents_document_uq" ON "case_documents" USING btree ("document_id");

CREATE INDEX IF NOT EXISTS "case_documents_company_case_updated_idx" ON "case_documents" USING btree ("company_id","case_id","updated_at");

CREATE UNIQUE INDEX IF NOT EXISTS "case_labels_case_label_uq" ON "case_labels" USING btree ("case_id","label_id");

CREATE INDEX IF NOT EXISTS "case_labels_company_case_idx" ON "case_labels" USING btree ("company_id","case_id");

CREATE INDEX IF NOT EXISTS "case_labels_label_idx" ON "case_labels" USING btree ("label_id");

CREATE INDEX IF NOT EXISTS "case_attachments_company_case_idx" ON "case_attachments" USING btree ("company_id","case_id");

CREATE UNIQUE INDEX IF NOT EXISTS "case_attachments_asset_uq" ON "case_attachments" USING btree ("asset_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('19ea6be1aeadfed222822c3dfbfb504015ecd67744530e0e6f778a4ddb228dbe', 1783457051766);

-- >>> Migration: 0144_case_document_annotations.sql <<<
ALTER TABLE "document_annotation_threads" ADD COLUMN IF NOT EXISTS "case_id" uuid;

ALTER TABLE "document_annotation_comments" ADD COLUMN IF NOT EXISTS "case_id" uuid;

DO $$ BEGIN
	ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "document_annotation_threads" DROP CONSTRAINT IF EXISTS "document_annotation_threads_owner_check";

ALTER TABLE "document_annotation_threads" DROP CONSTRAINT IF EXISTS "document_annotation_threads_exactly_one_owner_chk";

ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_exactly_one_owner_chk" CHECK (num_nonnulls("issue_id", "routine_id", "case_id") = 1);

ALTER TABLE "document_annotation_comments" DROP CONSTRAINT IF EXISTS "document_annotation_comments_owner_check";

ALTER TABLE "document_annotation_comments" DROP CONSTRAINT IF EXISTS "document_annotation_comments_exactly_one_owner_chk";

ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_exactly_one_owner_chk" CHECK (num_nonnulls("issue_id", "routine_id", "case_id") = 1);

CREATE INDEX IF NOT EXISTS "document_annotation_threads_company_case_status_idx" ON "document_annotation_threads" USING btree ("company_id","case_id","status");

CREATE INDEX IF NOT EXISTS "document_annotation_comments_company_case_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","case_id","created_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('670ba6343ceff77aefc892fe69b91fac7c73c79bb4f0b4bcb4e767966d914944', 1783520000000);

-- >>> Migration: 0145_inbox_dismissal_snooze_kind.sql <<<
ALTER TABLE "inbox_dismissals" ADD COLUMN IF NOT EXISTS "kind" text;
UPDATE "inbox_dismissals" SET "kind" = 'dismiss' WHERE "kind" IS NULL;
ALTER TABLE "inbox_dismissals" ALTER COLUMN "kind" SET DEFAULT 'dismiss';
ALTER TABLE "inbox_dismissals" ALTER COLUMN "kind" SET NOT NULL;
ALTER TABLE "inbox_dismissals" ADD COLUMN IF NOT EXISTS "snoozed_until" timestamp with time zone;
DO $$ BEGIN
 ALTER TABLE "inbox_dismissals" ADD CONSTRAINT "inbox_dismissals_kind_check" CHECK ("kind" IN ('dismiss', 'snooze'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "inbox_dismissals" ADD CONSTRAINT "inbox_dismissals_kind_snooze_until_check" CHECK (("kind" = 'dismiss' AND "snoozed_until" IS NULL) OR ("kind" = 'snooze' AND "snoozed_until" IS NOT NULL));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2fb01e46ff5adaf34ca84865d108621216d53b8009f30da42956dd4a5b80932a', 1783641600000);

-- >>> Migration: 0146_routine_activity_gate.sql <<<
ALTER TABLE "routines" ADD COLUMN "activity_gate_policy" text DEFAULT 'always' NOT NULL;

ALTER TABLE "routines" ADD COLUMN "activity_gate_scope" text DEFAULT 'company' NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('a5ad7d285f6c6ad19f2980b046ec74189a8e7b96c930175d78af73d7c3758c4e', 1783822632557);

-- >>> Migration: 0147_cost_event_status.sql <<<
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "cost_status" text DEFAULT 'reported' NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('c97f6de83f6f45247122b71669322a52e025ca9ad896a74375bc993f386d50c2', 1783953514660);

-- >>> Migration: 0148_tool_access_mcp_connections.sql <<<
CREATE TABLE IF NOT EXISTS "tool_applications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "application_id" uuid NOT NULL,
  "name" text NOT NULL,
  "transport" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "credential_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "health_status" text DEFAULT 'unchecked' NOT NULL,
  "health_message" text,
  "last_health_at" timestamp with time zone,
  "last_catalog_refresh_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_catalog_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "name" text NOT NULL,
  "title" text,
  "description" text,
  "input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "annotations" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "risk_level" text DEFAULT 'read' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "version_hash" text NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "quarantined_at" timestamp with time zone,
  "quarantine_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_runtime_slots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "slot_key" text NOT NULL,
  "status" text DEFAULT 'stopped' NOT NULL,
  "provider_ref" text,
  "health_status" text DEFAULT 'unchecked' NOT NULL,
  "health_message" text,
  "last_started_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "idle_deadline_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_access_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "connection_id" uuid,
  "catalog_entry_id" uuid,
  "actor_type" text DEFAULT 'system' NOT NULL,
  "actor_id" text,
  "action" text NOT NULL,
  "outcome" text NOT NULL,
  "reason_code" text,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_applications_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_applications" ADD CONSTRAINT "tool_applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_connections_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_connections_application_id_tool_applications_id_fk') THEN
    ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_catalog_entries_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_catalog_entries" ADD CONSTRAINT "tool_catalog_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_catalog_entries_connection_id_tool_connections_id_fk') THEN
    ALTER TABLE "tool_catalog_entries" ADD CONSTRAINT "tool_catalog_entries_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_runtime_slots_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_runtime_slots_connection_id_tool_connections_id_fk') THEN
    ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_access_audit_events_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_access_audit_events_connection_id_tool_connections_id_fk') THEN
    ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_access_audit_events_catalog_entry_id_tool_catalog_entries_id_fk') THEN
    ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_catalog_entry_id_tool_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."tool_catalog_entries"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "tool_applications_company_idx" ON "tool_applications" USING btree ("company_id");
CREATE UNIQUE INDEX IF NOT EXISTS "tool_applications_company_name_uq" ON "tool_applications" USING btree ("company_id", "name");
CREATE INDEX IF NOT EXISTS "tool_connections_company_idx" ON "tool_connections" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "tool_connections_application_idx" ON "tool_connections" USING btree ("application_id");
CREATE UNIQUE INDEX IF NOT EXISTS "tool_connections_company_name_uq" ON "tool_connections" USING btree ("company_id", "name");
CREATE INDEX IF NOT EXISTS "tool_catalog_entries_company_idx" ON "tool_catalog_entries" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "tool_catalog_entries_connection_idx" ON "tool_catalog_entries" USING btree ("connection_id");
CREATE UNIQUE INDEX IF NOT EXISTS "tool_catalog_entries_connection_name_uq" ON "tool_catalog_entries" USING btree ("connection_id", "name");
CREATE INDEX IF NOT EXISTS "tool_runtime_slots_company_idx" ON "tool_runtime_slots" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "tool_runtime_slots_connection_idx" ON "tool_runtime_slots" USING btree ("connection_id");
CREATE UNIQUE INDEX IF NOT EXISTS "tool_runtime_slots_slot_key_uq" ON "tool_runtime_slots" USING btree ("company_id", "slot_key");
CREATE INDEX IF NOT EXISTS "tool_access_audit_company_created_idx" ON "tool_access_audit_events" USING btree ("company_id", "created_at");
CREATE INDEX IF NOT EXISTS "tool_access_audit_connection_idx" ON "tool_access_audit_events" USING btree ("connection_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('59c99b0728610e2e7ea7f29a62364e6121e2cadac747b83c61735f355d4b38c2', 1783953515660);

-- >>> Migration: 0149_agent_access_phase2_contracts.sql <<<
ALTER TABLE "tool_applications" ADD COLUMN IF NOT EXISTS "application_key" text;
ALTER TABLE "tool_applications" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "tool_applications" ADD COLUMN IF NOT EXISTS "plugin_id" uuid;
ALTER TABLE "tool_applications" ADD COLUMN IF NOT EXISTS "owner_agent_id" uuid;
ALTER TABLE "tool_applications" ADD COLUMN IF NOT EXISTS "owner_user_id" text;
ALTER TABLE "tool_applications" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;

UPDATE "tool_applications"
SET "application_key" = concat(
  coalesce(nullif(lower(regexp_replace("name", '[^a-zA-Z0-9._:-]+', '-', 'g')), ''), 'app'),
  '-',
  "id"::text
)
WHERE "application_key" IS NULL;

ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "connection_kind" text DEFAULT 'managed' NOT NULL;
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "transport_config" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "credential_secret_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "health_checked_at" timestamp with time zone;
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "last_error" text;
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "created_by_agent_id" uuid;
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;

UPDATE "tool_connections"
SET "transport_config" = coalesce(nullif("config", '{}'::jsonb), '{}'::jsonb)
WHERE "transport_config" = '{}'::jsonb
  AND "config" <> '{}'::jsonb;

ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "application_id" uuid;
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "entry_kind" text DEFAULT 'tool' NOT NULL;
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "tool_name" text;
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "output_schema" jsonb;
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "is_read_only" boolean DEFAULT true NOT NULL;
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "is_write" boolean DEFAULT false NOT NULL;
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "is_destructive" boolean DEFAULT false NOT NULL;
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "version" text;
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "schema_hash" text;
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "reviewed_by_agent_id" uuid;
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" text;

UPDATE "tool_catalog_entries" AS e
SET
  "application_id" = c."application_id",
  "tool_name" = coalesce(e."tool_name", e."name"),
  "is_read_only" = CASE WHEN e."risk_level" = 'read' THEN true ELSE false END,
  "is_write" = CASE WHEN e."risk_level" IN ('write', 'destructive') THEN true ELSE false END,
  "is_destructive" = CASE WHEN e."risk_level" = 'destructive' THEN true ELSE false END,
  "schema_hash" = coalesce(e."schema_hash", e."version_hash")
FROM "tool_connections" c
WHERE c."id" = e."connection_id";

UPDATE "tool_catalog_entries"
SET "tool_name" = "name"
WHERE "tool_name" IS NULL;

ALTER TABLE "tool_catalog_entries" ALTER COLUMN "tool_name" SET NOT NULL;

ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "application_id" uuid;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "project_workspace_id" uuid;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "execution_workspace_id" uuid;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "issue_id" uuid;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "owner_scope_type" text DEFAULT 'connection' NOT NULL;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "owner_scope_id" text;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "runtime_kind" text DEFAULT 'local_stdio' NOT NULL;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "reuse_key" text;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "workspace_scope" text;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "credential_scope_hash" text;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "provider" text;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "process_id" integer;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "command_template_key" text;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "last_health_check_at" timestamp with time zone;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "stopped_at" timestamp with time zone;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "idle_expires_at" timestamp with time zone;
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "last_error" text;
ALTER TABLE "tool_runtime_slots" ALTER COLUMN "connection_id" DROP NOT NULL;

UPDATE "tool_runtime_slots" AS s
SET "application_id" = c."application_id"
FROM "tool_connections" c
WHERE c."id" = s."connection_id"
  AND s."application_id" IS NULL;

CREATE TABLE IF NOT EXISTS "tool_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "profile_key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'active' NOT NULL,
  "default_action" text DEFAULT 'deny' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_profile_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "profile_id" uuid NOT NULL,
  "selector_type" text NOT NULL,
  "effect" text DEFAULT 'include' NOT NULL,
  "application_id" uuid,
  "connection_id" uuid,
  "catalog_entry_id" uuid,
  "tool_name" text,
  "risk_level" text,
  "conditions" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_profile_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "profile_id" uuid NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "priority" integer DEFAULT 100 NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "policy_type" text NOT NULL,
  "priority" integer DEFAULT 100 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "selectors" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "conditions" jsonb,
  "config" jsonb,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_invocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "idempotency_key" text,
  "actor_type" text DEFAULT 'system' NOT NULL,
  "actor_id" text,
  "agent_id" uuid,
  "issue_id" uuid,
  "run_id" uuid,
  "application_id" uuid,
  "connection_id" uuid,
  "catalog_entry_id" uuid,
  "tool_name" text NOT NULL,
  "arguments_hash" text,
  "arguments_summary" jsonb,
  "policy_decision" text,
  "matched_policy_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "approval_state" text DEFAULT 'not_required' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "upstream_request_id" text,
  "result_hash" text,
  "result_summary" jsonb,
  "result_size_bytes" integer,
  "result_artifact_id" uuid,
  "error_code" text,
  "error_message" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_action_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "invocation_id" uuid NOT NULL,
  "issue_id" uuid,
  "interaction_id" uuid,
  "approval_id" uuid,
  "status" text DEFAULT 'pending' NOT NULL,
  "canonical_arguments_hash" text NOT NULL,
  "canonical_arguments_summary" jsonb NOT NULL,
  "signed_arguments" text,
  "preview_markdown" text,
  "requested_by_agent_id" uuid,
  "requested_by_user_id" text,
  "resolved_by_agent_id" uuid,
  "resolved_by_user_id" text,
  "decided_by_agent_id" uuid,
  "decided_by_user_id" text,
  "decided_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_call_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "actor_type" text DEFAULT 'system' NOT NULL,
  "actor_id" text,
  "agent_id" uuid,
  "run_id" uuid,
  "issue_id" uuid,
  "application_id" uuid,
  "connection_id" uuid,
  "catalog_entry_id" uuid,
  "invocation_id" uuid,
  "action_request_id" uuid,
  "runtime_slot_id" uuid,
  "tool_name" text,
  "decision" text,
  "matched_policy_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reason_code" text,
  "outcome" text DEFAULT 'pending' NOT NULL,
  "latency_ms" integer,
  "arguments_summary" jsonb,
  "request_hash" text,
  "request_summary" jsonb,
  "result_hash" text,
  "result_summary" jsonb,
  "result_size_bytes" integer,
  "redaction_plan" jsonb,
  "rate_limit_state" jsonb,
  "metadata" jsonb,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_rate_limit_counters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
  "counter_key" text NOT NULL,
  "scope_type" text NOT NULL,
  "scope_id" text NOT NULL,
  "window_kind" text NOT NULL,
  "window_start_at" timestamp with time zone NOT NULL,
  "limit" integer NOT NULL,
  "remaining" integer NOT NULL,
  "reset_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_applications_plugin_id_plugins_id_fk') THEN
    ALTER TABLE "tool_applications" ADD CONSTRAINT "tool_applications_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_applications_owner_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_applications" ADD CONSTRAINT "tool_applications_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_connections_created_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_catalog_entries_application_id_tool_applications_id_fk') THEN
    ALTER TABLE "tool_catalog_entries" ADD CONSTRAINT "tool_catalog_entries_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_catalog_entries_reviewed_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_catalog_entries" ADD CONSTRAINT "tool_catalog_entries_reviewed_by_agent_id_agents_id_fk" FOREIGN KEY ("reviewed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profiles_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_profiles" ADD CONSTRAINT "tool_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_entries_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_entries_profile_id_tool_profiles_id_fk') THEN
    ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_profile_id_tool_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."tool_profiles"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_entries_application_id_tool_applications_id_fk') THEN
    ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_entries_connection_id_tool_connections_id_fk') THEN
    ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_entries_catalog_entry_id_tool_catalog_entries_id_fk') THEN
    ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_catalog_entry_id_tool_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."tool_catalog_entries"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_bindings_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_profile_bindings" ADD CONSTRAINT "tool_profile_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_bindings_profile_id_tool_profiles_id_fk') THEN
    ALTER TABLE "tool_profile_bindings" ADD CONSTRAINT "tool_profile_bindings_profile_id_tool_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."tool_profiles"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_bindings_created_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_profile_bindings" ADD CONSTRAINT "tool_profile_bindings_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_policies_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_policies" ADD CONSTRAINT "tool_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_policies_created_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_policies" ADD CONSTRAINT "tool_policies_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_runtime_slots_application_id_tool_applications_id_fk') THEN
    ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_runtime_slots_project_workspace_id_project_workspaces_id_fk') THEN
    ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_runtime_slots_execution_workspace_id_execution_workspaces_id_fk') THEN
    ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_runtime_slots_issue_id_issues_id_fk') THEN
    ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_issue_id_issues_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_application_id_tool_applications_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_connection_id_tool_connections_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_catalog_entry_id_tool_catalog_entries_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_catalog_entry_id_tool_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."tool_catalog_entries"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_invocation_id_tool_invocations_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_invocation_id_tool_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."tool_invocations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_issue_id_issues_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_interaction_id_issue_thread_interactions_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_approval_id_approvals_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_requested_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_resolved_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_decided_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_decided_by_agent_id_agents_id_fk" FOREIGN KEY ("decided_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_issue_id_issues_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_application_id_tool_applications_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_connection_id_tool_connections_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_catalog_entry_id_tool_catalog_entries_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_catalog_entry_id_tool_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."tool_catalog_entries"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_invocation_id_tool_invocations_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_invocation_id_tool_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."tool_invocations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_action_request_id_tool_action_requests_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_action_request_id_tool_action_requests_id_fk" FOREIGN KEY ("action_request_id") REFERENCES "public"."tool_action_requests"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_runtime_slot_id_tool_runtime_slots_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_runtime_slot_id_tool_runtime_slots_id_fk" FOREIGN KEY ("runtime_slot_id") REFERENCES "public"."tool_runtime_slots"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_rate_limit_counters_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_rate_limit_counters" ADD CONSTRAINT "tool_rate_limit_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_rate_limit_counters_policy_id_tool_policies_id_fk') THEN
    ALTER TABLE "tool_rate_limit_counters" ADD CONSTRAINT "tool_rate_limit_counters_policy_id_tool_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."tool_policies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "tool_applications_company_status_idx" ON "tool_applications" USING btree ("company_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "tool_applications_company_key_uq" ON "tool_applications" USING btree ("company_id", "application_key");
CREATE INDEX IF NOT EXISTS "tool_connections_company_enabled_idx" ON "tool_connections" USING btree ("company_id", "enabled");
CREATE INDEX IF NOT EXISTS "tool_catalog_entries_application_idx" ON "tool_catalog_entries" USING btree ("application_id");
CREATE INDEX IF NOT EXISTS "tool_catalog_entries_company_status_idx" ON "tool_catalog_entries" USING btree ("company_id", "status");
CREATE INDEX IF NOT EXISTS "tool_profiles_company_status_idx" ON "tool_profiles" USING btree ("company_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "tool_profiles_company_key_uq" ON "tool_profiles" USING btree ("company_id", "profile_key");
CREATE UNIQUE INDEX IF NOT EXISTS "tool_profiles_company_name_uq" ON "tool_profiles" USING btree ("company_id", "name");
CREATE INDEX IF NOT EXISTS "tool_profile_entries_company_profile_idx" ON "tool_profile_entries" USING btree ("company_id", "profile_id");
CREATE INDEX IF NOT EXISTS "tool_profile_entries_application_idx" ON "tool_profile_entries" USING btree ("company_id", "application_id");
CREATE INDEX IF NOT EXISTS "tool_profile_entries_connection_idx" ON "tool_profile_entries" USING btree ("company_id", "connection_id");
CREATE INDEX IF NOT EXISTS "tool_profile_entries_catalog_entry_idx" ON "tool_profile_entries" USING btree ("company_id", "catalog_entry_id");
CREATE INDEX IF NOT EXISTS "tool_profile_bindings_company_target_idx" ON "tool_profile_bindings" USING btree ("company_id", "target_type", "target_id");
CREATE UNIQUE INDEX IF NOT EXISTS "tool_profile_bindings_target_profile_uq" ON "tool_profile_bindings" USING btree ("company_id", "target_type", "target_id", "profile_id");
CREATE INDEX IF NOT EXISTS "tool_policies_company_enabled_idx" ON "tool_policies" USING btree ("company_id", "enabled");
CREATE INDEX IF NOT EXISTS "tool_policies_company_type_idx" ON "tool_policies" USING btree ("company_id", "policy_type");
CREATE UNIQUE INDEX IF NOT EXISTS "tool_policies_company_name_uq" ON "tool_policies" USING btree ("company_id", "name");
CREATE INDEX IF NOT EXISTS "tool_runtime_slots_execution_workspace_idx" ON "tool_runtime_slots" USING btree ("company_id", "execution_workspace_id");
CREATE INDEX IF NOT EXISTS "tool_invocations_company_created_idx" ON "tool_invocations" USING btree ("company_id", "created_at");
CREATE INDEX IF NOT EXISTS "tool_invocations_run_idx" ON "tool_invocations" USING btree ("company_id", "run_id");
CREATE INDEX IF NOT EXISTS "tool_invocations_issue_idx" ON "tool_invocations" USING btree ("company_id", "issue_id");
CREATE UNIQUE INDEX IF NOT EXISTS "tool_invocations_company_idempotency_uq" ON "tool_invocations" USING btree ("company_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "tool_action_requests_company_status_idx" ON "tool_action_requests" USING btree ("company_id", "status");
CREATE INDEX IF NOT EXISTS "tool_action_requests_invocation_idx" ON "tool_action_requests" USING btree ("invocation_id");
CREATE INDEX IF NOT EXISTS "tool_action_requests_issue_idx" ON "tool_action_requests" USING btree ("company_id", "issue_id");
CREATE INDEX IF NOT EXISTS "tool_call_events_company_created_idx" ON "tool_call_events" USING btree ("company_id", "created_at");
CREATE INDEX IF NOT EXISTS "tool_call_events_run_idx" ON "tool_call_events" USING btree ("company_id", "run_id");
CREATE INDEX IF NOT EXISTS "tool_call_events_issue_idx" ON "tool_call_events" USING btree ("company_id", "issue_id");
CREATE INDEX IF NOT EXISTS "tool_call_events_invocation_idx" ON "tool_call_events" USING btree ("invocation_id");
CREATE INDEX IF NOT EXISTS "tool_rate_limit_counters_company_idx" ON "tool_rate_limit_counters" USING btree ("company_id");
CREATE UNIQUE INDEX IF NOT EXISTS "tool_rate_limit_counters_window_uq" ON "tool_rate_limit_counters" USING btree ("company_id", "policy_id", "counter_key", "window_kind", "window_start_at");

INSERT INTO "tool_applications" (
  "company_id",
  "application_key",
  "name",
  "type",
  "status",
  "plugin_id",
  "metadata",
  "created_at",
  "updated_at"
)
SELECT
  c."id",
  'paperclip_plugin:' || p."plugin_key",
  coalesce(p."manifest_json"->>'name', p."plugin_key"),
  'paperclip_plugin',
  'active',
  p."id",
  jsonb_build_object('source', 'plugin_backfill', 'pluginKey', p."plugin_key"),
  now(),
  now()
FROM "companies" c
CROSS JOIN "plugins" p
WHERE jsonb_array_length(coalesce(p."manifest_json"->'tools', '[]'::jsonb)) > 0
ON CONFLICT ("company_id", "name") DO NOTHING;

INSERT INTO "tool_connections" (
  "company_id",
  "application_id",
  "name",
  "connection_kind",
  "transport",
  "status",
  "enabled",
  "config",
  "transport_config",
  "credential_refs",
  "credential_secret_refs",
  "health_status",
  "created_at",
  "updated_at"
)
SELECT
  a."company_id",
  a."id",
  'Plugin: ' || coalesce(p."manifest_json"->>'name', p."plugin_key"),
  'managed',
  'remote_http',
  'active',
  true,
  jsonb_build_object('pluginKey', p."plugin_key", 'type', 'paperclip_plugin'),
  jsonb_build_object('pluginKey', p."plugin_key", 'type', 'paperclip_plugin'),
  '[]'::jsonb,
  '[]'::jsonb,
  'ok',
  now(),
  now()
FROM "tool_applications" a
JOIN "plugins" p ON p."id" = a."plugin_id"
WHERE a."type" = 'paperclip_plugin'
  AND NOT EXISTS (
    SELECT 1 FROM "tool_connections" existing
    WHERE existing."company_id" = a."company_id"
      AND existing."application_id" = a."id"
  )
ON CONFLICT ("company_id", "name") DO NOTHING;

INSERT INTO "tool_catalog_entries" (
  "company_id",
  "application_id",
  "connection_id",
  "entry_kind",
  "name",
  "tool_name",
  "title",
  "description",
  "input_schema",
  "annotations",
  "risk_level",
  "is_read_only",
  "is_write",
  "is_destructive",
  "status",
  "version_hash",
  "schema_hash",
  "first_seen_at",
  "last_seen_at",
  "created_at",
  "updated_at"
)
SELECT
  c."company_id",
  c."application_id",
  c."id",
  'tool',
  tool.value->>'name',
  tool.value->>'name',
  coalesce(tool.value->>'displayName', tool.value->>'title'),
  tool.value->>'description',
  coalesce(tool.value->'parametersSchema', '{}'::jsonb),
  '{}'::jsonb,
  'read',
  true,
  false,
  false,
  'active',
  md5(tool.value::text),
  md5(tool.value::text),
  now(),
  now(),
  now(),
  now()
FROM "tool_connections" c
JOIN "tool_applications" a ON a."id" = c."application_id"
JOIN "plugins" p ON p."id" = a."plugin_id"
CROSS JOIN LATERAL jsonb_array_elements(coalesce(p."manifest_json"->'tools', '[]'::jsonb)) AS tool(value)
WHERE a."type" = 'paperclip_plugin'
  AND tool.value ? 'name'
ON CONFLICT ("connection_id", "name") DO NOTHING;

INSERT INTO "principal_permission_grants" (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key",
  "scope",
  "granted_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  memberships."company_id",
  memberships."principal_type",
  memberships."principal_id",
  permissions."permission_key",
  NULL,
  NULL,
  now(),
  now()
FROM "company_memberships" memberships
JOIN (
  VALUES
    ('tools:admin'),
    ('tools:manage_connections'),
    ('tools:manage_profiles'),
    ('tools:view_audit'),
    ('tools:manage_runtime')
) AS permissions("permission_key") ON true
WHERE memberships."principal_type" = 'user'
  AND memberships."status" = 'active'
  AND memberships."membership_role" IN ('owner', 'admin')
ON CONFLICT ("company_id", "principal_type", "principal_id", "permission_key") DO NOTHING;

INSERT INTO "principal_permission_grants" (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key",
  "scope",
  "granted_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  agents."company_id",
  'agent',
  agents."id",
  permissions."permission_key",
  NULL,
  NULL,
  now(),
  now()
FROM "agents"
JOIN (
  VALUES
    ('tools:admin'),
    ('tools:manage_connections'),
    ('tools:manage_profiles'),
    ('tools:view_audit'),
    ('tools:manage_runtime')
) AS permissions("permission_key") ON true
WHERE agents."role" IN ('ceo', 'cto')
  AND agents."status" NOT IN ('pending_approval', 'terminated')
ON CONFLICT ("company_id", "principal_type", "principal_id", "permission_key") DO NOTHING;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('973497276131c631680c1b265b8d9d9110c3207c9eb066b1854426e4ca08347c', 1783953516660);

-- >>> Migration: 0150_tool_invocation_catalog_snapshots.sql <<<
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "catalog_version_hash" text;
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "catalog_schema_hash" text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('8ef76e87a40cab9ab5e7fd4fa114a91f29527e525837a043df1a74bebb133938', 1783953517660);

-- >>> Migration: 0151_tool_gateway_sessions.sql <<<
CREATE TABLE IF NOT EXISTS "tool_gateway_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "issue_id" uuid,
  "project_id" uuid,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_gateway_sessions_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_gateway_sessions" ADD CONSTRAINT "tool_gateway_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_gateway_sessions_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_gateway_sessions" ADD CONSTRAINT "tool_gateway_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_gateway_sessions_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "tool_gateway_sessions" ADD CONSTRAINT "tool_gateway_sessions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_gateway_sessions_issue_id_issues_id_fk') THEN
    ALTER TABLE "tool_gateway_sessions" ADD CONSTRAINT "tool_gateway_sessions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_gateway_sessions_project_id_projects_id_fk') THEN
    ALTER TABLE "tool_gateway_sessions" ADD CONSTRAINT "tool_gateway_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "tool_gateway_sessions_token_hash_uq" ON "tool_gateway_sessions" USING btree ("token_hash");
CREATE INDEX IF NOT EXISTS "tool_gateway_sessions_company_agent_idx" ON "tool_gateway_sessions" USING btree ("company_id", "agent_id");
CREATE INDEX IF NOT EXISTS "tool_gateway_sessions_company_expires_idx" ON "tool_gateway_sessions" USING btree ("company_id", "expires_at");
CREATE INDEX IF NOT EXISTS "tool_gateway_sessions_run_idx" ON "tool_gateway_sessions" USING btree ("company_id", "run_id");
CREATE INDEX IF NOT EXISTS "tool_gateway_sessions_issue_idx" ON "tool_gateway_sessions" USING btree ("company_id", "issue_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('db417e1c46c824c4282ec3bff4572ca816b554e2fd130acfb1ad698e78001f48', 1783953518660);

-- >>> Migration: 0152_tool_connection_application_no_cascade.sql <<<
-- Harden DELETE /tool-applications/:applicationId against concurrent connection creation.
-- The tool_connections.application_id FK was ON DELETE CASCADE, so a connection created in
-- the gap between the endpoint's "any connections?" pre-check and its DELETE could be silently
-- removed by the cascade instead of forcing the promised 409. Switch the FK to ON DELETE
-- NO ACTION so the database fails closed: an application with connections can never be deleted,
-- and a concurrently-inserted connection (which holds a FOR KEY SHARE lock on the parent row)
-- forces the delete to raise a foreign_key_violation rather than cascade.
--
-- NO ACTION (end-of-statement check) rather than RESTRICT (immediate check) is deliberate so a
-- company delete still cascades cleanly: companies -> tool_applications and companies ->
-- tool_connections both fire within the one DELETE statement, and the connections are already
-- gone by the time this constraint is verified.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_connections_application_id_tool_applications_id_fk') THEN
    ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_application_id_tool_applications_id_fk";
  END IF;
  ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE no action ON UPDATE no action;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('75ab3c38858e08b8ccc3b58704c449ffba67257a4904cc6ec0caebed444a0f35', 1783953519660);

-- >>> Migration: 0153_tool_stdio_command_templates.sql <<<
CREATE TABLE IF NOT EXISTS "tool_stdio_command_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "template_key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'active' NOT NULL,
  "command" text NOT NULL,
  "args" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "env_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "disabled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_stdio_command_templates_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_stdio_command_templates" ADD CONSTRAINT "tool_stdio_command_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_stdio_command_templates_created_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_stdio_command_templates" ADD CONSTRAINT "tool_stdio_command_templates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "tool_stdio_command_templates_company_idx" ON "tool_stdio_command_templates" USING btree ("company_id");

CREATE INDEX IF NOT EXISTS "tool_stdio_command_templates_company_status_idx" ON "tool_stdio_command_templates" USING btree ("company_id", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "tool_stdio_command_templates_company_key_uq" ON "tool_stdio_command_templates" USING btree ("company_id", "template_key");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('7a446cd93a5b49228058a8ff999231497fceaa0bd95f960dea9d8e6a113da37f', 1783953520660);

-- >>> Migration: 0154_tool_oauth_states.sql <<<
CREATE TABLE IF NOT EXISTS "tool_oauth_states" (
  "state" text PRIMARY KEY NOT NULL,
  "company_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "code_verifier" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tool_oauth_states_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "tool_oauth_states"
      ADD CONSTRAINT "tool_oauth_states_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tool_oauth_states_connection_id_tool_connections_id_fk'
  ) THEN
    ALTER TABLE "tool_oauth_states"
      ADD CONSTRAINT "tool_oauth_states_connection_id_tool_connections_id_fk"
      FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "tool_oauth_states_company_idx" ON "tool_oauth_states" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "tool_oauth_states_connection_idx" ON "tool_oauth_states" USING btree ("connection_id");
CREATE INDEX IF NOT EXISTS "tool_oauth_states_expires_at_idx" ON "tool_oauth_states" USING btree ("expires_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f42d9ed58ab8ebe52a880d6fc01013f785ab8a25c447293acca9d1ed57ad5584', 1783953521660);

-- >>> Migration: 0155_tool_oauth_state_actor_binding.sql <<<
ALTER TABLE "tool_oauth_states" ADD COLUMN IF NOT EXISTS "created_by_actor_type" text;
ALTER TABLE "tool_oauth_states" ADD COLUMN IF NOT EXISTS "created_by_actor_id" text;

CREATE INDEX IF NOT EXISTS "tool_oauth_states_actor_idx"
  ON "tool_oauth_states" USING btree ("created_by_actor_type", "created_by_actor_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('63d5854c39bafaca62c7e2ad22253b6d3b0590403b1438b5ad38a594f0cf113c', 1783953522660);

-- >>> Migration: 0156_tool_oauth_state_session_binding.sql <<<
ALTER TABLE "tool_oauth_states" ADD COLUMN IF NOT EXISTS "created_by_session_id" text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f47da5b40228b23f7aaab712b3c915fbf08876e013cea75ee76af938972fa429', 1783953523660);

-- >>> Migration: 0157_tool_profile_new_tools_review.sql <<<
ALTER TABLE "tool_profiles" ADD COLUMN IF NOT EXISTS "new_tools_reviewed_at" timestamp with time zone;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('adb9256f4b32c7f73c738f89be8e0a3fe43cfd84f95cb6b833e81f0134adfaf9', 1783953524660);

-- >>> Migration: 0158_tool_invocation_connected_mcp_metadata.sql <<<
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "provider_type" text;
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "application_key" text;
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "upstream_tool_name" text;
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "risk_level" text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('ff7836f9082ed761cdcc9a6040ab4ea664295b959994d4db279dd286934d00dd', 1783953525660);

-- >>> Migration: 0159_named_mcp_gateways.sql <<<
CREATE TABLE IF NOT EXISTS "tool_mcp_gateways" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'active' NOT NULL,
  "profile_id" uuid NOT NULL,
  "agent_id" uuid,
  "project_id" uuid,
  "issue_id" uuid,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_mcp_gateway_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "gateway_id" uuid NOT NULL,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_mcp_gateways_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_mcp_gateways_profile_id_tool_profiles_id_fk') THEN
    ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_profile_id_tool_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."tool_profiles"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_mcp_gateways_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_mcp_gateways_project_id_projects_id_fk') THEN
    ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_mcp_gateways_issue_id_issues_id_fk') THEN
    ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_mcp_gateway_tokens_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_mcp_gateway_tokens" ADD CONSTRAINT "tool_mcp_gateway_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_mcp_gateway_tokens_gateway_id_tool_mcp_gateways_id_fk') THEN
    ALTER TABLE "tool_mcp_gateway_tokens" ADD CONSTRAINT "tool_mcp_gateway_tokens_gateway_id_tool_mcp_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."tool_mcp_gateways"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "tool_mcp_gateways_company_idx" ON "tool_mcp_gateways" USING btree ("company_id");

CREATE INDEX IF NOT EXISTS "tool_mcp_gateways_company_status_idx" ON "tool_mcp_gateways" USING btree ("company_id", "status");

CREATE INDEX IF NOT EXISTS "tool_mcp_gateways_profile_idx" ON "tool_mcp_gateways" USING btree ("company_id", "profile_id");

CREATE UNIQUE INDEX IF NOT EXISTS "tool_mcp_gateways_company_slug_uq" ON "tool_mcp_gateways" USING btree ("company_id", "slug");

CREATE UNIQUE INDEX IF NOT EXISTS "tool_mcp_gateways_company_name_uq" ON "tool_mcp_gateways" USING btree ("company_id", "name");

CREATE UNIQUE INDEX IF NOT EXISTS "tool_mcp_gateway_tokens_token_hash_uq" ON "tool_mcp_gateway_tokens" USING btree ("token_hash");

CREATE INDEX IF NOT EXISTS "tool_mcp_gateway_tokens_gateway_idx" ON "tool_mcp_gateway_tokens" USING btree ("company_id", "gateway_id");

CREATE INDEX IF NOT EXISTS "tool_mcp_gateway_tokens_company_expires_idx" ON "tool_mcp_gateway_tokens" USING btree ("company_id", "expires_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('861b2e582fbb645c2982654fdcd9094f93d1c41c43527fb4787fff2bb3270fa3', 1783953526660);

-- >>> Migration: 0160_mcp_gateway_contract_expansion.sql <<<
ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "gateway_public_id" text;

UPDATE "tool_mcp_gateways"
SET "gateway_public_id" = 'gw_' || replace("id"::text, '-', '')
WHERE "gateway_public_id" IS NULL;

ALTER TABLE "tool_mcp_gateways" ALTER COLUMN "gateway_public_id" SET DEFAULT ('gw_' || replace(gen_random_uuid()::text, '-', ''));

ALTER TABLE "tool_mcp_gateways" ALTER COLUMN "gateway_public_id" SET NOT NULL;

ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "display_slug" text;

UPDATE "tool_mcp_gateways"
SET "display_slug" = "slug"
WHERE "display_slug" IS NULL OR "display_slug" = '';

ALTER TABLE "tool_mcp_gateways" ALTER COLUMN "display_slug" SET DEFAULT '';

ALTER TABLE "tool_mcp_gateways" ALTER COLUMN "display_slug" SET NOT NULL;

ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "default_profile_mode" text DEFAULT 'gateway_only' NOT NULL;

ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "context_scope_type" text DEFAULT 'none' NOT NULL;

ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "context_scope_id" text;

ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "approval_issue_id" uuid;

ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "auth_config" jsonb DEFAULT '{"version":1,"bearer":{"enabled":true,"tokenPrefix":"pcgw","defaultTtlSeconds":7776000,"requireFiniteExpiry":true,"longLivedTokenRequiresOverride":true},"oauth":{"enabled":false,"reservedFor":"v1_5","dynamicClientRegistration":false,"authorizationCodePkce":false}}'::jsonb NOT NULL;

ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "header_policy" jsonb DEFAULT '{"version":1,"callerPassthrough":{"enabled":false,"allowedHeaders":[]},"staticHeaders":[],"generatedMetadata":{"enabled":false,"allowedHeaders":[]},"responseHeaders":{"forwardMcpRequiredHeaders":true,"forwardSafeCacheHeaders":true}}'::jsonb NOT NULL;

ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "metadata_policy" jsonb DEFAULT '{"version":1,"forwardCompanyId":false,"forwardGatewayId":false,"forwardProjectId":false,"forwardIssueId":false,"forwardAgentId":false,"forwardRunId":false,"forwardCorrelationId":true}'::jsonb NOT NULL;

ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "on_demand_tools_config" jsonb DEFAULT '{"enabled":false,"searchToolName":"search_tools","runToolName":"run_tool"}'::jsonb NOT NULL;

ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;

ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "token_prefix" text DEFAULT '' NOT NULL;

ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "subject_type" text DEFAULT 'gateway_client' NOT NULL;

ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "subject_id" text;

ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "client_label" text DEFAULT '' NOT NULL;

UPDATE "tool_mcp_gateway_tokens"
SET "client_label" = "name"
WHERE "client_label" = '';

ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "owner_note" text DEFAULT '' NOT NULL;

ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "allowed_actions" jsonb DEFAULT '["tools/list","tools/call"]'::jsonb NOT NULL;

ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "expiry_override_reason" text;

ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "expiry_override_by_user_id" text;

ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "expiry_override_by_agent_id" uuid;

ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "expiry_override_at" timestamp with time zone;

ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "gateway_id" uuid;

ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "gateway_token_id" uuid;

ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "gateway_public_id" text;

ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "client_subject_type" text;

ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "client_subject_id" text;

ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "client_name" text;

ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "mcp_session_id" text;

ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "correlation_id" text;

ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "gateway_id" uuid;

ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "gateway_token_id" uuid;

ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "gateway_public_id" text;

ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "client_subject_type" text;

ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "client_subject_id" text;

ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "client_name" text;

ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "mcp_session_id" text;

ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "correlation_id" text;

ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "policy_explanation" jsonb;

ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "credential_scope_summary" jsonb;

ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "header_policy_summary" jsonb;

ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "gateway_id" uuid;

ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "gateway_token_id" uuid;

ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "gateway_public_id" text;

ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "client_subject_type" text;

ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "client_subject_id" text;

ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "client_name" text;

ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "mcp_session_id" text;

ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "correlation_id" text;

ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "policy_explanation" jsonb;

ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "credential_scope_summary" jsonb;

ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "header_policy_summary" jsonb;

ALTER TABLE "tool_access_audit_events" ADD COLUMN IF NOT EXISTS "gateway_id" uuid;

ALTER TABLE "tool_access_audit_events" ADD COLUMN IF NOT EXISTS "gateway_token_id" uuid;

ALTER TABLE "tool_access_audit_events" ADD COLUMN IF NOT EXISTS "gateway_public_id" text;

ALTER TABLE "tool_access_audit_events" ADD COLUMN IF NOT EXISTS "client_name" text;

ALTER TABLE "tool_access_audit_events" ADD COLUMN IF NOT EXISTS "correlation_id" text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_mcp_gateways_approval_issue_id_issues_id_fk') THEN
    ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_approval_issue_id_issues_id_fk" FOREIGN KEY ("approval_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_mcp_gateway_tokens_expiry_override_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_mcp_gateway_tokens" ADD CONSTRAINT "tool_mcp_gateway_tokens_expiry_override_by_agent_id_agents_id_fk" FOREIGN KEY ("expiry_override_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_gateway_sessions_gateway_id_tool_mcp_gateways_id_fk') THEN
    ALTER TABLE "tool_gateway_sessions" ADD CONSTRAINT "tool_gateway_sessions_gateway_id_tool_mcp_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."tool_mcp_gateways"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_gateway_sessions_gateway_token_id_tool_mcp_gateway_tokens_id_fk') THEN
    ALTER TABLE "tool_gateway_sessions" ADD CONSTRAINT "tool_gateway_sessions_gateway_token_id_tool_mcp_gateway_tokens_id_fk" FOREIGN KEY ("gateway_token_id") REFERENCES "public"."tool_mcp_gateway_tokens"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_gateway_id_tool_mcp_gateways_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_gateway_id_tool_mcp_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."tool_mcp_gateways"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_gateway_token_id_tool_mcp_gateway_tokens_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_gateway_token_id_tool_mcp_gateway_tokens_id_fk" FOREIGN KEY ("gateway_token_id") REFERENCES "public"."tool_mcp_gateway_tokens"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_gateway_id_tool_mcp_gateways_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_gateway_id_tool_mcp_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."tool_mcp_gateways"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_gateway_token_id_tool_mcp_gateway_tokens_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_gateway_token_id_tool_mcp_gateway_tokens_id_fk" FOREIGN KEY ("gateway_token_id") REFERENCES "public"."tool_mcp_gateway_tokens"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_access_audit_events_gateway_id_tool_mcp_gateways_id_fk') THEN
    ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_gateway_id_tool_mcp_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."tool_mcp_gateways"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_access_audit_events_gateway_token_id_tool_mcp_gateway_tokens_id_fk') THEN
    ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_gateway_token_id_tool_mcp_gateway_tokens_id_fk" FOREIGN KEY ("gateway_token_id") REFERENCES "public"."tool_mcp_gateway_tokens"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "tool_mcp_gateways_public_id_uq" ON "tool_mcp_gateways" USING btree ("gateway_public_id");

CREATE INDEX IF NOT EXISTS "tool_mcp_gateway_tokens_subject_idx" ON "tool_mcp_gateway_tokens" USING btree ("company_id", "subject_type", "subject_id");

CREATE INDEX IF NOT EXISTS "tool_gateway_sessions_gateway_idx" ON "tool_gateway_sessions" USING btree ("company_id", "gateway_id");

CREATE INDEX IF NOT EXISTS "tool_invocations_gateway_idx" ON "tool_invocations" USING btree ("company_id", "gateway_id");

CREATE INDEX IF NOT EXISTS "tool_call_events_gateway_idx" ON "tool_call_events" USING btree ("company_id", "gateway_id");

CREATE INDEX IF NOT EXISTS "tool_access_audit_gateway_idx" ON "tool_access_audit_events" USING btree ("company_id", "gateway_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('83f11418a9186bde3730d2539103123b03f73db1e9c16770a7e1aa2bdf03fd2d', 1783953527660);

-- >>> Migration: 0161_environment_custom_image_company_scope_repair.sql <<<
-- No-op retained for migration ordering compatibility.
--
-- This branch previously carried a company-scope repair for environment custom
-- images, but origin/master intentionally restored custom images to the
-- instance-scoped environment model in 0127. Reapplying company scope here
-- contradicts the checked-in Drizzle schema and can fail against cloned
-- multi-company dev databases.
SELECT 1;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('cad090ef744bc10a6cb6a7ae4bf83dce3e577dd0522d140a4b7269b11908fee2', 1783953528660);

-- >>> Migration: 0162_tool_runtime_metric_counters.sql <<<
CREATE TABLE IF NOT EXISTS "tool_runtime_metric_counters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "metric" text NOT NULL,
  "bucket_start_at" timestamp with time zone NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tool_runtime_metric_counters_count_nonnegative" CHECK ("count" >= 0)
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tool_runtime_metric_counters_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "tool_runtime_metric_counters"
      ADD CONSTRAINT "tool_runtime_metric_counters_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "tool_runtime_metric_counters_company_metric_idx"
  ON "tool_runtime_metric_counters" USING btree ("company_id", "metric", "bucket_start_at");

CREATE UNIQUE INDEX IF NOT EXISTS "tool_runtime_metric_counters_bucket_uq"
  ON "tool_runtime_metric_counters" USING btree ("company_id", "metric", "bucket_start_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('57184b1fded85bfaa8db52b7cd80defd6383b246d987ded9954100d33aaf290c', 1783953529660);

-- >>> Migration: 0163_secret_binding_projection_class.sql <<<
ALTER TABLE "company_secret_bindings" ADD COLUMN IF NOT EXISTS "projection_class" text DEFAULT 'unclassified' NOT NULL;
ALTER TABLE "company_secret_bindings" ADD COLUMN IF NOT EXISTS "projection_allowlist_key" text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('3f9c079cbdf1eb26e6b3568b13443376192b064bf316e0286456806d8730afcb', 1783953530660);

-- >>> Migration: 0164_plugin_config_company_scope.sql <<<
-- Scope plugin configuration rows by company before re-enabling plugin secret
-- refs. Legacy rows were instance-global; preserve only rows with an
-- unambiguous company owner and fail closed when a row is ambiguous.

ALTER TABLE "plugin_config"
  ADD COLUMN IF NOT EXISTS "company_id" uuid;

WITH binding_owner AS (
  SELECT
    pc."id" AS config_id,
    min(csb."company_id"::text)::uuid AS company_id,
    count(DISTINCT csb."company_id") AS company_count
  FROM "plugin_config" pc
  JOIN "company_secret_bindings" csb
    ON csb."target_type" = 'plugin'
   AND csb."target_id" = pc."plugin_id"::text
  GROUP BY pc."id"
)
UPDATE "plugin_config" pc
SET "company_id" = bo."company_id"
FROM binding_owner bo
WHERE pc."company_id" IS NULL
  AND bo."config_id" = pc."id"
  AND bo."company_count" = 1;

WITH single_company AS (
  SELECT min("id"::text)::uuid AS company_id, count(*) AS company_count
  FROM "companies"
)
UPDATE "plugin_config" pc
SET "company_id" = sc."company_id"
FROM single_company sc
WHERE pc."company_id" IS NULL
  AND sc."company_count" = 1;

DROP INDEX IF EXISTS "plugin_config_plugin_id_idx";

WITH unbound_config AS (
  SELECT pc.*
  FROM "plugin_config" pc
  WHERE pc."company_id" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "company_secret_bindings" csb
      WHERE csb."target_type" = 'plugin'
        AND csb."target_id" = pc."plugin_id"::text
    )
), primary_company AS (
  SELECT min("id"::text)::uuid AS company_id
  FROM "companies"
)
INSERT INTO "plugin_config" (
  "plugin_id",
  "company_id",
  "config_json",
  "last_error",
  "created_at",
  "updated_at"
)
SELECT
  uc."plugin_id",
  c."id",
  uc."config_json",
  uc."last_error",
  uc."created_at",
  uc."updated_at"
FROM unbound_config uc
CROSS JOIN "companies" c
CROSS JOIN primary_company pc
WHERE c."id" <> pc."company_id";

WITH primary_company AS (
  SELECT min("id"::text)::uuid AS company_id
  FROM "companies"
)
UPDATE "plugin_config" pc
SET "company_id" = primary_company."company_id"
FROM primary_company
WHERE pc."company_id" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "company_secret_bindings" csb
    WHERE csb."target_type" = 'plugin'
      AND csb."target_id" = pc."plugin_id"::text
  );

DO $$
DECLARE
  unresolved_count integer;
BEGIN
  SELECT count(*) INTO unresolved_count
  FROM "plugin_config"
  WHERE "company_id" IS NULL;

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'Cannot assign company_id for % plugin_config row(s); resolve ambiguous plugin secret bindings before applying migration 0164', unresolved_count;
  END IF;
END $$;

ALTER TABLE "plugin_config"
  ALTER COLUMN "company_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plugin_config_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "plugin_config"
      ADD CONSTRAINT "plugin_config_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "plugin_config_plugin_company_idx"
  ON "plugin_config" USING btree ("plugin_id", "company_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('7bebb273adc3938b535366249fab60af88ff842cfff27618ca026156bc61fe7a', 1783953531660);

-- >>> Migration: 0165_connection_token_issuances.sql <<<
CREATE TABLE IF NOT EXISTS "connection_token_issuances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "application_id" uuid,
  "connection_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "run_id" uuid,
  "issue_id" uuid,
  "project_id" uuid,
  "responsible_user_id" text,
  "path" text NOT NULL,
  "requested_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "issued_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "ttl_seconds" integer,
  "expires_at" timestamp with time zone,
  "token_hash" text,
  "outcome" text NOT NULL,
  "error_code" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "connection_token_issuances_path_check" CHECK ("connection_token_issuances"."path" IN ('exchange', 'oauth_access', 'static')),
  CONSTRAINT "connection_token_issuances_outcome_check" CHECK ("connection_token_issuances"."outcome" IN ('success', 'denied', 'rate_limited', 'use_env_lease', 'upstream_error', 'failure')),
  CONSTRAINT "connection_token_issuances_ttl_bounds" CHECK ("connection_token_issuances"."ttl_seconds" IS NULL OR ("connection_token_issuances"."ttl_seconds" >= 1 AND "connection_token_issuances"."ttl_seconds" <= 900)),
  CONSTRAINT "connection_token_issuances_token_hash_format" CHECK ("connection_token_issuances"."token_hash" IS NULL OR "connection_token_issuances"."token_hash" ~ '^[a-f0-9]{64}$')
);
DO $$ BEGIN
  ALTER TABLE "connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "connection_token_issuances_company_created_idx" ON "connection_token_issuances" USING btree ("company_id", "created_at");
CREATE INDEX IF NOT EXISTS "connection_token_issuances_connection_created_idx" ON "connection_token_issuances" USING btree ("company_id", "connection_id", "created_at");
CREATE INDEX IF NOT EXISTS "connection_token_issuances_agent_connection_idx" ON "connection_token_issuances" USING btree ("company_id", "agent_id", "connection_id", "created_at");
CREATE INDEX IF NOT EXISTS "connection_token_issuances_run_idx" ON "connection_token_issuances" USING btree ("company_id", "run_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('0a3d602fd1949a57b11bc83d72f7514ad2af41b9bf81ef38d167d00f0abdbfa6', 1783953532660);

-- >>> Migration: 0166_smoke_lab_results.sql <<<
CREATE TABLE IF NOT EXISTS "smoke_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "trigger" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "smoke_run_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "path" text NOT NULL,
  "scenario_step" text NOT NULL,
  "status" text NOT NULL,
  "detail" text,
  "screenshot_artifact_ref" jsonb,
  "duration_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "smoke_runs" ADD CONSTRAINT "smoke_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "smoke_run_steps" ADD CONSTRAINT "smoke_run_steps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "smoke_run_steps" ADD CONSTRAINT "smoke_run_steps_run_id_smoke_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."smoke_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "smoke_runs_company_started_idx" ON "smoke_runs" USING btree ("company_id", "started_at");

CREATE INDEX IF NOT EXISTS "smoke_runs_company_status_idx" ON "smoke_runs" USING btree ("company_id", "status");

CREATE INDEX IF NOT EXISTS "smoke_run_steps_company_run_idx" ON "smoke_run_steps" USING btree ("company_id", "run_id");

CREATE INDEX IF NOT EXISTS "smoke_run_steps_company_path_idx" ON "smoke_run_steps" USING btree ("company_id", "path");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('1316a83524f3c2d237a8c0dc101a63f3ec8a222816bd2d7fbc1bfc0174f38552', 1783953533660);

-- >>> Migration: 0167_environment_custom_image_instance_scope_cleanup.sql <<<
-- Keep environment custom image tables aligned with the instance-scoped schema.
-- This is safe for databases that never ran the stale 0158 company-scope repair
-- and repairs databases that did run it before 0158 was neutralized.
DROP INDEX IF EXISTS "environment_custom_image_templates_company_environment_status_idx";

DROP INDEX IF EXISTS "environment_custom_image_templates_company_provider_status_idx";

DROP INDEX IF EXISTS "environment_custom_image_templates_company_environment_active_uq";

DROP INDEX IF EXISTS "environment_custom_image_templates_company_last_used_idx";

DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_environment_status_idx";

DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_environment_active_uq";

DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_template_idx";

DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_promoted_template_idx";

DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_expires_idx";

ALTER TABLE "environment_custom_image_templates"
  DROP CONSTRAINT IF EXISTS "environment_custom_image_templates_company_id_companies_id_fk";

ALTER TABLE "environment_custom_image_setup_sessions"
  DROP CONSTRAINT IF EXISTS "environment_custom_image_setup_sessions_company_id_companies_id_fk";

ALTER TABLE "environment_custom_image_templates"
  DROP COLUMN IF EXISTS "company_id";

ALTER TABLE "environment_custom_image_setup_sessions"
  DROP COLUMN IF EXISTS "company_id";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('c6c8c249b787885d59cd5ef0d7f65927f2b42bd08f9d9273fceaeebabc2e8933', 1783953534660);

-- >>> Migration: 0168_tool_connection_installs.sql <<<
CREATE TABLE IF NOT EXISTS "tool_connection_installs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tool_connection_installs_target_type_check" CHECK ("target_type" in ('company', 'agent'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tool_connection_installs_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "tool_connection_installs"
      ADD CONSTRAINT "tool_connection_installs_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tool_connection_installs_connection_id_tool_connections_id_fk'
  ) THEN
    ALTER TABLE "tool_connection_installs"
      ADD CONSTRAINT "tool_connection_installs_connection_id_tool_connections_id_fk"
      FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tool_connection_installs_created_by_agent_id_agents_id_fk'
  ) THEN
    ALTER TABLE "tool_connection_installs"
      ADD CONSTRAINT "tool_connection_installs_created_by_agent_id_agents_id_fk"
      FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "tool_connection_installs_company_target_idx" ON "tool_connection_installs" USING btree ("company_id","target_type","target_id");

CREATE INDEX IF NOT EXISTS "tool_connection_installs_connection_idx" ON "tool_connection_installs" USING btree ("company_id","connection_id");

CREATE UNIQUE INDEX IF NOT EXISTS "tool_connection_installs_target_uq" ON "tool_connection_installs" USING btree ("company_id","connection_id","target_type","target_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('9c9c18ac797dc0b041c8a613594a1a20d5e7299d8e2ea374971909a256e368f2', 1783953535660);

-- >>> Migration: 0169_tool_gateway_protocol_rate_limit_counters.sql <<<
CREATE TABLE IF NOT EXISTS "tool_gateway_rate_limit_counters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "counter_key" text NOT NULL,
  "window_start_at" timestamp with time zone NOT NULL,
  "window_ms" integer NOT NULL,
  "limit" integer NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "reset_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tool_gateway_rate_limit_counters_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "tool_gateway_rate_limit_counters"
      ADD CONSTRAINT "tool_gateway_rate_limit_counters_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tool_gateway_rate_limit_counters_window_bounds'
  ) THEN
    ALTER TABLE "tool_gateway_rate_limit_counters"
      ADD CONSTRAINT "tool_gateway_rate_limit_counters_window_bounds"
      CHECK ("window_ms" > 0 AND "limit" > 0 AND "count" >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "tool_gateway_rate_limit_counters_company_idx"
  ON "tool_gateway_rate_limit_counters" USING btree ("company_id");

CREATE UNIQUE INDEX IF NOT EXISTS "tool_gateway_rate_limit_counters_window_uq"
  ON "tool_gateway_rate_limit_counters" USING btree ("company_id","counter_key","window_start_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('adc841c1cb58927750ef6ad32e4a38262d69a58596db4c9b00e7adac406662e9', 1783953536660);

-- >>> Migration: 0170_company_skill_policies.sql <<<
CREATE TABLE IF NOT EXISTS "company_skill_policies" (
  "company_id" uuid PRIMARY KEY NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "revision" integer NOT NULL,
  "default_effect" text NOT NULL,
  "rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "company_skill_policies_schema_version_check" CHECK ("schema_version" = 1),
  CONSTRAINT "company_skill_policies_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "company_skill_policies_default_effect_check" CHECK ("default_effect" IN ('allow', 'deny'))
);


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('d2e85c848a1f56d9cd654b644fa51e137d9925ef4ae7f8dea0258ad7bd6db1a7', 1784037600000);

-- >>> Migration: 0171_issue_create_idempotency_keys.sql <<<
CREATE TABLE IF NOT EXISTS "issue_create_idempotency_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "issue_create_idempotency_keys_company_key_uq"
  ON "issue_create_idempotency_keys" USING btree ("company_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "issue_create_idempotency_keys_issue_idx"
  ON "issue_create_idempotency_keys" USING btree ("issue_id");
CREATE INDEX IF NOT EXISTS "issues_open_normalized_title_created_idx"
  ON "issues" USING btree (
    "company_id",
    "parent_id",
    lower(regexp_replace(btrim("title"), '\s+', ' ', 'g')),
    "created_at"
  )
  WHERE "hidden_at" is null and "status" not in ('done', 'cancelled');


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('6d19e7c22629a90a0fd660b79361f211225736817e5c9d9d7daa05b494325b95', 1784160000000);

-- >>> Migration: 0172_inbox_archive_agent_policies.sql <<<
ALTER TABLE "issue_inbox_archives" ADD COLUMN IF NOT EXISTS "archived_by_actor_type" text DEFAULT 'user' NOT NULL;
ALTER TABLE "issue_inbox_archives" ADD COLUMN IF NOT EXISTS "archived_by_agent_id" uuid;
ALTER TABLE "issue_inbox_archives" ADD COLUMN IF NOT EXISTS "archived_by_run_id" uuid;
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'issue_inbox_archives_archived_by_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_archived_by_agent_id_agents_id_fk" FOREIGN KEY ("archived_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'issue_inbox_archives_archived_by_run_id_heartbeat_runs_id_fk'
	) THEN
		ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_archived_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("archived_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'issue_inbox_archives_archived_by_actor_type_check'
	) THEN
		ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_archived_by_actor_type_check" CHECK ("archived_by_actor_type" IN ('user', 'agent'));
	END IF;
END $$;
CREATE TABLE IF NOT EXISTS "user_inbox_agent_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"mode" text DEFAULT 'open' NOT NULL,
	"allowed_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_inbox_agent_policies_mode_check" CHECK ("mode" IN ('open', 'allowlist', 'disabled'))
);
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'user_inbox_agent_policies_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "user_inbox_agent_policies" ADD CONSTRAINT "user_inbox_agent_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "user_inbox_agent_policies_company_user_uq" ON "user_inbox_agent_policies" USING btree ("company_id", "user_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('db36bf2e1ccf72c9681edc5bce1af24c64d2eadb486b1817ace7c85e2727ea17', 1784169959628);

-- >>> Migration: 0173_inbox_policy_agent_cleanup.sql <<<
CREATE INDEX IF NOT EXISTS "user_inbox_agent_policies_allowed_agent_ids_idx" ON "user_inbox_agent_policies" USING gin ("allowed_agent_ids");

CREATE OR REPLACE FUNCTION "remove_deleted_agent_from_inbox_policy_allowlists"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	UPDATE "user_inbox_agent_policies"
	SET
		"allowed_agent_ids" = "allowed_agent_ids" - OLD."id"::text,
		"updated_at" = now()
	WHERE "allowed_agent_ids" ? OLD."id"::text;
	RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS "agents_cleanup_inbox_policy_allowlists" ON "agents";

CREATE TRIGGER "agents_cleanup_inbox_policy_allowlists"
AFTER DELETE ON "agents"
FOR EACH ROW
EXECUTE FUNCTION "remove_deleted_agent_from_inbox_policy_allowlists"();


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('a4a1d0ebc11d81c59653b35d2daf8c874f45b8cf2cef836eec4ba2114bbcd642', 1784210753027);

-- >>> Migration: 0174_folders.sql <<<
CREATE TABLE IF NOT EXISTS "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "folder_id" uuid;

ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "folder_id" uuid;

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'folders_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "folders" ADD CONSTRAINT "folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'company_skills_folder_id_folders_id_fk'
	) THEN
		ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'routines_folder_id_folders_id_fk'
	) THEN
		ALTER TABLE "routines" ADD CONSTRAINT "routines_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS "folders_company_kind_position_idx" ON "folders" USING btree ("company_id","kind","position","name");

CREATE UNIQUE INDEX IF NOT EXISTS "folders_company_kind_name_uq" ON "folders" USING btree ("company_id","kind","name");

CREATE INDEX IF NOT EXISTS "company_skills_company_folder_idx" ON "company_skills" USING btree ("company_id","folder_id");

CREATE INDEX IF NOT EXISTS "routines_company_folder_idx" ON "routines" USING btree ("company_id","folder_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('8483f2d9441b96cbf567a72f3728cda020940b2d18fb2a595775b62f995b0ed5', 1784210754027);

-- >>> Migration: 0175_nested_skill_folders.sql <<<
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "parent_id" uuid;

ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "slug" text;

ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "system_key" text;

WITH normalized AS (
  SELECT
    "id",
    COALESCE(
      NULLIF(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER("name"), '[^a-z0-9]+', '-', 'g')), ''),
      'folder'
    ) AS base_slug,
    ROW_NUMBER() OVER (
      PARTITION BY "company_id", "kind", COALESCE(
        NULLIF(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER("name"), '[^a-z0-9]+', '-', 'g')), ''),
        'folder'
      )
      ORDER BY "id"
    ) AS duplicate_number
  FROM "folders"
  WHERE "slug" IS NULL
)
UPDATE "folders" AS folder
SET "slug" = CASE
  WHEN normalized.duplicate_number = 1 THEN normalized.base_slug
  ELSE normalized.base_slug || '-' || LEFT(folder."id"::text, 8)
END
FROM normalized
WHERE folder."id" = normalized."id";

ALTER TABLE "folders" ALTER COLUMN "slug" SET NOT NULL;

DROP INDEX IF EXISTS "folders_company_kind_name_uq";

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint" WHERE "conname" = 'folders_parent_id_folders_id_fk'
  ) THEN
    ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk"
      FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;

ALTER TABLE "folders" DROP CONSTRAINT IF EXISTS "folders_company_kind_parent_slug_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "folders_company_kind_root_slug_uq"
  ON "folders" USING btree ("company_id", "kind", "slug")
  WHERE "parent_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "folders_company_kind_parent_slug_uq"
  ON "folders" USING btree ("company_id", "kind", "parent_id", "slug")
  WHERE "parent_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "folders_company_kind_system_key_uq"
  ON "folders" USING btree ("company_id", "kind", "system_key")
  WHERE "system_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "folders_company_kind_parent_position_idx"
  ON "folders" USING btree ("company_id", "kind", "parent_id", "position", "name");

UPDATE "folders" AS folder
SET "slug" = 'bundled-' || LEFT(REPLACE(folder."id"::text, '-', ''), 8), "updated_at" = now()
WHERE folder."kind" = 'skill'
  AND folder."parent_id" IS NULL
  AND folder."slug" = 'bundled'
  AND folder."system_key" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "company_skills" AS skill
    WHERE skill."company_id" = folder."company_id"
      AND skill."folder_id" IS NULL
      AND (skill."key" LIKE 'paperclipai/bundled/%' OR skill."metadata"->>'sourceKind' = 'paperclip_bundled')
  );

INSERT INTO "folders" ("company_id", "kind", "parent_id", "name", "slug", "system_key", "position")
SELECT DISTINCT skill."company_id", 'skill', NULL::uuid, 'Bundled', 'bundled', 'bundled', 0
FROM "company_skills" AS skill
WHERE skill."folder_id" IS NULL
  AND (skill."key" LIKE 'paperclipai/bundled/%' OR skill."metadata"->>'sourceKind' = 'paperclip_bundled')
  AND NOT EXISTS (
    SELECT 1 FROM "folders" AS folder
    WHERE folder."company_id" = skill."company_id"
      AND folder."kind" = 'skill'
      AND folder."system_key" = 'bundled'
  )
ON CONFLICT DO NOTHING;

WITH bundled_categories AS (
  SELECT DISTINCT ON (skill."company_id", category.slug)
    skill."company_id",
    category.name,
    category.slug
  FROM "company_skills" AS skill
  CROSS JOIN LATERAL (
    SELECT
      COALESCE(NULLIF(SPLIT_PART(skill."key", '/', 3), ''), 'other') AS name,
      COALESCE(
        NULLIF(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(COALESCE(NULLIF(SPLIT_PART(skill."key", '/', 3), ''), 'other')), '[^a-z0-9]+', '-', 'g')), ''),
        'other'
      ) AS slug
  ) AS category
  WHERE skill."folder_id" IS NULL
    AND (skill."key" LIKE 'paperclipai/bundled/%' OR skill."metadata"->>'sourceKind' = 'paperclip_bundled')
  ORDER BY skill."company_id", category.slug, category.name
)
INSERT INTO "folders" ("company_id", "kind", "parent_id", "name", "slug", "system_key", "position")
SELECT category."company_id", 'skill', root."id", category."name", category."slug", 'bundled:' || category."slug", 0
FROM bundled_categories AS category
JOIN "folders" AS root
  ON root."company_id" = category."company_id"
  AND root."kind" = 'skill'
  AND root."system_key" = 'bundled'
ON CONFLICT DO NOTHING;

UPDATE "company_skills" AS skill
SET "folder_id" = category_folder."id", "updated_at" = now()
FROM "folders" AS root
JOIN "folders" AS category_folder
  ON category_folder."company_id" = root."company_id"
  AND category_folder."kind" = 'skill'
  AND category_folder."parent_id" = root."id"
WHERE skill."company_id" = root."company_id"
  AND root."kind" = 'skill'
  AND root."system_key" = 'bundled'
  AND skill."folder_id" IS NULL
  AND (skill."key" LIKE 'paperclipai/bundled/%' OR skill."metadata"->>'sourceKind' = 'paperclip_bundled')
  AND category_folder."system_key" = 'bundled:' || COALESCE(
    NULLIF(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(COALESCE(NULLIF(SPLIT_PART(skill."key", '/', 3), ''), 'other')), '[^a-z0-9]+', '-', 'g')), ''),
    'other'
  );

UPDATE "folders" AS folder
SET "slug" = 'projects-' || LEFT(REPLACE(folder."id"::text, '-', ''), 8), "updated_at" = now()
WHERE folder."kind" = 'skill'
  AND folder."parent_id" IS NULL
  AND folder."slug" = 'projects'
  AND folder."system_key" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "company_skills" AS skill
    WHERE skill."company_id" = folder."company_id"
      AND skill."folder_id" IS NULL
      AND skill."metadata"->>'sourceKind' = 'project_scan'
      AND skill."metadata"->>'projectId' IS NOT NULL
  );

INSERT INTO "folders" ("company_id", "kind", "parent_id", "name", "slug", "system_key", "position")
SELECT DISTINCT skill."company_id", 'skill', NULL::uuid, 'Projects', 'projects', 'projects', 1
FROM "company_skills" AS skill
WHERE skill."folder_id" IS NULL
  AND skill."metadata"->>'sourceKind' = 'project_scan'
  AND skill."metadata"->>'projectId' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "folders" AS folder
    WHERE folder."company_id" = skill."company_id"
      AND folder."kind" = 'skill'
      AND folder."system_key" = 'projects'
  )
ON CONFLICT DO NOTHING;

WITH project_sources AS (
  SELECT DISTINCT ON (skill."company_id", skill."metadata"->>'projectId')
    skill."company_id",
    skill."metadata"->>'projectId' AS project_id,
    COALESCE(project."name", NULLIF(skill."metadata"->>'projectName', ''), 'Project') AS project_name
  FROM "company_skills" AS skill
  LEFT JOIN "projects" AS project
    ON project."id"::text = skill."metadata"->>'projectId'
    AND project."company_id" = skill."company_id"
  WHERE skill."folder_id" IS NULL
    AND skill."metadata"->>'sourceKind' = 'project_scan'
    AND skill."metadata"->>'projectId' IS NOT NULL
  ORDER BY skill."company_id", skill."metadata"->>'projectId', skill."id"
), project_folders AS (
  SELECT
    source."company_id",
    source.project_id,
    source.project_name,
    container."id" AS parent_id,
    COALESCE(
      NULLIF(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(source.project_name), '[^a-z0-9]+', '-', 'g')), ''),
      'project'
    ) AS base_slug
  FROM project_sources AS source
  JOIN "folders" AS container
    ON container."company_id" = source."company_id"
    AND container."kind" = 'skill'
    AND container."system_key" = 'projects'
), ranked_project_folders AS (
  SELECT
    source.*,
    ROW_NUMBER() OVER (
      PARTITION BY source."company_id", source.parent_id, source.base_slug
      ORDER BY source.project_id
    ) AS duplicate_number
  FROM project_folders AS source
)
INSERT INTO "folders" ("company_id", "kind", "parent_id", "name", "slug", "system_key", "position")
SELECT
  source."company_id",
  'skill',
  source.parent_id,
  source.project_name,
  CASE
    WHEN sibling."id" IS NULL AND source.duplicate_number = 1 THEN source.base_slug
    ELSE source.base_slug || '-' || LEFT(source.project_id, 8)
  END,
  'project:' || source.project_id,
  0
FROM ranked_project_folders AS source
LEFT JOIN "folders" AS sibling
  ON sibling."company_id" = source."company_id"
  AND sibling."kind" = 'skill'
  AND sibling."parent_id" = source.parent_id
  AND sibling."slug" = source.base_slug
WHERE NOT EXISTS (
  SELECT 1 FROM "folders" AS existing
  WHERE existing."company_id" = source."company_id"
    AND existing."kind" = 'skill'
    AND existing."system_key" = 'project:' || source.project_id
)
ON CONFLICT DO NOTHING;

UPDATE "company_skills" AS skill
SET "folder_id" = project_folder."id", "updated_at" = now()
FROM "folders" AS project_folder
WHERE project_folder."company_id" = skill."company_id"
  AND project_folder."kind" = 'skill'
  AND project_folder."system_key" = 'project:' || (skill."metadata"->>'projectId')
  AND skill."folder_id" IS NULL
  AND skill."metadata"->>'sourceKind' = 'project_scan';


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('be7e1e3b63c65cf227ce1c84f5282706e6b006edd0bdb923cf93bf8dc2e86060', 1784210755027);

-- >>> Migration: 0176_issue_create_idempotency_key_expiry.sql <<<
CREATE INDEX IF NOT EXISTS "issue_create_idempotency_keys_company_created_at_idx"
  ON "issue_create_idempotency_keys" USING btree ("company_id", "created_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('119867da6baf0e9c6adef3387d640da7bbbed80bbcbb0fb88e35bd53371af953', 1784211956161);

-- >>> Migration: 0177_activity_log_responsible_user.sql <<<
ALTER TABLE "activity_log"
  ADD COLUMN IF NOT EXISTS "responsible_user_id" text;

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because this forward-only index is required for the new agent audit feed.
CREATE INDEX IF NOT EXISTS "activity_log_company_agent_created_idx"
  ON "activity_log" USING btree ("company_id", "agent_id", "created_at");

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because this forward-only index is required for the new responsible-user audit feed.
CREATE INDEX IF NOT EXISTS "activity_log_company_responsible_user_created_idx"
  ON "activity_log" USING btree ("company_id", "responsible_user_id", "created_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('1eb4a204a06a54db7e887ff26c9adc4996059a904aba5592806a2a4bdbad051a', 1784241826832);

-- >>> Migration: 0178_summary_slots.sql <<<
CREATE TABLE IF NOT EXISTS "summary_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" uuid,
	"slot_key" text NOT NULL,
	"document_id" uuid,
	"status" text DEFAULT 'idle' NOT NULL,
	"generating_issue_id" uuid,
	"last_generated_at" timestamp with time zone,
	"last_generated_by_agent_id" uuid,
	"last_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "summary_slots_company_scope_slot_uq" UNIQUE NULLS NOT DISTINCT("company_id","scope_kind","scope_id","slot_key")
);

DO $$ BEGIN
 ALTER TABLE "summary_slots" ADD CONSTRAINT "summary_slots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
 ALTER TABLE "summary_slots" ADD CONSTRAINT "summary_slots_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
 ALTER TABLE "summary_slots" ADD CONSTRAINT "summary_slots_generating_issue_id_issues_id_fk" FOREIGN KEY ("generating_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
 ALTER TABLE "summary_slots" ADD CONSTRAINT "summary_slots_last_generated_by_agent_id_agents_id_fk" FOREIGN KEY ("last_generated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "summary_slots_document_uq" ON "summary_slots" USING btree ("document_id");
CREATE INDEX IF NOT EXISTS "summary_slots_company_scope_idx" ON "summary_slots" USING btree ("company_id","scope_kind","scope_id");
CREATE INDEX IF NOT EXISTS "summary_slots_company_generating_issue_idx" ON "summary_slots" USING btree ("company_id","generating_issue_id");
CREATE INDEX IF NOT EXISTS "summary_slots_company_updated_idx" ON "summary_slots" USING btree ("company_id","updated_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('bd21302a0c52cd29557fa4da8cabc758be52a2f2e87228a42e4fde019d1feeb0', 1784241827832);

-- >>> Migration: 0179_summary_slot_failure_reason.sql <<<
ALTER TABLE "summary_slots" ADD COLUMN IF NOT EXISTS "failure_reason" text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('33063c60038f2ac962241d9ad511b71b2269488d3cf41872c9023ffcd22052c7', 1784241828832);

-- >>> Migration: 0180_decision_training_examples.sql <<<
CREATE TABLE IF NOT EXISTS "decision_training_examples" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "source_kind" text NOT NULL,
  "source_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "cutoff_at" timestamp with time zone NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "notes_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "decision_outcome" text,
  "snapshot" jsonb NOT NULL,
  "created_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decision_training_examples_source_kind_check"
    CHECK ("source_kind" IN ('interaction', 'approval', 'execution_decision'))
);
CREATE INDEX IF NOT EXISTS "decision_training_examples_company_created_at_idx"
  ON "decision_training_examples" USING btree ("company_id", "created_at");
CREATE INDEX IF NOT EXISTS "decision_training_examples_issue_idx"
  ON "decision_training_examples" USING btree ("issue_id");
CREATE UNIQUE INDEX IF NOT EXISTS "decision_training_examples_source_author_uq"
  ON "decision_training_examples" USING btree ("source_kind", "source_id", "created_by_user_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('b578d26f5691fab742b68f4a34b2cff37329906b1c41127f60bbe8506d397ace', 1784216720808);

-- >>> Migration: 0181_decision_training_retention_policy.sql <<<
ALTER TABLE "decision_training_examples"
  ADD COLUMN IF NOT EXISTS "retention_policy" text DEFAULT 'scrub_deleted_comments_v1' NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('5d783cbc61dd0522b91e18c7858415aafc1f5474d7aac32a1456a216e402ac85', 1784231633059);

-- >>> Migration: 0182_connections_v3_schema_core.sql <<<
ALTER TABLE "tool_connections" ADD COLUMN "uid" text;
ALTER TABLE "tool_connections" ADD COLUMN "ownership" text DEFAULT 'customer' NOT NULL;
ALTER TABLE "tool_connections" ADD COLUMN "auth_kind" text DEFAULT 'none' NOT NULL;

UPDATE "tool_connections" AS c
SET "uid" = concat(
  coalesce(nullif(regexp_replace(lower(a."application_key"), '[^a-z0-9]+', '-', 'g'), ''), 'app'),
  '/',
  coalesce(nullif(trim(both '-' from regexp_replace(lower(c."name"), '[^a-z0-9]+', '-', 'g')), ''), 'connection'),
  '-',
  left(c."id"::text, 8)
)
FROM "tool_applications" AS a
WHERE a."id" = c."application_id";

UPDATE "tool_connections"
SET "transport" = 'mcp_remote'
WHERE "transport" = 'remote_http';

UPDATE "tool_connections"
SET "auth_kind" = CASE
  WHEN jsonb_typeof("config" -> 'oauth') = 'object' THEN 'oauth'
  WHEN jsonb_array_length(coalesce("credential_secret_refs", '[]'::jsonb)) > 0
    OR jsonb_array_length(coalesce("credential_refs", '[]'::jsonb)) > 0 THEN 'api_key'
  ELSE 'none'
END;

ALTER TABLE "tool_connections" ALTER COLUMN "uid" SET NOT NULL;
CREATE UNIQUE INDEX "tool_connections_company_uid_uq" ON "tool_connections" USING btree ("company_id", "uid");
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_company_id_uq" UNIQUE ("company_id", "id");
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_ownership_check" CHECK ("ownership" in ('platform_shared', 'platform_provisioned', 'customer', 'dcr'));
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_transport_check" CHECK ("transport" in ('mcp_remote', 'rest_api', 'local_stdio'));
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_auth_kind_check" CHECK ("auth_kind" in ('oauth', 'api_key', 'none'));

CREATE TABLE "connection_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "subject_user_id" text,
  "provider_tenant" jsonb,
  "credential_secret_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "revoked_at" timestamp with time zone,
  "revoked_by_agent_id" uuid,
  "revoked_by_user_id" text,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "connection_grants_kind_check" CHECK ("kind" in ('workspace', 'user')),
  CONSTRAINT "connection_grants_status_check" CHECK ("status" in ('active', 'revoked', 'expired', 'needs_reauthorization')),
  CONSTRAINT "connection_grants_subject_check" CHECK (("kind" = 'user' and "subject_user_id" is not null) or ("kind" = 'workspace' and "subject_user_id" is null)),
  CONSTRAINT "connection_grants_default_check" CHECK ("is_default" = false or "kind" = 'workspace')
);
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_company_connection_fk" FOREIGN KEY ("company_id", "connection_id") REFERENCES "public"."tool_connections"("company_id", "id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_revoked_by_agent_id_agents_id_fk" FOREIGN KEY ("revoked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "connection_grants_company_connection_idx" ON "connection_grants" USING btree ("company_id", "connection_id");
CREATE INDEX "connection_grants_subject_user_idx" ON "connection_grants" USING btree ("company_id", "subject_user_id");
CREATE UNIQUE INDEX "connection_grants_user_uq" ON "connection_grants" USING btree ("connection_id", "subject_user_id");
CREATE UNIQUE INDEX "connection_grants_default_uq" ON "connection_grants" USING btree ("connection_id") WHERE "is_default" = true AND "kind" = 'workspace';

INSERT INTO "connection_grants" (
  "company_id", "connection_id", "kind", "credential_secret_refs", "status", "is_default",
  "created_by_agent_id", "created_by_user_id", "created_at", "updated_at"
)
SELECT
  "company_id", "id", 'workspace', "credential_secret_refs", 'active', true,
  "created_by_agent_id", "created_by_user_id", "created_at", "updated_at"
FROM "tool_connections";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('16ea6b8bbbf6000e26453ecc4f614e52830a5c6d8258dbf0f1ef0b743540e88c', 1784592000000);

-- >>> Migration: 0183_connection_user_authorization_state.sql <<<
ALTER TABLE "tool_oauth_states" ADD COLUMN "subject_user_id" text;
ALTER TABLE "tool_oauth_states" ADD COLUMN "requested_scopes" jsonb;
ALTER TABLE "tool_oauth_states" ADD COLUMN "return_to" text;
ALTER TABLE "tool_oauth_states" ADD COLUMN "issue_id" uuid;
ALTER TABLE "tool_oauth_states" ADD COLUMN "interaction_id" uuid;
CREATE INDEX "tool_oauth_states_subject_user_idx" ON "tool_oauth_states" USING btree ("company_id", "subject_user_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('34fbfbca813c54004579aa5041042ea30a2b7e7ab82a185efe510de1720c5286', 1784653200000);

-- >>> Migration: 0184_routable_blocked.sql <<<
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "unblock_descriptor" jsonb;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "blocked_transition_at" timestamp with time zone;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "blocked_owner_notified_at" timestamp with time zone;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('fbbb9c10fff4cb62ad05a8eda39afb61180ba6184d8a1ab0661a9857ad79dda7', 1784822400000);

-- >>> Migration: 0185_status_cards.sql <<<
CREATE TABLE IF NOT EXISTS "status_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"title" text,
	"title_pinned" boolean DEFAULT false NOT NULL,
	"interest_prompt" text NOT NULL,
	"queries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"query_version" integer DEFAULT 0 NOT NULL,
	"query_compiled_at" timestamp with time zone,
	"query_compiled_by_agent_id" uuid,
	"instructions_mode" text DEFAULT 'none' NOT NULL,
	"instructions" text,
	"refresh_policy" jsonb NOT NULL,
	"state" text DEFAULT 'compiling' NOT NULL,
	"pending_change_count" integer DEFAULT 0 NOT NULL,
	"last_change_at" timestamp with time zone,
	"fingerprint" jsonb,
	"fingerprint_at" timestamp with time zone,
	"document_id" uuid,
	"last_update_run_kind" text,
	"last_generated_at" timestamp with time zone,
	"last_model" text,
	"generating_issue_id" uuid,
	"failure_reason" text,
	"next_eval_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"archived_by_user_id" text,
	"archived_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "status_card_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"trigger" text NOT NULL,
	"generation_issue_id" uuid,
	"run_id" uuid,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"model" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"error" text
);

DO $$ BEGIN
 ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_query_compiled_by_agent_id_agents_id_fk" FOREIGN KEY ("query_compiled_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_generating_issue_id_issues_id_fk" FOREIGN KEY ("generating_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_archived_by_agent_id_agents_id_fk" FOREIGN KEY ("archived_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "status_card_updates" ADD CONSTRAINT "status_card_updates_card_id_status_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."status_cards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "status_card_updates" ADD CONSTRAINT "status_card_updates_generation_issue_id_issues_id_fk" FOREIGN KEY ("generation_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "status_card_updates" ADD CONSTRAINT "status_card_updates_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "status_cards_company_archived_idx" ON "status_cards" USING btree ("company_id","archived_at");

CREATE INDEX IF NOT EXISTS "status_cards_company_next_eval_idx" ON "status_cards" USING btree ("company_id","next_eval_at");

CREATE INDEX IF NOT EXISTS "status_card_updates_card_started_idx" ON "status_card_updates" USING btree ("card_id","started_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('c74b799ef4bb7a3de742fdbb193b9a417e351c9ecb16045d104bfdfbcc42d540', 1784826000000);

-- >>> Migration: 0186_status_card_compile_provenance.sql <<<
ALTER TABLE "status_card_updates" ADD COLUMN IF NOT EXISTS "query_version" integer;

ALTER TABLE "status_card_updates" ADD COLUMN IF NOT EXISTS "change_summary" text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('721337870aab9a7164b2687d0924e0dd35ae3a4e56b580233715135ca679ba31', 1784829600000);

-- >>> Migration: 0187_status_card_pending_change_hash.sql <<<
ALTER TABLE "status_cards" ADD COLUMN IF NOT EXISTS "pending_change_hash" text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('df2cc510cdd759e0ac34b861489548f6569bdc6fca979f141cdc4dbe0b5f9acb', 1784833200000);

-- >>> Migration: 0188_status_card_generation_issue_index.sql <<<
CREATE INDEX IF NOT EXISTS "status_card_updates_generation_issue_idx" ON "status_card_updates" USING btree ("generation_issue_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f8aa6f315f346afc9837322734aa58d4c6b9e50a0489623a0bc5a1025b958782', 1784837337101);

-- >>> Migration: 0189_status_card_agent.sql <<<
ALTER TABLE "status_cards" ADD COLUMN IF NOT EXISTS "agent_id" uuid;
DO $$ BEGIN
 ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('d04fe363ca70427d1be21ac04fe7f66307361e6aa099205a30df16c80bffedd4', 1784840937101);

-- >>> Migration: 0190_status_card_single_prompt.sql <<<
ALTER TABLE "status_cards" DROP COLUMN IF EXISTS "instructions_mode";
ALTER TABLE "status_cards" DROP COLUMN IF EXISTS "instructions";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('63e911b48b78288908f808fbbe3e9da8fb8991a5a14bb813def82b9ce65f8104', 1784916885226);

-- >>> Migration: 0191_status_card_mentioned_issue_ids.sql <<<
ALTER TABLE "status_cards" ADD COLUMN IF NOT EXISTS "mentioned_issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('b8341e262a2b600be6e75b1d8a1f1e1a7a46ce55ecacd14c2ac29407fa7023d4', 1784916885227);

-- >>> Migration: 0192_task_watchdog_stop_snapshots.sql <<<
ALTER TABLE "issue_watchdogs" ADD COLUMN IF NOT EXISTS "last_observed_stop_snapshot" jsonb;
ALTER TABLE "issue_watchdogs" ADD COLUMN IF NOT EXISTS "last_reviewed_stop_snapshot" jsonb;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('0a5bba629fea3d9a2929f2f568171e7c87e6ba9040c068680773e83742eb7a5c', 1784916886226);

-- >>> Migration: 0193_document_memberships.sql <<<
CREATE TABLE IF NOT EXISTS "document_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "starred_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; this index is created with the new empty membership table for user-scoped starred ordering.
CREATE INDEX IF NOT EXISTS "document_memberships_company_user_starred_idx"
  ON "document_memberships" USING btree ("company_id", "user_id", "starred_at");
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; this uniqueness index is created with the new empty membership table to make star upserts idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS "document_memberships_company_user_document_uq"
  ON "document_memberships" USING btree ("company_id", "user_id", "document_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('7fdf9adfb1c4235128c6a806434da0f2050c199d323b6eeb8fc26cd49a0d28bb', 1785170000000);

-- >>> Migration: 0194_company_skill_releases.sql <<<
ALTER TABLE "company_skill_versions" ADD COLUMN IF NOT EXISTS "release_id" text;
ALTER TABLE "company_skill_versions" ADD COLUMN IF NOT EXISTS "release_name" text;
ALTER TABLE "company_skill_versions" ADD COLUMN IF NOT EXISTS "released_at" timestamp with time zone;
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_versions_skill_release_idx" ON "company_skill_versions" USING btree ("company_skill_id","release_id") WHERE "company_skill_versions"."release_id" is not null;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e76ee70f3968e0d6268acb64a561fd93e3ec33b3aa6301d52f5391aa09853b65', 1784920485226);

-- >>> Migration: 0195_built_in_agent_unique_marker.sql <<<
-- Enforce one active built-in agent per (company, marker key).
--
-- Provisioning used to check-then-insert with no database guard, so two
-- concurrent server processes could each see "no summarizer exists" and both
-- insert, leaving a company with duplicate built-in agents plus paired orphan
-- pending hire_agent approvals.
--
-- Step 1: resolve any pre-existing duplicates so the unique index below can be
-- created. Keep the oldest marked row per (company, key), terminate the newer
-- duplicates, cancel their orphan pending hire_agent approvals, and revoke any
-- API keys those terminated rows held.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, (metadata -> 'paperclipBuiltInAgent' ->> 'key')
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM agents
  WHERE (metadata -> 'paperclipBuiltInAgent' ->> 'key') IS NOT NULL
    AND status <> 'terminated'
),
duplicates AS (
  SELECT id FROM ranked WHERE rn > 1
),
terminated AS (
  UPDATE agents
  SET status = 'terminated', updated_at = now()
  WHERE id IN (SELECT id FROM duplicates)
  RETURNING id
),
cancelled_approvals AS (
  UPDATE approvals
  SET status = 'cancelled', updated_at = now()
  WHERE type = 'hire_agent'
    AND status IN ('pending', 'revision_requested')
    AND (payload ->> 'agentId') IN (SELECT id::text FROM terminated)
  RETURNING id
)
UPDATE agent_api_keys
SET revoked_at = now()
WHERE revoked_at IS NULL
  AND agent_id IN (SELECT id FROM terminated);


-- Step 2: enforce uniqueness going forward. A partial unique index lets the
-- provisioning race lose cleanly (the losing INSERT raises 23505, which
-- provision()/ensure() catch and re-resolve to the winner's row). Terminated
-- rows are excluded so re-provisioning after a termination stays possible.
CREATE UNIQUE INDEX IF NOT EXISTS "agents_company_built_in_agent_key_unique_idx"
  ON "agents" ("company_id", ((metadata -> 'paperclipBuiltInAgent' ->> 'key')))
  WHERE (metadata -> 'paperclipBuiltInAgent' ->> 'key') IS NOT NULL
    AND status <> 'terminated';


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('956efc2dbda881521876b8deae835652079f407462596f230998d86f5fca26a8', 1785170000001);

-- >>> Migration: 0196_drop_cloud_upstream_tables.sql <<<
-- Drop the cloud sync (cloud upstream) tables. The host-to-host transport
-- has been removed in favor of the Import/Export flow, and nothing reads or
-- writes these tables any more. The sender tables (connections, runs) came
-- from 0089; the receiver-side tables never shipped, so these two are all
-- that exist. The feature was experimental and flag-gated off by default,
-- so its run history is intentionally discarded.
DROP TABLE IF EXISTS "cloud_upstream_runs";

DROP TABLE IF EXISTS "cloud_upstream_connections";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('41d1886d8b00f8484b27108e4538d219d9ed77fca10e6ad3006d9558dd9ec28d', 1785170001001);

-- >>> Migration: 0197_decisions_v1.sql <<<
CREATE TABLE IF NOT EXISTS "decision_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"origin_agent_id" uuid NOT NULL,
	"origin_issue_id" uuid NOT NULL,
	"origin_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bundle_id" uuid,
	"origin_agent_id" uuid NOT NULL,
	"origin_issue_id" uuid NOT NULL,
	"origin_run_id" uuid NOT NULL,
	"rule_key" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"options" jsonb NOT NULL,
	"inputs" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"execution_status" text,
	"chosen_option_id" text,
	"input_values" jsonb,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"idempotency_key" text,
	"signed_spec" text NOT NULL,
	"target_snapshots" jsonb NOT NULL,
	"continuation_policy" text DEFAULT 'none' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "decision_target_issues" (
	"decision_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	CONSTRAINT "decision_target_issues_decision_id_issue_id_pk" PRIMARY KEY("decision_id","issue_id")
);

CREATE TABLE IF NOT EXISTS "decision_effect_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"effect_index" integer NOT NULL,
	"effect_type" text NOT NULL,
	"target_issue_id" uuid NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"result" jsonb,
	"error" text,
	"activity_log_id" uuid,
	"executed_at" timestamp with time zone
);

DO $$ BEGIN ALTER TABLE "decision_bundles" ADD CONSTRAINT "decision_bundles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "decision_bundles" ADD CONSTRAINT "decision_bundles_origin_agent_id_agents_id_fk" FOREIGN KEY ("origin_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "decision_bundles" ADD CONSTRAINT "decision_bundles_origin_issue_id_issues_id_fk" FOREIGN KEY ("origin_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "decision_bundles" ADD CONSTRAINT "decision_bundles_origin_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "decisions" ADD CONSTRAINT "decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "decisions" ADD CONSTRAINT "decisions_bundle_id_decision_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."decision_bundles"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "decisions" ADD CONSTRAINT "decisions_origin_agent_id_agents_id_fk" FOREIGN KEY ("origin_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "decisions" ADD CONSTRAINT "decisions_origin_issue_id_issues_id_fk" FOREIGN KEY ("origin_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "decisions" ADD CONSTRAINT "decisions_origin_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "decision_target_issues" ADD CONSTRAINT "decision_target_issues_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "decision_target_issues" ADD CONSTRAINT "decision_target_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "decision_target_issues" ADD CONSTRAINT "decision_target_issues_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "decision_effect_executions" ADD CONSTRAINT "decision_effect_executions_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "decision_effect_executions" ADD CONSTRAINT "decision_effect_executions_target_issue_id_issues_id_fk" FOREIGN KEY ("target_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "decision_effect_executions" ADD CONSTRAINT "decision_effect_executions_activity_log_id_activity_log_id_fk" FOREIGN KEY ("activity_log_id") REFERENCES "public"."activity_log"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "decision_bundles_company_created_at_idx" ON "decision_bundles" USING btree ("company_id","created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "decisions_company_idempotency_uq" ON "decisions" USING btree ("company_id","idempotency_key") WHERE "decisions"."idempotency_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "decisions_company_status_expires_at_idx" ON "decisions" USING btree ("company_id","status","expires_at");

CREATE INDEX IF NOT EXISTS "decisions_bundle_idx" ON "decisions" USING btree ("bundle_id");

CREATE INDEX IF NOT EXISTS "decisions_origin_issue_idx" ON "decisions" USING btree ("origin_issue_id");

CREATE INDEX IF NOT EXISTS "decision_target_issues_decision_idx" ON "decision_target_issues" USING btree ("decision_id");

CREATE INDEX IF NOT EXISTS "decision_target_issues_issue_idx" ON "decision_target_issues" USING btree ("issue_id");

CREATE UNIQUE INDEX IF NOT EXISTS "decision_effect_executions_decision_effect_uq" ON "decision_effect_executions" USING btree ("decision_id","effect_index");

CREATE INDEX IF NOT EXISTS "decision_effect_executions_target_issue_idx" ON "decision_effect_executions" USING btree ("target_issue_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('65da7612683361ab5c7c8362ffee6e2a863433cc7eda3712b9b8f3fc507c848a', 1785175200000);

-- >>> Migration: 0198_decision_queues_and_triage.sql <<<
CREATE TABLE IF NOT EXISTS "decision_queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"added_by_type" text NOT NULL,
	"added_by_agent_id" uuid,
	"added_by_user_id" text,
	"added_by_run_id" uuid,
	"added_by_agent_api_key_id" uuid,
	"responsible_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_queue_items_actor_check" CHECK ((
        ("decision_queue_items"."added_by_type" = 'agent' AND "decision_queue_items"."added_by_agent_id" IS NOT NULL AND "decision_queue_items"."added_by_user_id" IS NULL)
        OR ("decision_queue_items"."added_by_type" = 'user' AND "decision_queue_items"."added_by_agent_id" IS NULL AND "decision_queue_items"."added_by_user_id" IS NOT NULL)
        OR ("decision_queue_items"."added_by_type" = 'system' AND "decision_queue_items"."added_by_agent_id" IS NULL AND "decision_queue_items"."added_by_user_id" IS NULL)
      ))
);

CREATE TABLE IF NOT EXISTS "decision_queues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"created_by_type" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"created_by_agent_api_key_id" uuid,
	"retention_days" integer,
	"seed_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seed_rules_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_queues_creator_check" CHECK ((
        ("decision_queues"."created_by_type" = 'agent' AND "decision_queues"."created_by_agent_id" IS NOT NULL AND "decision_queues"."created_by_user_id" IS NULL)
        OR ("decision_queues"."created_by_type" = 'user' AND "decision_queues"."created_by_agent_id" IS NULL AND "decision_queues"."created_by_user_id" IS NOT NULL)
        OR ("decision_queues"."created_by_type" = 'system' AND "decision_queues"."created_by_agent_id" IS NULL AND "decision_queues"."created_by_user_id" IS NULL)
      )),
	CONSTRAINT "decision_queues_retention_days_check" CHECK ("decision_queues"."retention_days" IS NULL OR ("decision_queues"."retention_days" >= 1 AND "decision_queues"."retention_days" <= 3650))
);

CREATE TABLE IF NOT EXISTS "decision_triage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"decide_by" text,
	"decide_by_date" date,
	"snoozed_until" timestamp with time zone,
	"set_by_type" text NOT NULL,
	"set_by_agent_id" uuid,
	"set_by_user_id" text,
	"set_by_run_id" uuid,
	"set_by_agent_api_key_id" uuid,
	"responsible_user_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_triage_actor_check" CHECK ((
        ("decision_triage"."set_by_type" = 'agent' AND "decision_triage"."set_by_agent_id" IS NOT NULL AND "decision_triage"."set_by_user_id" IS NULL)
        OR ("decision_triage"."set_by_type" = 'user' AND "decision_triage"."set_by_agent_id" IS NULL AND "decision_triage"."set_by_user_id" IS NOT NULL)
      )),
	CONSTRAINT "decision_triage_decide_by_check" CHECK ((
        ("decision_triage"."decide_by" IS NULL AND "decision_triage"."decide_by_date" IS NULL)
        OR ("decision_triage"."decide_by" IN ('today', 'this_week', 'whenever') AND "decision_triage"."decide_by_date" IS NULL)
        OR ("decision_triage"."decide_by" = 'date' AND "decision_triage"."decide_by_date" IS NOT NULL)
      ))
);

CREATE TABLE IF NOT EXISTS "decision_triage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"queue_id" uuid,
	"source_kind" text,
	"source_id" text,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"actor_run_id" uuid,
	"agent_api_key_id" uuid,
	"responsible_user_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_triage_events_actor_check" CHECK ((
        ("decision_triage_events"."actor_type" = 'agent' AND "decision_triage_events"."actor_agent_id" IS NOT NULL AND "decision_triage_events"."actor_user_id" IS NULL)
        OR ("decision_triage_events"."actor_type" = 'user' AND "decision_triage_events"."actor_agent_id" IS NULL AND "decision_triage_events"."actor_user_id" IS NOT NULL)
        OR ("decision_triage_events"."actor_type" = 'system' AND "decision_triage_events"."actor_agent_id" IS NULL AND "decision_triage_events"."actor_user_id" IS NULL)
      ))
);

CREATE UNIQUE INDEX IF NOT EXISTS "decision_queues_id_company_uq" ON "decision_queues" USING btree ("id","company_id");

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queue_items_company_id_companies_id_fk' AND conrelid = 'public.decision_queue_items'::regclass) THEN
		ALTER TABLE "decision_queue_items" ADD CONSTRAINT "decision_queue_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queue_items_added_by_agent_id_agents_id_fk' AND conrelid = 'public.decision_queue_items'::regclass) THEN
		ALTER TABLE "decision_queue_items" ADD CONSTRAINT "decision_queue_items_added_by_agent_id_agents_id_fk" FOREIGN KEY ("added_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queue_items_added_by_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.decision_queue_items'::regclass) THEN
		ALTER TABLE "decision_queue_items" ADD CONSTRAINT "decision_queue_items_added_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("added_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queue_items_added_by_agent_api_key_id_agent_api_keys_id_fk' AND conrelid = 'public.decision_queue_items'::regclass) THEN
		ALTER TABLE "decision_queue_items" ADD CONSTRAINT "decision_queue_items_added_by_agent_api_key_id_agent_api_keys_id_fk" FOREIGN KEY ("added_by_agent_api_key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queue_items_queue_company_fk' AND conrelid = 'public.decision_queue_items'::regclass) THEN
		ALTER TABLE "decision_queue_items" ADD CONSTRAINT "decision_queue_items_queue_company_fk" FOREIGN KEY ("queue_id","company_id") REFERENCES "public"."decision_queues"("id","company_id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queues_company_id_companies_id_fk' AND conrelid = 'public.decision_queues'::regclass) THEN
		ALTER TABLE "decision_queues" ADD CONSTRAINT "decision_queues_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queues_created_by_agent_id_agents_id_fk' AND conrelid = 'public.decision_queues'::regclass) THEN
		ALTER TABLE "decision_queues" ADD CONSTRAINT "decision_queues_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queues_created_by_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.decision_queues'::regclass) THEN
		ALTER TABLE "decision_queues" ADD CONSTRAINT "decision_queues_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queues_created_by_agent_api_key_id_agent_api_keys_id_fk' AND conrelid = 'public.decision_queues'::regclass) THEN
		ALTER TABLE "decision_queues" ADD CONSTRAINT "decision_queues_created_by_agent_api_key_id_agent_api_keys_id_fk" FOREIGN KEY ("created_by_agent_api_key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_company_id_companies_id_fk' AND conrelid = 'public.decision_triage'::regclass) THEN
		ALTER TABLE "decision_triage" ADD CONSTRAINT "decision_triage_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_set_by_agent_id_agents_id_fk' AND conrelid = 'public.decision_triage'::regclass) THEN
		ALTER TABLE "decision_triage" ADD CONSTRAINT "decision_triage_set_by_agent_id_agents_id_fk" FOREIGN KEY ("set_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_set_by_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.decision_triage'::regclass) THEN
		ALTER TABLE "decision_triage" ADD CONSTRAINT "decision_triage_set_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("set_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_set_by_agent_api_key_id_agent_api_keys_id_fk' AND conrelid = 'public.decision_triage'::regclass) THEN
		ALTER TABLE "decision_triage" ADD CONSTRAINT "decision_triage_set_by_agent_api_key_id_agent_api_keys_id_fk" FOREIGN KEY ("set_by_agent_api_key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_events_company_id_companies_id_fk' AND conrelid = 'public.decision_triage_events'::regclass) THEN
		ALTER TABLE "decision_triage_events" ADD CONSTRAINT "decision_triage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_events_queue_id_decision_queues_id_fk' AND conrelid = 'public.decision_triage_events'::regclass) THEN
		ALTER TABLE "decision_triage_events" ADD CONSTRAINT "decision_triage_events_queue_id_decision_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."decision_queues"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_events_actor_agent_id_agents_id_fk' AND conrelid = 'public.decision_triage_events'::regclass) THEN
		ALTER TABLE "decision_triage_events" ADD CONSTRAINT "decision_triage_events_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_events_actor_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.decision_triage_events'::regclass) THEN
		ALTER TABLE "decision_triage_events" ADD CONSTRAINT "decision_triage_events_actor_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("actor_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_events_agent_api_key_id_agent_api_keys_id_fk' AND conrelid = 'public.decision_triage_events'::regclass) THEN
		ALTER TABLE "decision_triage_events" ADD CONSTRAINT "decision_triage_events_agent_api_key_id_agent_api_keys_id_fk" FOREIGN KEY ("agent_api_key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "decision_queue_items_queue_source_uq" ON "decision_queue_items" USING btree ("queue_id","source_kind","source_id");
CREATE INDEX IF NOT EXISTS "decision_queue_items_company_source_idx" ON "decision_queue_items" USING btree ("company_id","source_kind","source_id");
CREATE UNIQUE INDEX IF NOT EXISTS "decision_queues_company_key_uq" ON "decision_queues" USING btree ("company_id","key");
CREATE INDEX IF NOT EXISTS "decision_queues_company_updated_idx" ON "decision_queues" USING btree ("company_id","updated_at");
CREATE UNIQUE INDEX IF NOT EXISTS "decision_triage_company_source_uq" ON "decision_triage" USING btree ("company_id","source_kind","source_id");
CREATE INDEX IF NOT EXISTS "decision_triage_company_decide_by_idx" ON "decision_triage" USING btree ("company_id","decide_by");
CREATE INDEX IF NOT EXISTS "decision_triage_events_company_source_created_idx" ON "decision_triage_events" USING btree ("company_id","source_kind","source_id","created_at");
CREATE INDEX IF NOT EXISTS "decision_triage_events_queue_created_idx" ON "decision_triage_events" USING btree ("queue_id","created_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('d48baf9a0240fe1ee0b071f4cbfc49cc36edd154760c9566d8064d510229862e', 1785603158310);

-- >>> Migration: 0199_decision_queue_composite_key.sql <<<
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queues_id_company_uq' AND conrelid = 'public.decision_queues'::regclass) THEN
		ALTER TABLE "decision_queue_items" DROP CONSTRAINT IF EXISTS "decision_queue_items_queue_company_fk";
		DROP INDEX IF EXISTS "decision_queues_id_company_uq";
		ALTER TABLE "decision_queues" ADD CONSTRAINT "decision_queues_id_company_uq" UNIQUE("id","company_id");
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queue_items_queue_company_fk' AND conrelid = 'public.decision_queue_items'::regclass) THEN
		ALTER TABLE "decision_queue_items" ADD CONSTRAINT "decision_queue_items_queue_company_fk" FOREIGN KEY ("queue_id","company_id") REFERENCES "public"."decision_queues"("id","company_id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('49d1f187dcdb87462299625c8ac733fa5a9b9d7f328b0697931090a5803f597c', 1785605818353);

-- >>> Migration: 0200_yellow_maria_hill.sql <<<
CREATE TABLE IF NOT EXISTS "decision_archive_notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"archive_version" integer NOT NULL,
	"origin_agent_id" uuid NOT NULL,
	"origin_issue_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_archive_notification_outbox_status_check" CHECK ("decision_archive_notification_outbox"."status" IN ('pending', 'delivering', 'delivered'))
);

CREATE TABLE IF NOT EXISTS "decision_retention" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_activity_at" timestamp with time zone NOT NULL,
	"keep" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_reason" text,
	"archived_by_type" text,
	"archived_by_agent_id" uuid,
	"archived_by_user_id" text,
	"archived_by_run_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"archive_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_retention_archive_actor_check" CHECK ((
        ("decision_retention"."archived_at" IS NULL AND "decision_retention"."archived_by_type" IS NULL AND "decision_retention"."archived_by_agent_id" IS NULL AND "decision_retention"."archived_by_user_id" IS NULL)
        OR ("decision_retention"."archived_at" IS NOT NULL AND "decision_retention"."archived_by_type" = 'system' AND "decision_retention"."archived_by_agent_id" IS NULL AND "decision_retention"."archived_by_user_id" IS NULL)
        OR ("decision_retention"."archived_at" IS NOT NULL AND "decision_retention"."archived_by_type" = 'agent' AND "decision_retention"."archived_by_agent_id" IS NOT NULL AND "decision_retention"."archived_by_user_id" IS NULL)
        OR ("decision_retention"."archived_at" IS NOT NULL AND "decision_retention"."archived_by_type" = 'user' AND "decision_retention"."archived_by_agent_id" IS NULL AND "decision_retention"."archived_by_user_id" IS NOT NULL)
      ))
);

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_archive_notification_outbox_company_id_companies_id_fk' AND conrelid = 'public.decision_archive_notification_outbox'::regclass) THEN
		ALTER TABLE "decision_archive_notification_outbox" ADD CONSTRAINT "decision_archive_notification_outbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_archive_notification_outbox_origin_agent_id_agents_id_fk' AND conrelid = 'public.decision_archive_notification_outbox'::regclass) THEN
		ALTER TABLE "decision_archive_notification_outbox" ADD CONSTRAINT "decision_archive_notification_outbox_origin_agent_id_agents_id_fk" FOREIGN KEY ("origin_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_retention_company_id_companies_id_fk' AND conrelid = 'public.decision_retention'::regclass) THEN
		ALTER TABLE "decision_retention" ADD CONSTRAINT "decision_retention_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_retention_archived_by_agent_id_agents_id_fk' AND conrelid = 'public.decision_retention'::regclass) THEN
		ALTER TABLE "decision_retention" ADD CONSTRAINT "decision_retention_archived_by_agent_id_agents_id_fk" FOREIGN KEY ("archived_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_retention_archived_by_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.decision_retention'::regclass) THEN
		ALTER TABLE "decision_retention" ADD CONSTRAINT "decision_retention_archived_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("archived_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "decision_archive_notification_outbox_uq" ON "decision_archive_notification_outbox" USING btree ("company_id","source_kind","source_id","archive_version","origin_agent_id");
CREATE INDEX IF NOT EXISTS "decision_archive_notification_outbox_pending_idx" ON "decision_archive_notification_outbox" USING btree ("status","created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "decision_retention_company_source_uq" ON "decision_retention" USING btree ("company_id","source_kind","source_id");
CREATE INDEX IF NOT EXISTS "decision_retention_company_archived_idx" ON "decision_retention" USING btree ("company_id","archived_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e270a2c71fc3cc115be52873decb60cc4089d9029d328fa6ac083fb7dce82dc9', 1785635155420);

-- >>> Migration: 0201_concerned_captain_midlands.sql <<<
ALTER TABLE "external_objects" ADD COLUMN "refresh_started_at" timestamp with time zone;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('a4856727cf49bf0a2c0f862929cf11790a369a31ee4502c6a15890210d8f9e88', 1785701828695);

-- >>> Migration: 0202_eminent_marvel_zombies.sql <<<
ALTER TABLE "external_objects" ADD COLUMN "refresh_token" uuid;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('9b0346da3c4d48177d60d385e7f4c5255abc72ef9d3687b75dada0de994c86ad', 1785702264747);

-- >>> Migration: 0203_interaction_resolver_governance.sql <<<
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "interaction_resolver_governance" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "requested_resolver_policy" text DEFAULT 'board_only' NOT NULL;
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "effective_resolver_policy" text DEFAULT 'board_only' NOT NULL;
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "resolved_by_run_id" uuid;
DO $$ BEGIN
  ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_resolved_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("resolved_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('1880b804c5cf748d7b9fddfc79d21d55c7c4372ef1bf687c6b95a2a595886eea', 1785702264748);

-- >>> Migration: 0204_interaction_addressee.sql <<<
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "addressee_agent_id" uuid;
DO $$ BEGIN
  ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_addressee_agent_id_agents_id_fk" FOREIGN KEY ("addressee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "issue_thread_interactions_addressee_agent_idx" ON "issue_thread_interactions" USING btree ("addressee_agent_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('07b288ec749d4a972621ff257d3de8a45574cc40cc3935f463f83a3c0e575fc3', 1785702264749);

-- >>> Migration: 0205_narrow_shiva.sql <<<
ALTER TABLE "issue_comments" ADD COLUMN "on_behalf_of_user_id" text;
UPDATE "issue_comments" c
SET "on_behalf_of_user_id" = hr."responsible_user_id"
FROM "heartbeat_runs" hr
JOIN "user" u ON u."id" = hr."responsible_user_id"
WHERE c."created_by_run_id" = hr."id"
	AND c."company_id" = hr."company_id"
	AND c."author_agent_id" = hr."agent_id"
	AND c."on_behalf_of_user_id" IS NULL;
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_on_behalf_of_user_id_user_id_fk" FOREIGN KEY ("on_behalf_of_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('91290b03590f77d8e9a98138ef039db29fa63c687ae3114573e72cbf8ddf651c', 1785853648731);

-- >>> Migration: 0206_review_path_recovery_idempotency_index.sql <<<
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because this partial index covers the new review-recovery key namespace and is required for atomic at-most-once recovery.
CREATE UNIQUE INDEX "agent_wakeup_requests_review_path_recovery_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'issue_review_path_lost:%' AND "agent_wakeup_requests"."status" <> 'skipped';


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2422b1c6e1f97a7eee6d2a8c8e2904c6a7c4af6af1ad22920bf33526434b5fd3', 1785853648732);

-- >>> Migration: 0207_moaning_amazoness.sql <<<
CREATE TABLE IF NOT EXISTS "company_secret_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposed_name" text,
	"proposed_key" text,
	"proposed_description" text,
	"justification" text NOT NULL,
	"value_ciphertext" jsonb,
	"value_fingerprint_sha256" text,
	"value_length" integer,
	"secret_id" uuid,
	"secret_proposal_id" uuid,
	"target_type" text,
	"target_id" uuid,
	"config_path" text,
	"projection_class" text DEFAULT 'unclassified' NOT NULL,
	"binding_target_policy_snapshot" text,
	"proposer_ancestor_ids_snapshot" jsonb,
	"target_ancestor_ids_snapshot" jsonb,
	"proposed_by_agent_id" uuid NOT NULL,
	"origin_issue_id" uuid,
	"origin_run_id" uuid NOT NULL,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"resolution_reason" text,
	"created_secret_id" uuid,
	"applied_binding_config_path" text,
	"ciphertext_scrubbed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_secret_proposals_kind_check" CHECK ("kind" in ('secret', 'binding')),
	CONSTRAINT "company_secret_proposals_status_check" CHECK ("status" in ('pending', 'approved', 'rejected', 'withdrawn', 'expired')),
	CONSTRAINT "company_secret_proposals_projection_check" CHECK ("projection_class" = 'unclassified'),
	CONSTRAINT "company_secret_proposals_shape_check" CHECK (("kind" = 'secret' and "proposed_name" is not null and "proposed_key" is not null and "secret_id" is null and "secret_proposal_id" is null and "target_type" is null and "target_id" is null and "config_path" is null) or ("kind" = 'binding' and (("secret_id" is not null)::int + ("secret_proposal_id" is not null)::int) = 1 and "target_type" = 'agent' and "target_id" is not null and "config_path" is not null))
);

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_proposals_company_id_companies_id_fk' AND conrelid = 'company_secret_proposals'::regclass) THEN
		ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_proposals_secret_id_company_secrets_id_fk' AND conrelid = 'company_secret_proposals'::regclass) THEN
		ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "company_secrets"("id") ON DELETE set null;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_proposals_secret_proposal_id_company_secret_proposals_id_fk' AND conrelid = 'company_secret_proposals'::regclass) THEN
		ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_secret_proposal_id_company_secret_proposals_id_fk" FOREIGN KEY ("secret_proposal_id") REFERENCES "company_secret_proposals"("id") ON DELETE cascade;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_proposals_target_id_agents_id_fk' AND conrelid = 'company_secret_proposals'::regclass) THEN
		ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_target_id_agents_id_fk" FOREIGN KEY ("target_id") REFERENCES "agents"("id") ON DELETE cascade;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_proposals_proposed_by_agent_id_agents_id_fk' AND conrelid = 'company_secret_proposals'::regclass) THEN
		ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "agents"("id") ON DELETE cascade;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_proposals_origin_issue_id_issues_id_fk' AND conrelid = 'company_secret_proposals'::regclass) THEN
		ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_origin_issue_id_issues_id_fk" FOREIGN KEY ("origin_issue_id") REFERENCES "issues"("id") ON DELETE set null;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_proposals_origin_run_id_heartbeat_runs_id_fk' AND conrelid = 'company_secret_proposals'::regclass) THEN
		ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_origin_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "heartbeat_runs"("id") ON DELETE cascade;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_proposals_created_secret_id_company_secrets_id_fk' AND conrelid = 'company_secret_proposals'::regclass) THEN
		ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_created_secret_id_company_secrets_id_fk" FOREIGN KEY ("created_secret_id") REFERENCES "company_secrets"("id") ON DELETE set null;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS "company_secret_proposals_company_status_idx" ON "company_secret_proposals" ("company_id", "status");

CREATE INDEX IF NOT EXISTS "company_secret_proposals_proposer_status_idx" ON "company_secret_proposals" ("proposed_by_agent_id", "status");

CREATE INDEX IF NOT EXISTS "company_secret_proposals_expiry_idx" ON "company_secret_proposals" ("status", "expires_at");

CREATE INDEX IF NOT EXISTS "company_secret_proposals_secret_proposal_idx" ON "company_secret_proposals" ("secret_proposal_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('335414dc280f133e43280873d072d6cad6282a88261c1537fc186f0a869b4d1a', 1785903493352);

-- >>> Migration: 0208_keen_sharon_carter.sql <<<
ALTER TABLE "issues" ADD COLUMN "review_policy" text;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('75ca778c2a9772ac4645e977b60907554ae95261c172af54cad54fc46f265529', 1785988680096);

-- >>> Migration: 0209_heartbeat_context_snapshot_indexes.sql <<<
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_issue_created_idx" ON "heartbeat_runs" USING btree ("company_id", ("context_snapshot" ->> 'issueId'), "created_at" DESC);
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_task_created_idx" ON "heartbeat_runs" USING btree ("company_id", ("context_snapshot" ->> 'taskId'), "created_at" DESC);
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. This expression index removes per-issue full scans of agent_wakeup_requests in recovery sweeps (hasActiveExecutionPath), which currently dominate server load; the one-time build lock is the lesser cost.
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_company_payload_issue_idx" ON "agent_wakeup_requests" USING btree ("company_id", ("payload" ->> 'issueId'));


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('442eec68b079796adc3be617e11dbc172943d1964926050e1e48cf7dae6cc709', 1786020026023);

-- >>> Migration: 0210_heartbeat_context_taskkey_index.sql <<<
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_taskkey_created_idx" ON "heartbeat_runs" USING btree ("company_id", ("context_snapshot" ->> 'taskKey'), "created_at" DESC);


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('51fab2cb2112fa5c0e2cb94eb7d07ae2e82ef96f39aae32af0766f49db86d70a', 1786032087897);

-- >>> Migration: 0211_bright_morg.sql <<<
DROP INDEX IF EXISTS "tool_connections_company_name_uq";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('9e0a9fb9f4a1da0321224c964ed50f758851cee9a319963922235fa4cf9484f9', 1786129601533);

-- >>> Migration: 0212_onboarding_first_task_unique.sql <<<
CREATE UNIQUE INDEX IF NOT EXISTS "issues_onboarding_first_task_uq"
  ON "issues" USING btree ("company_id")
  WHERE "origin_kind" = 'onboarding_first_task';


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('016152f3a185fb344b3fe4c9ffa9bfb8e67964ab10ea519f1cfb8547587a5fb2', 1786388759523);

-- >>> Migration: 0213_complete_mystique.sql <<<
CREATE TABLE "company_transfer_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"direction" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"actor_key" text NOT NULL,
	"container_ref" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"manifest_sha256" text,
	"manifest" jsonb,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"blob_count" integer DEFAULT 0 NOT NULL,
	"completed_parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "company_transfer_runs" ADD CONSTRAINT "company_transfer_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "company_transfer_runs_company_idx" ON "company_transfer_runs" USING btree ("company_id");
CREATE INDEX "company_transfer_runs_idempotency_direction_idx" ON "company_transfer_runs" USING btree ("idempotency_key","direction");
CREATE INDEX "company_transfer_runs_actor_status_idx" ON "company_transfer_runs" USING btree ("actor_key","status");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('3fefb83013b49a03ce86539fabddfd575baa3056ec95a53da142b399d5481d54', 1786467951626);

-- >>> Migration: 0214_lively_lord_tyger.sql <<<
CREATE TABLE "adapter_auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"adapter_type" text NOT NULL,
	"started_by_user_id" text NOT NULL,
	"provider_lease_id" text,
	"status" text DEFAULT 'starting' NOT NULL,
	"expires_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "adapter_auth_sessions" ADD CONSTRAINT "adapter_auth_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "adapter_auth_sessions" ADD CONSTRAINT "adapter_auth_sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "adapter_auth_sessions_company_status_idx" ON "adapter_auth_sessions" USING btree ("company_id","status");
CREATE UNIQUE INDEX "adapter_auth_sessions_company_adapter_active_uq" ON "adapter_auth_sessions" USING btree ("company_id","adapter_type") WHERE "adapter_auth_sessions"."status" IN ('starting', 'waiting_for_user', 'promoting');
CREATE INDEX "adapter_auth_sessions_environment_idx" ON "adapter_auth_sessions" USING btree ("environment_id");
CREATE INDEX "adapter_auth_sessions_expires_idx" ON "adapter_auth_sessions" USING btree ("expires_at");
CREATE INDEX "adapter_auth_sessions_provider_lease_idx" ON "adapter_auth_sessions" USING btree ("provider_lease_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('538115776591adc9afaee310bf547c4a73fcdee8273ce0e540b3abd5ae19081f', 1786467951627);

-- >>> Migration: 0215_flat_daimon_hellstrom.sql <<<
ALTER TABLE "adapter_auth_sessions" ADD COLUMN "promotion_expires_at" timestamp with time zone;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('de83454c3ddf80aa4fb3ec2466966865980a0feba8618c6142f1c94c9290802c', 1786467951628);

-- >>> Migration: 0216_company_onboarding_seeds.sql <<<
CREATE TABLE IF NOT EXISTS "company_onboarding_seeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"revision" text NOT NULL,
	"mission" text,
	"agent_name" text,
	"agent_role" text,
	"first_task_title" text,
	"first_task_details" text,
	"goal_id" uuid,
	"agent_id" uuid,
	"issue_id" uuid,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_onboarding_seeds_company_id_companies_id_fk' AND conrelid = 'company_onboarding_seeds'::regclass) THEN
		ALTER TABLE "company_onboarding_seeds" ADD CONSTRAINT "company_onboarding_seeds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_onboarding_seeds_goal_id_goals_id_fk' AND conrelid = 'company_onboarding_seeds'::regclass) THEN
		ALTER TABLE "company_onboarding_seeds" ADD CONSTRAINT "company_onboarding_seeds_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE set null;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_onboarding_seeds_agent_id_agents_id_fk' AND conrelid = 'company_onboarding_seeds'::regclass) THEN
		ALTER TABLE "company_onboarding_seeds" ADD CONSTRAINT "company_onboarding_seeds_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE set null;
	END IF;
END $$;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_onboarding_seeds_issue_id_issues_id_fk' AND conrelid = 'company_onboarding_seeds'::regclass) THEN
		ALTER TABLE "company_onboarding_seeds" ADD CONSTRAINT "company_onboarding_seeds_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE set null;
	END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "company_onboarding_seeds_company_uq" ON "company_onboarding_seeds" ("company_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('29ab157b594c5e64f6d4563ce8aab0c352f3a6e6d079cdf99602722a033b4725', 1786467952628);

-- >>> Migration: 0217_yielding_starbolt.sql <<<
ALTER TABLE "cost_events" DROP CONSTRAINT "cost_events_issue_id_issues_id_fk";

ALTER TABLE "feedback_votes" DROP CONSTRAINT "feedback_votes_issue_id_issues_id_fk";

ALTER TABLE "finance_events" DROP CONSTRAINT "finance_events_issue_id_issues_id_fk";

ALTER TABLE "issue_comments" DROP CONSTRAINT "issue_comments_issue_id_issues_id_fk";

ALTER TABLE "issue_inbox_archives" DROP CONSTRAINT "issue_inbox_archives_issue_id_issues_id_fk";

ALTER TABLE "issue_read_states" DROP CONSTRAINT "issue_read_states_issue_id_issues_id_fk";

ALTER TABLE "issue_thread_interactions" DROP CONSTRAINT "issue_thread_interactions_issue_id_issues_id_fk";

ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_read_states" ADD CONSTRAINT "issue_read_states_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('482f59aee26225e873340d8f65c65b47324e6c08655c8040e62e1b13cfd4ab69', 1786643974972);

-- >>> Migration: 0218_mushy_jack_murdock.sql <<<
ALTER TABLE "issue_thread_interactions" ALTER COLUMN "requested_resolver_policy" SET DEFAULT 'anyone';
ALTER TABLE "issue_thread_interactions" ALTER COLUMN "effective_resolver_policy" SET DEFAULT 'anyone';
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "resolver_policy_provenance" text;
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "effective_resolver_policy_source" text;
-- Existing rows predate provenance, so their explicit-vs-default origin cannot
-- be proven. Preserve the old creator-excluding board_or_agents behavior as
-- not_creator and the old board_only behavior as human_only. This deliberately
-- avoids widening any ambiguous pending card during migration.
UPDATE "issue_thread_interactions"
SET
  "requested_resolver_policy" = CASE "requested_resolver_policy"
    WHEN 'board_or_agents' THEN 'not_creator'
    WHEN 'board_only' THEN 'human_only'
    ELSE "requested_resolver_policy"
  END,
  "effective_resolver_policy" = CASE "effective_resolver_policy"
    WHEN 'board_or_agents' THEN 'not_creator'
    WHEN 'board_only' THEN 'human_only'
    ELSE "effective_resolver_policy"
  END,
  "resolver_policy_provenance" = COALESCE(
    "resolver_policy_provenance",
    'legacy_inherited_restriction'
  ),
  "effective_resolver_policy_source" = COALESCE(
    "effective_resolver_policy_source",
    CASE
      WHEN "kind" = 'request_confirmation' AND "payload" ? 'toolAction' THEN 'governed_action'
      WHEN "effective_resolver_policy" IS DISTINCT FROM "requested_resolver_policy" THEN 'company_cap'
      ELSE 'requested'
    END
  )
WHERE "resolver_policy_provenance" IS NULL
   OR "effective_resolver_policy_source" IS NULL;
ALTER TABLE "issue_thread_interactions" ALTER COLUMN "resolver_policy_provenance" SET DEFAULT 'inherited';
ALTER TABLE "issue_thread_interactions" ALTER COLUMN "resolver_policy_provenance" SET NOT NULL;
ALTER TABLE "issue_thread_interactions" ALTER COLUMN "effective_resolver_policy_source" SET DEFAULT 'requested';
ALTER TABLE "issue_thread_interactions" ALTER COLUMN "effective_resolver_policy_source" SET NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('ce4a407efcdbbad893204f32a18d14ab4e203fe79dfbc620cb16c874f0a37d3a', 1786711898729);

-- >>> Migration: 0219_runtime_service_exposure.sql <<<
ALTER TABLE "workspace_runtime_services" ADD COLUMN "exposure" jsonb;
ALTER TABLE "workspace_runtime_services" ADD COLUMN "exposure_handle" text;
ALTER TABLE "workspace_runtime_services" ADD COLUMN "backend_url" text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2686d3163b1f56023684a0bc4e4faa61d2e16862def217e0c6bda9f72ec961a5', 1786711898730);

-- >>> Migration: 0220_execution_workspace_runtime_leases.sql <<<
CREATE TABLE "execution_workspace_runtime_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"execution_workspace_id" uuid NOT NULL,
	"owner_key" text NOT NULL,
	"owner_issue_id" uuid,
	"owner_run_id" uuid,
	"owner_agent_id" uuid,
	"last_action" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_workspace_runtime_leases_execution_workspace_id_unique" UNIQUE("execution_workspace_id")
);

ALTER TABLE "execution_workspace_runtime_leases" ADD CONSTRAINT "execution_workspace_runtime_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "execution_workspace_runtime_leases" ADD CONSTRAINT "execution_workspace_runtime_leases_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "execution_workspace_runtime_leases" ADD CONSTRAINT "execution_workspace_runtime_leases_owner_issue_id_issues_id_fk" FOREIGN KEY ("owner_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "execution_workspace_runtime_leases" ADD CONSTRAINT "execution_workspace_runtime_leases_owner_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("owner_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "execution_workspace_runtime_leases" ADD CONSTRAINT "execution_workspace_runtime_leases_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "execution_workspace_runtime_leases_company_workspace_idx" ON "execution_workspace_runtime_leases" USING btree ("company_id","execution_workspace_id");
CREATE INDEX "execution_workspace_runtime_leases_company_owner_idx" ON "execution_workspace_runtime_leases" USING btree ("company_id","owner_key");
CREATE INDEX "execution_workspace_runtime_leases_expires_at_idx" ON "execution_workspace_runtime_leases" USING btree ("expires_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('28810008a1fef6f0b615d8789b8ac3cb1d9cf95a43462cf524f5670f990921ba', 1786711898731);

-- >>> Migration: 0221_swift_justin_hammer.sql <<<
CREATE TABLE "claude_setup_token_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"adapter_type" text NOT NULL,
	"environment_id" uuid NOT NULL,
	"lease_id" text,
	"state" text DEFAULT 'starting' NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"bound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "claude_setup_token_sessions" ADD CONSTRAINT "claude_setup_token_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "claude_setup_token_sessions" ADD CONSTRAINT "claude_setup_token_sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "claude_setup_token_sessions_active_uq" ON "claude_setup_token_sessions" USING btree ("company_id","owner_user_id","adapter_type","environment_id") WHERE "claude_setup_token_sessions"."state" IN ('starting', 'awaiting_code', 'submitting', 'persisting');
CREATE UNIQUE INDEX "claude_setup_token_sessions_session_id_uq" ON "claude_setup_token_sessions" USING btree ("session_id");
CREATE INDEX "claude_setup_token_sessions_deadline_idx" ON "claude_setup_token_sessions" USING btree ("deadline_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('8e232efb846d6701968929b48b6f425b9984944f6834324685bf97d0af24fcfa', 1786983881320);

-- >>> Migration: 0222_orphan_cleanup_env_reference_survives_delete.sql <<<
ALTER TABLE "environment_leases" DROP CONSTRAINT "environment_leases_environment_id_environments_id_fk";

ALTER TABLE "environment_leases" ALTER COLUMN "environment_id" DROP NOT NULL;
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('ccc8400fe923adb0aa29240718a00d92ca83a93a9d34ea5c376881479f61ef41', 1786983999395);

-- >>> Migration: 0223_robust_zaladane.sql <<<
ALTER TABLE "company_secret_proposals" ADD COLUMN IF NOT EXISTS "interaction_id" uuid;
DO $$ BEGIN
 ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "company_secret_proposals_interaction_idx" ON "company_secret_proposals" USING btree ("interaction_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('087d251ba5dce091f616334ad09e9ae671343b71267b8ed8c67d375e9270f775', 1787000753489);

-- >>> Migration: 0224_unified_adapter_auth_sessions.sql <<<
-- Extend "adapter_auth_sessions" to hold both login flows. The migration adds
-- the public session id and the claim marker, and it re-scopes the active
-- credential slot to company + owner + adapter. The migration copies no rows
-- from "claude_setup_token_sessions"; that table stays in place for a later drop.
--
-- NOT NULL on a live table: "public_session_id" is a new non-null column with no
-- default, and "adapter_auth_sessions" can hold rows when the migration runs. The
-- rows are short-lived login sessions, and the board excluded deploy-window
-- support, so the migration deletes the existing rows instead of a backfill of a
-- generated value. A dropped login session re-starts on the next request. The
-- table stays small because the reaper removes finished rows, so the one-time
-- full delete is safe.
DELETE FROM "adapter_auth_sessions";
ALTER TABLE "adapter_auth_sessions" ADD COLUMN "public_session_id" varchar(128) NOT NULL;
ALTER TABLE "adapter_auth_sessions" ADD COLUMN "bound_at" timestamp with time zone;
DROP INDEX "adapter_auth_sessions_company_adapter_active_uq";
CREATE UNIQUE INDEX "adapter_auth_sessions_company_owner_adapter_active_uq" ON "adapter_auth_sessions" USING btree ("company_id","started_by_user_id","adapter_type") WHERE "adapter_auth_sessions"."status" IN ('starting', 'waiting_for_user', 'promoting', 'awaiting_code', 'submitting');
CREATE UNIQUE INDEX "adapter_auth_sessions_public_session_id_uq" ON "adapter_auth_sessions" USING btree ("public_session_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e8532803be13d72e7ffa79e9b7ec404b1d9fc496767ab096047cf668bc938b72', 1787000754489);

-- >>> Migration: 0225_drop_claude_setup_token_sessions.sql <<<
-- Drop the old Claude setup-token table. The unified "adapter_auth_sessions"
-- table now holds the Claude setup-token store for both login flows, so the
-- old table has no reader. Migration 0224 moved the columns and the active-slot
-- index onto "adapter_auth_sessions"; this migration removes the dead table.
DROP TABLE IF EXISTS "claude_setup_token_sessions";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('0af947705e2eb8c3bcba38f769cd1b68d59d635eaf1f8efb67d7d7c0bd6f2a55', 1787101144413);

-- >>> Migration: 0226_tan_colossus.sql <<<
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. This release introduces the disposition-repair key namespace, so deployed databases have no matching rows before this required atomic-deduplication index is added.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_disposition_repair_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'issue_disposition_repair:%' AND "agent_wakeup_requests"."status" <> 'skipped';


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('5ce422f128e4f31d73c478611c0d5b281032fac05a0d51460006d506c2eeb844', 1787261199301);

-- >>> Migration: 0227_modern_pandemic.sql <<<
CREATE TABLE IF NOT EXISTS "completion_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"schema_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"risk" text NOT NULL,
	"completion_authority" text NOT NULL,
	"incomplete_criteria_policy" text NOT NULL,
	"contract_json" jsonb NOT NULL,
	"canonical_sha256" text NOT NULL,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_contract_id" uuid
);

CREATE TABLE IF NOT EXISTS "native_run_finalizations" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"result_id" uuid,
	"assessment_id" uuid,
	"decision_id" uuid,
	"failure_code" text,
	"failure_detail" jsonb,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "native_run_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"turn_id" text,
	"completion_contract_id" uuid NOT NULL,
	"caller_result_id" text,
	"caller_dedupe_key" text,
	"server_fingerprint" text NOT NULL,
	"schema_status" text NOT NULL,
	"rejection_code" text,
	"result_json" jsonb NOT NULL,
	"canonical_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "status_decision_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"effect_kind" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"delivery_state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "status_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"decision_version" bigint NOT NULL,
	"policy_version" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"reason_code" text NOT NULL,
	"decision_json" jsonb NOT NULL,
	"decision_digest" text NOT NULL,
	"application_state" text DEFAULT 'proposed' NOT NULL,
	"supersedes_decision_id" uuid,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "work_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"turn_id" text,
	"contract_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"trigger_kind" text NOT NULL,
	"trigger_ref" text,
	"trigger_capability" text,
	"trigger_actor_company_id" uuid NOT NULL,
	"prior_issue_status" text NOT NULL,
	"prior_status_version" bigint NOT NULL,
	"prior_decision_id" uuid,
	"policy_version" text NOT NULL,
	"assessment_json" jsonb NOT NULL,
	"input_digest" text NOT NULL,
	"supersedes_assessment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "heartbeat_run_events" ALTER COLUMN "seq" SET DATA TYPE bigint;
ALTER TABLE "heartbeat_run_events" ADD COLUMN IF NOT EXISTS "source_instance_id" text;
ALTER TABLE "heartbeat_run_events" ADD COLUMN IF NOT EXISTS "source_event_id" text;
ALTER TABLE "heartbeat_run_events" ADD COLUMN IF NOT EXISTS "source_seq" bigint;
ALTER TABLE "heartbeat_run_events" ADD COLUMN IF NOT EXISTS "source_payload_sha256" text;
ALTER TABLE "heartbeat_run_events" ADD COLUMN IF NOT EXISTS "protocol_schema_version" integer;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "runtime_mode" text DEFAULT 'legacy' NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "runtime_mode_resolver_version" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "runtime_mode_reason" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "runtime_mode_resolved_at" timestamp with time zone;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "runner_profile_json" jsonb;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "runner_instance_id" uuid;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "native_session_id" uuid;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "native_issue_id" uuid;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "driver_kind" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "driver_version" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "completion_contract_id" uuid;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "completion_contract_sha256" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "next_event_seq" bigint DEFAULT 1 NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "native_phase" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "native_phase_updated_at" timestamp with time zone;
ALTER TABLE "status_decisions" ADD COLUMN IF NOT EXISTS "run_id" uuid;
ALTER TABLE "status_decisions" ALTER COLUMN "run_id" SET NOT NULL;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "status_version" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "last_status_decision_id" uuid;
UPDATE "heartbeat_runs" AS run
SET "next_event_seq" = COALESCE((
	SELECT max(event."seq") + 1
	FROM "heartbeat_run_events" AS event
	WHERE event."run_id" = run."id"
), 1);
CREATE OR REPLACE FUNCTION paperclip_bump_issue_status_version()
RETURNS trigger AS $$
BEGIN
	IF NEW."status" IS DISTINCT FROM OLD."status" THEN
		NEW."status_version" := OLD."status_version" + 1;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS paperclip_issue_status_version_trigger ON "issues";
CREATE TRIGGER paperclip_issue_status_version_trigger
BEFORE UPDATE OF "status" ON "issues"
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_status_version();
DO $$ BEGIN
	ALTER TABLE "completion_contracts" ADD CONSTRAINT "completion_contracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "completion_contracts" ADD CONSTRAINT "completion_contracts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_result_id_native_run_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."native_run_results"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_completion_contract_id_completion_contracts_id_fk" FOREIGN KEY ("completion_contract_id") REFERENCES "public"."completion_contracts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "status_decision_effects" ADD CONSTRAINT "status_decision_effects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "status_decision_effects" ADD CONSTRAINT "status_decision_effects_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "status_decision_effects" ADD CONSTRAINT "status_decision_effects_decision_id_status_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."status_decisions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_assessment_id_work_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."work_assessments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_contract_id_completion_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."completion_contracts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_result_id_native_run_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."native_run_results"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_trigger_actor_company_id_companies_id_fk" FOREIGN KEY ("trigger_actor_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "completion_contracts_issue_revision_uq" ON "completion_contracts" USING btree ("issue_id","revision");
CREATE UNIQUE INDEX IF NOT EXISTS "completion_contracts_issue_hash_uq" ON "completion_contracts" USING btree ("issue_id","canonical_sha256");
CREATE UNIQUE INDEX IF NOT EXISTS "native_run_results_run_fingerprint_uq" ON "native_run_results" USING btree ("run_id","server_fingerprint");
CREATE UNIQUE INDEX IF NOT EXISTS "native_run_results_run_caller_result_uq" ON "native_run_results" USING btree ("run_id","caller_result_id");
CREATE UNIQUE INDEX IF NOT EXISTS "native_run_results_run_caller_dedupe_uq" ON "native_run_results" USING btree ("run_id","caller_dedupe_key");
CREATE UNIQUE INDEX IF NOT EXISTS "status_decision_effects_decision_ordinal_uq" ON "status_decision_effects" USING btree ("decision_id","ordinal");
CREATE UNIQUE INDEX IF NOT EXISTS "status_decision_effects_company_idempotency_uq" ON "status_decision_effects" USING btree ("company_id","idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "status_decisions_company_issue_version_uq" ON "status_decisions" USING btree ("company_id","issue_id","decision_version");
CREATE UNIQUE INDEX IF NOT EXISTS "status_decisions_company_assessment_uq" ON "status_decisions" USING btree ("company_id","assessment_id");
CREATE UNIQUE INDEX IF NOT EXISTS "status_decisions_company_issue_digest_uq" ON "status_decisions" USING btree ("company_id","issue_id","decision_digest");
CREATE UNIQUE INDEX IF NOT EXISTS "work_assessments_company_issue_input_uq" ON "work_assessments" USING btree ("company_id","issue_id","input_digest");
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: nullable native source IDs mean historical rows need no backfill and the invariant must commit atomically with the new columns.
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_run_events_run_source_event_uq" ON "heartbeat_run_events" USING btree ("run_id","source_event_id") WHERE "heartbeat_run_events"."source_event_id" is not null;
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: nullable native source sequence fields mean historical rows need no backfill and the invariant must commit atomically with the new columns.
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_run_events_run_source_seq_uq" ON "heartbeat_run_events" USING btree ("run_id","source_instance_id","source_seq") WHERE "heartbeat_run_events"."source_instance_id" is not null and "heartbeat_run_events"."source_seq" is not null;

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the primary key already makes this ownership tuple unique; this supporting index only enables composite foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS "issues_company_id_uq" ON "issues" USING btree ("company_id","id");
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the primary key already makes this ownership tuple unique; this supporting index only enables composite foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_runs_company_native_issue_id_uq" ON "heartbeat_runs" USING btree ("company_id","native_issue_id","id");
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the primary key already makes this ownership tuple unique; this supporting index only enables composite foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_runs_company_native_issue_contract_id_uq" ON "heartbeat_runs" USING btree ("company_id","native_issue_id","id","completion_contract_id");
CREATE UNIQUE INDEX IF NOT EXISTS "completion_contracts_company_issue_id_uq" ON "completion_contracts" USING btree ("company_id","issue_id","id");
CREATE UNIQUE INDEX IF NOT EXISTS "native_run_results_company_issue_run_id_uq" ON "native_run_results" USING btree ("company_id","issue_id","run_id","id");
CREATE UNIQUE INDEX IF NOT EXISTS "work_assessments_company_issue_run_id_uq" ON "work_assessments" USING btree ("company_id","issue_id","run_id","id");
CREATE UNIQUE INDEX IF NOT EXISTS "status_decisions_company_issue_id_uq" ON "status_decisions" USING btree ("company_id","issue_id","id");
CREATE UNIQUE INDEX IF NOT EXISTS "status_decisions_company_issue_run_assessment_id_uq" ON "status_decisions" USING btree ("company_id","issue_id","run_id","assessment_id","id");
DO $$ BEGIN
	ALTER TABLE "completion_contracts" ADD CONSTRAINT "completion_contracts_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "completion_contracts" ADD CONSTRAINT "completion_contracts_supersedes_owner_fk" FOREIGN KEY ("company_id","issue_id","supersedes_contract_id") REFERENCES "public"."completion_contracts"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_run_contract_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","completion_contract_id") REFERENCES "public"."heartbeat_runs"("company_id","native_issue_id","id","completion_contract_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_completion_contract_owner_fk" FOREIGN KEY ("company_id","issue_id","completion_contract_id") REFERENCES "public"."completion_contracts"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_run_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","native_issue_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_contract_owner_fk" FOREIGN KEY ("company_id","issue_id","contract_id") REFERENCES "public"."completion_contracts"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_result_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","result_id") REFERENCES "public"."native_run_results"("company_id","issue_id","run_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_supersedes_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","supersedes_assessment_id") REFERENCES "public"."work_assessments"("company_id","issue_id","run_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_assessment_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","assessment_id") REFERENCES "public"."work_assessments"("company_id","issue_id","run_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_supersedes_owner_fk" FOREIGN KEY ("company_id","issue_id","supersedes_decision_id") REFERENCES "public"."status_decisions"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "status_decision_effects" ADD CONSTRAINT "status_decision_effects_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "status_decision_effects" ADD CONSTRAINT "status_decision_effects_decision_owner_fk" FOREIGN KEY ("company_id","issue_id","decision_id") REFERENCES "public"."status_decisions"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_run_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","native_issue_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_result_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","result_id") REFERENCES "public"."native_run_results"("company_id","issue_id","run_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_assessment_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","assessment_id") REFERENCES "public"."work_assessments"("company_id","issue_id","run_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_decision_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","assessment_id","decision_id") REFERENCES "public"."status_decisions"("company_id","issue_id","run_id","assessment_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_assessment_requires_result_check" CHECK ("assessment_id" is null or "result_id" is not null);
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_decision_requires_assessment_check" CHECK ("decision_id" is null or "assessment_id" is not null);
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_trigger_actor_company_check" CHECK ("trigger_actor_company_id" = "company_id");
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f3249811ae1d464eb84699b03e0fc7744166b16957e72294fcf8770ba22cf194', 1787668790923);

-- >>> Migration: 0228_nasty_grim_reaper.sql <<<
CREATE TABLE IF NOT EXISTS "issue_question_response_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"source_run_id" uuid,
	"target_run_id" uuid,
	"target_turn_id" text,
	"correlation_id" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivery_mode" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_question_response_deliveries_status_check" CHECK ("issue_question_response_deliveries"."status" IN ('pending', 'delivering', 'delivered', 'fallback_queued', 'failed')),
	CONSTRAINT "issue_question_response_deliveries_mode_check" CHECK ("issue_question_response_deliveries"."delivery_mode" IS NULL OR "issue_question_response_deliveries"."delivery_mode" IN ('steered', 'coalesced', 'wake_fallback'))
);

DO $$ BEGIN
 ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_target_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("target_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "issue_question_response_deliveries_interaction_uq" ON "issue_question_response_deliveries" USING btree ("interaction_id");
CREATE UNIQUE INDEX IF NOT EXISTS "issue_question_response_deliveries_correlation_uq" ON "issue_question_response_deliveries" USING btree ("correlation_id");
CREATE INDEX IF NOT EXISTS "issue_question_response_deliveries_pending_idx" ON "issue_question_response_deliveries" USING btree ("status","created_at");
CREATE INDEX IF NOT EXISTS "issue_question_response_deliveries_company_issue_idx" ON "issue_question_response_deliveries" USING btree ("company_id","issue_id","created_at");
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: This partial index covers a new question-response key prefix, so existing deployments have no matching rows; Drizzle applies migrations transactionally and cannot use CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_question_response_delivery_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'question-response:%' AND "agent_wakeup_requests"."status" NOT IN ('skipped', 'failed', 'cancelled');


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('6a6005ea7e35c5e28d10fe71388127fc26e77cf41c7fd679559028041fe43cc4', 1787837657366);

-- >>> Migration: 0229_drop_company_brand_color_and_attachment_max_bytes.sql <<<
-- Drop the two retired per-company settings. "brand_color" only tinted the
-- generated company icon, which now always derives its hue from the company
-- name, and "attachment_max_bytes" duplicated the deployment-level
-- PAPERCLIP_ATTACHMENT_MAX_BYTES cap that already bounds every upload. Both
-- columns lost their last reader when the settings were removed.
ALTER TABLE "companies" DROP COLUMN IF EXISTS "attachment_max_bytes";
ALTER TABLE "companies" DROP COLUMN IF EXISTS "brand_color";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('3ff5a85e012973bb05afa8cef6e8c50e8698d68e06a5644695cb4a22405b92d1', 1787854369379);

-- >>> Migration: 0230_better_auth_account_issuer.sql <<<
-- Better Auth 1.7 added a required "issuer" field to its `account` model: the
-- account namespace that pairs with "account_id" as the stable provider-side
-- key. Sign-up writes it, sign-in matches on it, and the Drizzle adapter
-- rejects the whole table when the column is missing.
--
-- The column has to land NOT NULL, but an upgraded deployment already has
-- rows, so backfill every one of them before the constraint goes on. The
-- values mirror Better Auth's own issuer helpers: `local:credential` for
-- email/password accounts (createLocalAccountIssuer) and
-- `local:oauth:<provider_id>` for social accounts that do not declare an
-- issuer of their own (createOAuthAccountIssuer). Paperclip only enables
-- email/password today, so in practice every existing row takes the first
-- branch; the second keeps the backfill total rather than leaving a NULL
-- behind that would abort the SET NOT NULL.
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text;
UPDATE "account"
SET "issuer" = CASE
  WHEN "provider_id" = 'credential' THEN 'local:credential'
  ELSE 'local:oauth:' || "provider_id"
END
WHERE "issuer" IS NULL;
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_account_id_uq" ON "account" USING btree ("issuer","account_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('25ac749aeac47191ad33b7404fd612cff1272bd0e3f78a13195e7a33f6b7257e', 1787880484952);

-- >>> Migration: 0231_remove_app_connection_wide_includes.sql <<<
DELETE FROM "tool_profile_entries" AS "entry"
USING "tool_profiles" AS "profile"
WHERE "entry"."profile_id" = "profile"."id"
  AND "entry"."company_id" = "profile"."company_id"
  AND "entry"."selector_type" = 'connection'
  AND "entry"."effect" = 'include'
  AND "entry"."connection_id" IS NOT NULL
  AND "profile"."profile_key" = 'app:' || "entry"."connection_id"::text
  AND "profile"."metadata" ->> 'source' IN ('app_gallery_finish', 'tool_connection_install')
  AND "profile"."metadata" ->> 'connectionId' = "entry"."connection_id"::text;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e3b537d5592580ee119aaf6957ad1f7c89bb5ad573924e9f38b4558a2e2e99db', 1787922567272);

-- >>> Migration: 0232_fixed_hannibal_king.sql <<<
CREATE TABLE IF NOT EXISTS "connection_grant_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_grant_members_subject_type_check" CHECK ("connection_grant_members"."subject_type" in ('user'))
);

ALTER TABLE "connection_grant_members" DROP CONSTRAINT IF EXISTS "connection_grant_members_company_grant_fk";
ALTER TABLE "connection_grant_members" DROP CONSTRAINT IF EXISTS "connection_grant_members_grant_id_connection_grants_id_fk";
ALTER TABLE "connection_grant_members" DROP CONSTRAINT IF EXISTS "connection_grant_members_company_id_companies_id_fk";
ALTER TABLE "connection_grants" DROP CONSTRAINT IF EXISTS "connection_grants_kind_check";
ALTER TABLE "connection_grants" DROP CONSTRAINT IF EXISTS "connection_grants_subject_check";
ALTER TABLE "connection_grants" DROP CONSTRAINT IF EXISTS "connection_grants_default_check";
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_credential_policy_check";
DROP INDEX IF EXISTS "connection_grants_default_uq";
UPDATE "connection_grants" SET "kind" = 'organization' WHERE "kind" = 'workspace';
INSERT INTO "connection_grants" (
	"company_id", "connection_id", "kind", "credential_secret_refs", "status", "is_default",
	"created_by_agent_id", "created_by_user_id", "created_at", "updated_at"
)
SELECT
	c."company_id", c."id", 'organization', c."credential_secret_refs", 'active', true,
	c."created_by_agent_id", c."created_by_user_id", c."created_at", c."updated_at"
FROM "tool_connections" c
WHERE NOT EXISTS (
	SELECT 1 FROM "connection_grants" g
	WHERE g."connection_id" = c."id" AND g."is_default" = true
);
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "credential_policy" text DEFAULT 'shared' NOT NULL;
ALTER TABLE "connection_grant_members" ADD CONSTRAINT "connection_grant_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'connection_grants_company_id_uq'
			AND conrelid = 'connection_grants'::regclass
	) THEN
		ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_company_id_uq" UNIQUE("company_id","id");
	END IF;
END $$;
ALTER TABLE "connection_grant_members" ADD CONSTRAINT "connection_grant_members_company_grant_fk" FOREIGN KEY ("company_id","grant_id") REFERENCES "public"."connection_grants"("company_id","id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX IF NOT EXISTS "connection_grant_members_company_subject_idx" ON "connection_grant_members" USING btree ("company_id","subject_type","subject_id");
CREATE UNIQUE INDEX IF NOT EXISTS "connection_grant_members_grant_subject_uq" ON "connection_grant_members" USING btree ("grant_id","subject_type","subject_id");
CREATE UNIQUE INDEX IF NOT EXISTS "connection_grants_default_uq" ON "connection_grants" USING btree ("connection_id") WHERE "connection_grants"."is_default" = true and "connection_grants"."kind" = 'organization';
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_kind_check" CHECK ("connection_grants"."kind" in ('organization', 'user'));
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_subject_check" CHECK (("connection_grants"."kind" = 'user' and "connection_grants"."subject_user_id" is not null) or ("connection_grants"."kind" = 'organization' and "connection_grants"."subject_user_id" is null));
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_default_check" CHECK ("connection_grants"."is_default" = false or "connection_grants"."kind" = 'organization');
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_credential_policy_check" CHECK ("tool_connections"."credential_policy" in ('shared', 'per_user', 'per_user_with_fallback'));

ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "addressee_user_id" text;
CREATE INDEX IF NOT EXISTS "issue_thread_interactions_addressee_user_idx" ON "issue_thread_interactions" USING btree ("addressee_user_id");

CREATE TABLE IF NOT EXISTS "connection_grant_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "connection_grant_delegations" DROP CONSTRAINT IF EXISTS "connection_grant_delegations_company_id_companies_id_fk";

ALTER TABLE "connection_grant_delegations" ADD CONSTRAINT "connection_grant_delegations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "connection_grant_delegations" DROP CONSTRAINT IF EXISTS "connection_grant_delegations_agent_id_agents_id_fk";

ALTER TABLE "connection_grant_delegations" ADD CONSTRAINT "connection_grant_delegations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "connection_grant_delegations" DROP CONSTRAINT IF EXISTS "connection_grant_delegations_company_grant_fk";

ALTER TABLE "connection_grant_delegations" ADD CONSTRAINT "connection_grant_delegations_company_grant_fk" FOREIGN KEY ("company_id","grant_id") REFERENCES "public"."connection_grants"("company_id","id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX IF NOT EXISTS "connection_grant_delegations_company_agent_idx" ON "connection_grant_delegations" USING btree ("company_id","agent_id");
CREATE UNIQUE INDEX IF NOT EXISTS "connection_grant_delegations_grant_agent_uq" ON "connection_grant_delegations" USING btree ("grant_id","agent_id");

-- A legacy company-scoped credential can only become user-scoped when exactly
-- one personal owner references it and no organization grant, connection, or
-- company binding also references it. Ambiguous rows fail closed in-place:
-- remove only personal-grant references and require those users to
-- reauthorize. Organization grants, shared/fallback connections, company
-- bindings, and routine triggers keep the original company-scoped secret so
-- their existing consumers continue to resolve it. Connection rows also keep
-- direct references: policy-aware resolution ignores them for strict per-user
-- access, while stripping them would break an independent shared consumer.
DROP TABLE IF EXISTS "phase4_ambiguous_personal_secrets";

CREATE TEMP TABLE "phase4_ambiguous_personal_secrets" ON COMMIT DROP AS
WITH personal_secret_owners AS (
	SELECT
		s."id" AS "secret_id",
		s."company_id",
		count(DISTINCT g."subject_user_id") AS "owner_count"
	FROM "company_secrets" s
	JOIN "connection_grants" g
		ON g."company_id" = s."company_id"
		AND g."kind" = 'user'
	CROSS JOIN LATERAL jsonb_array_elements(g."credential_secret_refs") personal_ref
	WHERE s."scope" = 'company'
		AND s."id"::text = personal_ref ->> 'secretId'
	GROUP BY s."id", s."company_id"
)
	SELECT owners."secret_id", owners."company_id"
	FROM personal_secret_owners owners
	WHERE owners."owner_count" <> 1
		OR EXISTS (
			SELECT 1
			FROM "connection_grants" organization_grant
			CROSS JOIN LATERAL jsonb_array_elements(organization_grant."credential_secret_refs") organization_ref
			WHERE organization_grant."company_id" = owners."company_id"
				AND organization_grant."kind" <> 'user'
				AND organization_ref ->> 'secretId' = owners."secret_id"::text
		)
			OR EXISTS (
				SELECT 1
				FROM "tool_connections" connection
			CROSS JOIN LATERAL jsonb_array_elements(connection."credential_secret_refs") connection_ref
			WHERE connection."company_id" = owners."company_id"
					AND connection_ref ->> 'secretId' = owners."secret_id"::text
			)
			OR EXISTS (
				SELECT 1
				FROM "company_secret_bindings" binding
				WHERE binding."company_id" = owners."company_id"
					AND binding."secret_id" = owners."secret_id"
			)
			OR EXISTS (
				SELECT 1
				FROM "routine_triggers" routine_trigger
				WHERE routine_trigger."company_id" = owners."company_id"
					AND routine_trigger."secret_id" = owners."secret_id"
			);

WITH ambiguous_secrets AS (
	SELECT "secret_id", "company_id" FROM "phase4_ambiguous_personal_secrets"
)
UPDATE "connection_grants" grant_row
SET
	"credential_secret_refs" = COALESCE((
		SELECT jsonb_agg(ref)
		FROM jsonb_array_elements(grant_row."credential_secret_refs") ref
		WHERE NOT EXISTS (
			SELECT 1
			FROM ambiguous_secrets ambiguous
			WHERE ambiguous."company_id" = grant_row."company_id"
				AND ref ->> 'secretId' = ambiguous."secret_id"::text
		)
	), '[]'::jsonb),
	"status" = 'needs_reauthorization',
	"is_default" = false,
	"updated_at" = now()
WHERE grant_row."kind" = 'user'
	AND EXISTS (
	SELECT 1
	FROM jsonb_array_elements(grant_row."credential_secret_refs") ref
	JOIN ambiguous_secrets ambiguous
		ON ambiguous."company_id" = grant_row."company_id"
		AND ref ->> 'secretId' = ambiguous."secret_id"::text
);

DROP TABLE IF EXISTS "phase4_ambiguous_personal_secrets";

INSERT INTO "user_secret_definitions" (
	"company_id", "key", "name", "description", "provider", "managed_mode",
	"provider_config_id", "provider_metadata", "created_by_agent_id", "created_by_user_id"
)
SELECT DISTINCT
	s."company_id",
	'tool_oauth.' || s."id"::text,
	s."name",
	'Personal connection credential migrated to user scope.',
	s."provider",
	s."managed_mode",
	s."provider_config_id",
	s."provider_metadata",
	s."created_by_agent_id",
	s."created_by_user_id"
FROM "company_secrets" s
JOIN "connection_grants" g ON g."company_id" = s."company_id" AND g."kind" = 'user'
CROSS JOIN LATERAL jsonb_array_elements(g."credential_secret_refs") ref
WHERE s."id"::text = ref ->> 'secretId'
	AND s."scope" = 'company'
ON CONFLICT DO NOTHING;

UPDATE "company_secrets" s
SET
	"scope" = 'user',
	"owner_user_id" = owner_map."owner_user_id",
	"user_secret_definition_id" = d."id",
	"updated_at" = now()
FROM (
	SELECT s2."id" AS "secret_id", min(g."subject_user_id") AS "owner_user_id"
	FROM "company_secrets" s2
	JOIN "connection_grants" g ON g."company_id" = s2."company_id" AND g."kind" = 'user'
	CROSS JOIN LATERAL jsonb_array_elements(g."credential_secret_refs") ref
	WHERE s2."id"::text = ref ->> 'secretId' AND s2."scope" = 'company'
	GROUP BY s2."id"
	HAVING count(DISTINCT g."subject_user_id") = 1
) owner_map
JOIN "user_secret_definitions" d ON d."key" = 'tool_oauth.' || owner_map."secret_id"::text AND d."deleted_at" IS NULL
WHERE s."id" = owner_map."secret_id" AND d."company_id" = s."company_id";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('24105c1cdd63a2e66c07242ead92f8b4309e8b1a79b31745b238de311f73c297', 1787922607497);

-- >>> Migration: 0233_living_dreaming_celestial.sql <<<
ALTER TABLE "connection_grants" ADD COLUMN IF NOT EXISTS "external_credential" jsonb;
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "credential_source" text DEFAULT 'paperclip_vault' NOT NULL;
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "external_credential" jsonb;
ALTER TABLE "connection_grants" DROP CONSTRAINT IF EXISTS "connection_grants_credential_source_one_of_check";
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_credential_source_one_of_check" CHECK ("connection_grants"."external_credential" is null or jsonb_array_length("connection_grants"."credential_secret_refs") = 0);
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_credential_source_check";
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_credential_source_check" CHECK ("tool_connections"."credential_source" in ('paperclip_vault', 'vercel_connect'));
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_credential_source_one_of_check";
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_credential_source_one_of_check" CHECK ((
      ("tool_connections"."credential_source" = 'paperclip_vault' and "tool_connections"."external_credential" is null)
      or
      ("tool_connections"."credential_source" = 'vercel_connect' and "tool_connections"."external_credential" is not null and jsonb_array_length("tool_connections"."credential_refs") = 0 and jsonb_array_length("tool_connections"."credential_secret_refs") = 0)
    ));


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e40eb1d1010de116738b61aba2ebf4b6d652d62763fbb5c22062790414eee86a', 1787922658738);

-- >>> Migration: 0234_provider_trace_records.sql <<<
CREATE TABLE IF NOT EXISTS "provider_trace_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"status" text DEFAULT 'capturing' NOT NULL,
	"provider" text NOT NULL,
	"trace_ref" text NOT NULL,
	"frame_count" integer DEFAULT 0 NOT NULL,
	"byte_count" bigint DEFAULT 0 NOT NULL,
	"digest" text,
	"reason" text,
	"requested_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "provider_trace_records" ADD CONSTRAINT "provider_trace_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "provider_trace_records" ADD CONSTRAINT "provider_trace_records_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "provider_trace_records_run_unique" ON "provider_trace_records" USING btree ("run_id");
CREATE INDEX IF NOT EXISTS "provider_trace_records_expiry_idx" ON "provider_trace_records" USING btree ("status","expires_at");
CREATE INDEX IF NOT EXISTS "provider_trace_records_company_created_idx" ON "provider_trace_records" USING btree ("company_id","created_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('09490d8922846dfa762d60d3465bdccfb57c0cf42ce1823647ea8b2e4b18d9a4', 1788184090416);

-- >>> Migration: 0235_heartbeat_run_event_sequence_uniqueness.sql <<<
WITH ranked AS (
	SELECT
		"id",
		"run_id",
		"seq",
		row_number() OVER (PARTITION BY "run_id", "seq" ORDER BY "id") AS duplicate_ordinal,
		max("seq") OVER (PARTITION BY "run_id") AS max_seq
	FROM "heartbeat_run_events"
), duplicates AS (
	SELECT
		"id",
		max_seq + row_number() OVER (PARTITION BY "run_id" ORDER BY "seq", "id") AS repaired_seq
	FROM ranked
	WHERE duplicate_ordinal > 1
)
UPDATE "heartbeat_run_events" AS event
SET "seq" = duplicates.repaired_seq
FROM duplicates
WHERE event."id" = duplicates."id";
UPDATE "heartbeat_runs" AS run
SET "next_event_seq" = COALESCE((
	SELECT max(event."seq") + 1
	FROM "heartbeat_run_events" AS event
	WHERE event."run_id" = run."id"
), 1);
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. The duplicate repair and uniqueness invariant must commit atomically before native event writers rely on the sequence key.
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_run_events_run_seq_uq" ON "heartbeat_run_events" USING btree ("run_id","seq");
DROP INDEX IF EXISTS "heartbeat_run_events_run_seq_idx";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('cd0605597778b0f6e44667bf3b5a1e033c5cf73fa888ecf1a2a91a5e49689fc1', 1788198788171);

-- >>> Migration: 0236_remove_cheap_model_profiles.sql <<<
CREATE INDEX IF NOT EXISTS "agents_remove_model_profiles_idx"
	ON "agents" USING btree ("id")
	WHERE "runtime_config" ? 'modelProfiles';

DO $$
DECLARE
	updated_count integer;
BEGIN
	LOOP
		WITH batch AS MATERIALIZED (
			SELECT "id"
			FROM "agents"
			WHERE "runtime_config" ? 'modelProfiles'
			ORDER BY "id"
			LIMIT 1000
		)
		UPDATE "agents" AS agent
		SET "runtime_config" = agent."runtime_config" - 'modelProfiles',
			"updated_at" = now()
		FROM batch
		WHERE agent."id" = batch."id";

		GET DIAGNOSTICS updated_count = ROW_COUNT;
		EXIT WHEN updated_count = 0;
	END LOOP;
END $$;

DROP INDEX IF EXISTS "agents_remove_model_profiles_idx";

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: This temporary partial index covers only revision snapshots with the retired JSON key and is dropped after the bounded cleanup.
CREATE INDEX IF NOT EXISTS "agent_config_revisions_remove_model_profiles_idx"
	ON "agent_config_revisions" USING btree ("id")
	WHERE ("before_config" #> '{runtimeConfig}') ? 'modelProfiles'
		OR ("after_config" #> '{runtimeConfig}') ? 'modelProfiles';

DO $$
DECLARE
	updated_count integer;
BEGIN
	LOOP
		WITH batch AS MATERIALIZED (
			SELECT "id"
			FROM "agent_config_revisions"
			WHERE ("before_config" #> '{runtimeConfig}') ? 'modelProfiles'
				OR ("after_config" #> '{runtimeConfig}') ? 'modelProfiles'
			ORDER BY "id"
			LIMIT 1000
		)
		UPDATE "agent_config_revisions" AS revision
		SET "before_config" = CASE
				WHEN (revision."before_config" #> '{runtimeConfig}') ? 'modelProfiles'
				THEN jsonb_set(
					revision."before_config",
					'{runtimeConfig}',
					(revision."before_config" #> '{runtimeConfig}') - 'modelProfiles'
				)
				ELSE revision."before_config"
			END,
			"after_config" = CASE
				WHEN (revision."after_config" #> '{runtimeConfig}') ? 'modelProfiles'
				THEN jsonb_set(
					revision."after_config",
					'{runtimeConfig}',
					(revision."after_config" #> '{runtimeConfig}') - 'modelProfiles'
				)
				ELSE revision."after_config"
			END
		FROM batch
		WHERE revision."id" = batch."id";

		GET DIAGNOSTICS updated_count = ROW_COUNT;
		EXIT WHEN updated_count = 0;
	END LOOP;
END $$;

DROP INDEX IF EXISTS "agent_config_revisions_remove_model_profiles_idx";

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: This temporary partial index covers only rows with the retired JSON key and is dropped after the bounded cleanup.
CREATE INDEX IF NOT EXISTS "issues_remove_model_profile_idx"
	ON "issues" USING btree ("id")
	WHERE "assignee_adapter_overrides" ? 'modelProfile';

DO $$
DECLARE
	updated_count integer;
BEGIN
	LOOP
		WITH batch AS MATERIALIZED (
			SELECT "id"
			FROM "issues"
			WHERE "assignee_adapter_overrides" ? 'modelProfile'
			ORDER BY "id"
			LIMIT 1000
		)
		UPDATE "issues" AS issue
		SET "assignee_adapter_overrides" = NULLIF(
			issue."assignee_adapter_overrides" - 'modelProfile',
			'{}'::jsonb
		)
		FROM batch
		WHERE issue."id" = batch."id";

		GET DIAGNOSTICS updated_count = ROW_COUNT;
		EXIT WHEN updated_count = 0;
	END LOOP;
END $$;

DROP INDEX IF EXISTS "issues_remove_model_profile_idx";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('b0d67c3f7305a366952f1a5a84be0fceabe822a29193b241e68456d660a45ffe', 1788283761224);

-- >>> Migration: 0237_clammy_colonel_america.sql <<<
CREATE TABLE "managed_agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"profile_key" text NOT NULL,
	"display_name" text NOT NULL,
	"service" text DEFAULT 'anthropic_managed_agents' NOT NULL,
	"anthropic_agent_id" text NOT NULL,
	"agent_version" text NOT NULL,
	"environment_id" text NOT NULL,
	"beta_version" text DEFAULT 'managed-agents-2026-04-01' NOT NULL,
	"default_model" text DEFAULT 'claude-sonnet-5' NOT NULL,
	"default_max_list_cost_cents" integer DEFAULT 100 NOT NULL,
	"api_key_secret_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"retention_acknowledged" boolean DEFAULT false NOT NULL,
	"qualification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"qualified_at" timestamp with time zone,
	"qualified_revision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_agent_profiles_service_check" CHECK ("managed_agent_profiles"."service" = 'anthropic_managed_agents'),
	CONSTRAINT "managed_agent_profiles_beta_check" CHECK ("managed_agent_profiles"."beta_version" = 'managed-agents-2026-04-01'),
	CONSTRAINT "managed_agent_profiles_positive_budget_check" CHECK ("managed_agent_profiles"."default_max_list_cost_cents" > 0),
	CONSTRAINT "managed_agent_profiles_qualified_revision_check" CHECK (("managed_agent_profiles"."qualified_at" IS NULL AND "managed_agent_profiles"."qualified_revision" IS NULL) OR ("managed_agent_profiles"."qualified_at" IS NOT NULL AND "managed_agent_profiles"."qualification" <> '{}'::jsonb AND "managed_agent_profiles"."qualified_revision" ~ '^sha256:[0-9a-f]{64}$'))
);

CREATE TABLE "remote_agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"profile_key" text NOT NULL,
	"display_name" text NOT NULL,
	"service" text NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"retention_acknowledged" boolean DEFAULT false NOT NULL,
	"qualification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"qualified_at" timestamp with time zone,
	"qualified_revision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remote_agent_profiles_service_check" CHECK ("remote_agent_profiles"."service" = 'aws_bedrock_agentcore_harness'),
	CONSTRAINT "remote_agent_profiles_qualified_revision_check" CHECK (("remote_agent_profiles"."qualified_at" IS NULL AND "remote_agent_profiles"."qualified_revision" IS NULL) OR ("remote_agent_profiles"."qualified_at" IS NOT NULL AND "remote_agent_profiles"."qualification" <> '{}'::jsonb AND "remote_agent_profiles"."qualified_revision" ~ '^sha256:[0-9a-f]{64}$'))
);

ALTER TABLE "managed_agent_profiles" ADD CONSTRAINT "managed_agent_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "managed_agent_profiles" ADD CONSTRAINT "managed_agent_profiles_api_key_secret_id_company_secrets_id_fk" FOREIGN KEY ("api_key_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "remote_agent_profiles" ADD CONSTRAINT "remote_agent_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "managed_agent_profiles_company_idx" ON "managed_agent_profiles" USING btree ("company_id");
CREATE UNIQUE INDEX "managed_agent_profiles_company_key_uq" ON "managed_agent_profiles" USING btree ("company_id","profile_key");
CREATE UNIQUE INDEX "managed_agent_profiles_company_resource_uq" ON "managed_agent_profiles" USING btree ("company_id","anthropic_agent_id","agent_version","environment_id");
CREATE INDEX "remote_agent_profiles_company_idx" ON "remote_agent_profiles" USING btree ("company_id");
CREATE UNIQUE INDEX "remote_agent_profiles_company_key_uq" ON "remote_agent_profiles" USING btree ("company_id","profile_key");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2292cae4f2bd3bd8e364506f83b4149e316683c94500c5da3fb021f50bb0d78e', 1788296836732);

-- >>> Migration: 0238_graceful_infant_terrible.sql <<<
ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "controller_boot_id" text;
ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "controller_pid" integer;
ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "controller_process_started_at" timestamp with time zone;
ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "controller_generation" integer DEFAULT 0 NOT NULL;
ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "recovery_state" text;
ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "recovery_request_id" text;
ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "recovery_history" jsonb DEFAULT '[]'::jsonb NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('d949769206d8c2a55a88d2fcd6753eda42bd0cde3c82e01c32a71a40da6bea10', 1788542862021);

-- >>> Migration: 0239_sturdy_santa_claus.sql <<<
CREATE TABLE IF NOT EXISTS "connection_event_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"installation_id" text,
	"repository_id" text,
	"normalized_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"provider_created_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "connection_grants" DROP CONSTRAINT IF EXISTS "connection_grants_kind_check";
ALTER TABLE "connection_grants" DROP CONSTRAINT IF EXISTS "connection_grants_subject_check";
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_credential_policy_check";
ALTER TABLE "connection_grants" ADD COLUMN IF NOT EXISTS "subject_agent_id" uuid;
ALTER TABLE "tool_oauth_states" ADD COLUMN IF NOT EXISTS "subject_agent_id" uuid;
ALTER TABLE "connection_event_deliveries" DROP CONSTRAINT IF EXISTS "connection_event_deliveries_company_id_companies_id_fk";
ALTER TABLE "connection_event_deliveries" ADD CONSTRAINT "connection_event_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX IF NOT EXISTS "connection_event_deliveries_company_provider_id_uq" ON "connection_event_deliveries" USING btree ("company_id","provider","provider_delivery_id");
CREATE INDEX IF NOT EXISTS "connection_event_deliveries_company_status_idx" ON "connection_event_deliveries" USING btree ("company_id","status","created_at");
ALTER TABLE "connection_grants" DROP CONSTRAINT IF EXISTS "connection_grants_subject_agent_id_agents_id_fk";
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_subject_agent_id_agents_id_fk" FOREIGN KEY ("subject_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "tool_oauth_states" DROP CONSTRAINT IF EXISTS "tool_oauth_states_subject_agent_id_agents_id_fk";
ALTER TABLE "tool_oauth_states" ADD CONSTRAINT "tool_oauth_states_subject_agent_id_agents_id_fk" FOREIGN KEY ("subject_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX IF NOT EXISTS "connection_grants_subject_agent_idx" ON "connection_grants" USING btree ("company_id","subject_agent_id");
CREATE UNIQUE INDEX IF NOT EXISTS "connection_grants_agent_uq" ON "connection_grants" USING btree ("connection_id","subject_agent_id");
CREATE INDEX IF NOT EXISTS "tool_oauth_states_subject_agent_idx" ON "tool_oauth_states" USING btree ("company_id","subject_agent_id");
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_kind_check" CHECK ("connection_grants"."kind" in ('organization', 'user', 'agent'));
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_subject_check" CHECK (("connection_grants"."kind" = 'user' and "connection_grants"."subject_user_id" is not null and "connection_grants"."subject_agent_id" is null) or ("connection_grants"."kind" = 'agent' and "connection_grants"."subject_agent_id" is not null and "connection_grants"."subject_user_id" is null) or ("connection_grants"."kind" = 'organization' and "connection_grants"."subject_user_id" is null and "connection_grants"."subject_agent_id" is null));
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_credential_policy_check" CHECK ("tool_connections"."credential_policy" in ('shared', 'per_user', 'per_user_with_fallback', 'per_agent'));


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('a6cd20235469e92a74ea4cc0b9b87c4f6b3344dbd7de1bcba2278a3aab9986d7', 1788557575279);

-- >>> Migration: 0240_pink_fantastic_four.sql <<<
CREATE TABLE IF NOT EXISTS "run_identity_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"responsible_user_id" text,
	"message_id" uuid,
	"parent_context_id" uuid,
	"cause" text NOT NULL,
	"correlation_id" text NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"accepted_at" timestamp with time zone,
	"github" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "active_identity_context_id" uuid;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'run_identity_contexts_company_id_companies_id_fk' AND conrelid = 'public.run_identity_contexts'::regclass) THEN
  ALTER TABLE "run_identity_contexts" ADD CONSTRAINT "run_identity_contexts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "run_identity_contexts_run_revision_idx" ON "run_identity_contexts" USING btree ("run_id","revision");
CREATE UNIQUE INDEX IF NOT EXISTS "run_identity_contexts_run_correlation_idx" ON "run_identity_contexts" USING btree ("run_id","correlation_id");
CREATE INDEX IF NOT EXISTS "run_identity_contexts_company_run_idx" ON "run_identity_contexts" USING btree ("company_id","run_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('5a8fd8e0476e1b842777a480a68cda842b3590d9811a35f0c327052f35e195f9', 1788796987307);

-- >>> Migration: 0241_conscious_adam_destine.sql <<<
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "origin_identity_context_id" uuid;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2e618736d7e1f8837eb7a20c109718c77445a7be04a7533c5d1a1251a713aff7', 1788797555060);

-- >>> Migration: 0242_wide_lightspeed.sql <<<
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "source_identity_context_id" uuid;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('319b6cff78be30dac8dc732e2bec9c38c0d1bee8d1b7c4e04b874d09252c6ceb', 1788798139203);

-- >>> Migration: 0243_sleepy_metal_master.sql <<<
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "continuation_identity_context_id" uuid;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('bb3d1210638a19fec6b03db0e9abbb6944d117e3c15030eaec264dee53c902a2', 1788798652047);

-- >>> Migration: 0244_organic_meltdown.sql <<<
ALTER TABLE "run_identity_contexts" DROP CONSTRAINT IF EXISTS "run_identity_contexts_run_id_heartbeat_runs_id_fk";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('235bbaac7bc78dcd6f6401f2b447f649dce59e1ad719616de49b93f6c78ac66b', 1788804288225);

-- >>> Migration: 0245_misty_nightshade.sql <<<
ALTER TABLE "run_identity_contexts" DROP CONSTRAINT IF EXISTS "run_identity_contexts_company_id_companies_id_fk";

ALTER TABLE "run_identity_contexts" ADD CONSTRAINT "run_identity_contexts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('c7f3ebb2fcf524a81c94021c2144edacbb30888c288dcd032dbeb1f673bcfa10', 1788804969749);

-- >>> Migration: 0246_nostalgic_medusa.sql <<<
CREATE TABLE IF NOT EXISTS "connection_intent_deliveries" (
	"interaction_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connection_intent_deliveries_interaction_id_issue_thread_interactions_id_fk'::name AND conrelid = 'public.connection_intent_deliveries'::regclass) THEN
    ALTER TABLE "connection_intent_deliveries" ADD CONSTRAINT "connection_intent_deliveries_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connection_intent_deliveries_company_id_companies_id_fk'::name AND conrelid = 'public.connection_intent_deliveries'::regclass) THEN
    ALTER TABLE "connection_intent_deliveries" ADD CONSTRAINT "connection_intent_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "connection_intent_deliveries_pending_idx" ON "connection_intent_deliveries" USING btree ("delivered_at","next_attempt_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e1342e9fc55650a133101e798f146d3480475d578986abd6a34fb971102205d9', 1788812039026);

-- >>> Migration: 0247_even_moon_knight.sql <<<
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: The migration runner wraps each migration in a transaction, so CONCURRENTLY is unavailable. This narrow partial index enforces crash-safe connection outcome delivery. Deploying on large instances requires a maintenance window for the initial table scan.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_connection_intent_delivery_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'connection-intent:%' AND "agent_wakeup_requests"."status" NOT IN ('skipped', 'failed', 'cancelled');


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('aca5ecf048a5fa648385a1c90ef2aead92e66110c3644c7c149d9c643bc3f8e8', 1788812507973);

-- >>> Migration: 0248_small_manta.sql <<<
-- Preview checkouts used earlier migration numbers; retain their goal state.
CREATE TABLE IF NOT EXISTS "agent_session_goal_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"action" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result_json" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_capability_json" jsonb;
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_json" jsonb;
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_status" text;
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_desired_state" text;
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_source_id" text;
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_source_cursor" bigint;
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_revision" integer DEFAULT 0 NOT NULL;
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_observed_at" timestamp with time zone;
DO $$ BEGIN
  ALTER TABLE "agent_session_goal_actions" ADD CONSTRAINT "agent_session_goal_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "agent_session_goal_actions" ADD CONSTRAINT "agent_session_goal_actions_session_id_agent_task_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_task_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "agent_session_goal_actions_session_request_uniq" ON "agent_session_goal_actions" USING btree ("session_id","request_id");
CREATE INDEX IF NOT EXISTS "agent_session_goal_actions_company_status_created_idx" ON "agent_session_goal_actions" USING btree ("company_id","status","created_at");
CREATE INDEX IF NOT EXISTS "agent_session_goal_actions_session_created_idx" ON "agent_session_goal_actions" USING btree ("session_id","created_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('172c65356515db02b12b7d7d1c2c249b1e648bf49476bedbf39d33d331d885dc', 1788901245075);

-- >>> Migration: 0249_fast_silverclaw.sql <<<
-- Idempotent for workspaces that applied the pre-rebase review migrations.
CREATE TABLE IF NOT EXISTS "tool_action_deliveries" (
	"action_request_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_deliveries_action_request_id_tool_action_requests_id_fk' AND conrelid = 'public.tool_action_deliveries'::regclass) THEN
    ALTER TABLE "tool_action_deliveries" ADD CONSTRAINT "tool_action_deliveries_action_request_id_tool_action_requests_id_fk" FOREIGN KEY ("action_request_id") REFERENCES "public"."tool_action_requests"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_deliveries_company_id_companies_id_fk' AND conrelid = 'public.tool_action_deliveries'::regclass) THEN
    ALTER TABLE "tool_action_deliveries" ADD CONSTRAINT "tool_action_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_deliveries_issue_id_issues_id_fk' AND conrelid = 'public.tool_action_deliveries'::regclass) THEN
    ALTER TABLE "tool_action_deliveries" ADD CONSTRAINT "tool_action_deliveries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_deliveries_interaction_id_issue_thread_interactions_id_fk' AND conrelid = 'public.tool_action_deliveries'::regclass) THEN
    ALTER TABLE "tool_action_deliveries" ADD CONSTRAINT "tool_action_deliveries_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "tool_action_deliveries_pending_idx" ON "tool_action_deliveries" USING btree ("delivered_at","created_at");
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Transactional migrations require the unique delivery claim before writers start. This new key namespace has no rows, but index construction can briefly block wakeup writes.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_tool_action_delivery_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'tool-action-response:%' AND "agent_wakeup_requests"."status" NOT IN ('skipped', 'failed', 'cancelled');

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('df0d8f6781b6f68f8c6ee160238cd99e1db1348a625e094213f919ae43b466be', 1788904803082);

-- >>> Migration: 0250_exotic_dakota_north.sql <<<
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "origin_comment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "control_deadline_at" timestamp with time zone;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('838055a201358d82443eabf410435aa73481de221867133771db36614b8e7c16', 1788904803083);

-- >>> Migration: 0251_narrow_mastermind.sql <<<
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_runs_native_replacement_predecessor_uq" ON "heartbeat_runs" USING btree ("company_id","retry_of_run_id") WHERE "heartbeat_runs"."scheduled_retry_reason" = 'native_safe_replacement';

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f08a1ec2ed049672608f1285c2708cf9f0e2d9744015dc3a7e748c1ad683caf8', 1788904803084);

-- >>> Migration: 0252_friendly_kate_bishop.sql <<<
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "execution_control_deadline_at" timestamp with time zone;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('1953d4fb106d9c2edbf9a542a82950ef347000dc32deadc72e5cff3d9f1fbe64', 1788904803085);

-- >>> Migration: 0253_real_firebrand.sql <<<
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "execution_status_delivery_id" uuid;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('479c645e86403b630b6ee7764261a3cad28be47666ef0f254d09999316152317', 1788906513181);

-- >>> Migration: 0254_military_calypso.sql <<<
CREATE INDEX IF NOT EXISTS "heartbeat_runs_execution_status_delivery_idx" ON "heartbeat_runs" USING btree ("execution_status_delivery_id") WHERE "heartbeat_runs"."execution_status_delivery_id" is not null;
CREATE INDEX IF NOT EXISTS "heartbeat_runs_execution_control_deadline_idx" ON "heartbeat_runs" USING btree ("execution_control_deadline_at") WHERE "heartbeat_runs"."execution_control_deadline_at" is not null;
CREATE INDEX IF NOT EXISTS "native_run_finalizations_control_deadline_idx" ON "native_run_finalizations" USING btree ("control_deadline_at") WHERE "native_run_finalizations"."control_deadline_at" is not null;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('1a17ff0a22caf90caf817e93b4ee270ca119b82b8ff41b2662454584a357209f', 1788906545648);

-- >>> Migration: 0255_previous_captain_america.sql <<<
CREATE TABLE "chat_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"delivery_id" uuid,
	"conversation_id" uuid,
	"principal_id" uuid,
	"kind" text NOT NULL,
	"provider_action_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "chat_agent_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_endpoint_id" uuid NOT NULL,
	"destination_endpoint_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"trigger_mode" text DEFAULT 'explicit_mention' NOT NULL,
	"max_hops" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_agent_routes_hops_check" CHECK ("chat_agent_routes"."max_hops" between 1 and 8)
);

CREATE TABLE "chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"resource_id" uuid,
	"issue_id" uuid NOT NULL,
	"external_conversation_id" text NOT NULL,
	"external_thread_id" text DEFAULT '' NOT NULL,
	"external_label" text NOT NULL,
	"provider_url" text,
	"is_direct_message" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_conversations_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "chat_conversations_state_check" CHECK ("chat_conversations"."state" in ('active', 'waiting', 'completed', 'unavailable', 'endpoint_removed'))
);

CREATE TABLE "chat_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"conversation_id" uuid,
	"principal_id" uuid,
	"provider_event_id" text NOT NULL,
	"deduplication_key" text NOT NULL,
	"event_kind" text NOT NULL,
	"normalized_event" jsonb NOT NULL,
	"state" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"redacted_error" text,
	"next_attempt_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_deliveries_state_check" CHECK ("chat_deliveries"."state" in ('received', 'filtered', 'processing', 'processed', 'retry', 'failed'))
);

CREATE TABLE "chat_endpoint_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"lease_key" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "chat_endpoint_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider_resource_id" text NOT NULL,
	"parent_provider_resource_id" text,
	"label" text NOT NULL,
	"detail" text,
	"provider_url" text,
	"availability" text DEFAULT 'available' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_endpoint_resources_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "chat_endpoint_resources_availability_check" CHECK ("chat_endpoint_resources"."availability" in ('available', 'unavailable', 'removed'))
);

CREATE TABLE "chat_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"public_id" text NOT NULL,
	"assigned_agent_id" uuid NOT NULL,
	"sponsor_user_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"deployment_mode" text DEFAULT 'direct' NOT NULL,
	"provider_account_id" text,
	"provider_account_label" text,
	"bot_external_id" text,
	"bot_username" text,
	"bot_display_name" text,
	"bot_avatar_url" text,
	"allow_direct_messages" boolean DEFAULT true NOT NULL,
	"allow_group_chats" boolean DEFAULT true NOT NULL,
	"allow_unlinked_people" boolean DEFAULT true NOT NULL,
	"concurrency_policy" text DEFAULT 'queue' NOT NULL,
	"capabilities" jsonb DEFAULT '{"threads":false,"directMessages":false,"nativeStreaming":false,"messageEdits":false,"messageDeletes":false,"reactions":false,"files":false,"cards":false,"actions":false,"modals":false,"slashCommands":false,"ephemeralMessages":false,"proactiveDirectMessages":false}'::jsonb NOT NULL,
	"setup" jsonb DEFAULT '{"step":"provider_setup"}'::jsonb NOT NULL,
	"health_message" text,
	"last_event_at" timestamp with time zone,
	"last_publication_at" timestamp with time zone,
	"last_error" text,
	"activated_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_endpoints_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "chat_endpoints_provider_check" CHECK ("chat_endpoints"."provider" in ('slack', 'github', 'microsoft-teams', 'telegram')),
	CONSTRAINT "chat_endpoints_status_check" CHECK ("chat_endpoints"."status" in ('draft', 'verifying', 'active', 'paused', 'attention', 'revoked', 'archived')),
	CONSTRAINT "chat_endpoints_deployment_check" CHECK ("chat_endpoints"."deployment_mode" in ('direct', 'relay')),
	CONSTRAINT "chat_endpoints_concurrency_check" CHECK ("chat_endpoints"."concurrency_policy" in ('burst', 'queue', 'debounce', 'drop', 'concurrent'))
);

CREATE TABLE "chat_external_principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text DEFAULT 'user' NOT NULL,
	"display_name" text,
	"handle" text,
	"avatar_url" text,
	"is_bot" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_external_principals_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "chat_external_principals_provider_check" CHECK ("chat_external_principals"."provider" in ('slack', 'github', 'microsoft-teams', 'telegram')),
	CONSTRAINT "chat_external_principals_kind_check" CHECK ("chat_external_principals"."kind" in ('user', 'bot', 'app', 'system'))
);

CREATE TABLE "chat_identity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"paperclip_user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirmation_token_hash" text,
	"expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_identity_links_status_check" CHECK ("chat_identity_links"."status" in ('pending', 'linked', 'revoked', 'expired'))
);

CREATE TABLE "chat_message_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"delivery_id" uuid,
	"publication_id" uuid,
	"comment_id" uuid,
	"provider_message_id" text NOT NULL,
	"direction" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_links_direction_check" CHECK ("chat_message_links"."direction" in ('inbound', 'outbound'))
);

CREATE TABLE "chat_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"comment_id" uuid,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"provider_url" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"redacted_error" text,
	"next_attempt_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_publications_state_check" CHECK ("chat_publications"."state" in ('pending', 'streaming', 'published', 'retry', 'failed', 'cancelled'))
);

CREATE TABLE "chat_sdk_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"state_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_transport_check";
ALTER TABLE "tool_connections" ADD COLUMN "connection_purpose" text DEFAULT 'tool' NOT NULL;
ALTER TABLE "chat_actions" ADD CONSTRAINT "chat_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_actions" ADD CONSTRAINT "chat_actions_delivery_id_chat_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."chat_deliveries"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "chat_actions" ADD CONSTRAINT "chat_actions_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_agent_routes" ADD CONSTRAINT "chat_agent_routes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_agent_routes" ADD CONSTRAINT "chat_agent_routes_company_source_fk" FOREIGN KEY ("company_id","source_endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_agent_routes" ADD CONSTRAINT "chat_agent_routes_company_destination_fk" FOREIGN KEY ("company_id","destination_endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_company_resource_fk" FOREIGN KEY ("company_id","resource_id") REFERENCES "public"."chat_endpoint_resources"("company_id","id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_company_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_company_principal_fk" FOREIGN KEY ("company_id","principal_id") REFERENCES "public"."chat_external_principals"("company_id","id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "chat_endpoint_leases" ADD CONSTRAINT "chat_endpoint_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_endpoint_leases" ADD CONSTRAINT "chat_endpoint_leases_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_endpoint_resources" ADD CONSTRAINT "chat_endpoint_resources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_endpoint_resources" ADD CONSTRAINT "chat_endpoint_resources_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_company_connection_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."tool_connections"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_external_principals" ADD CONSTRAINT "chat_external_principals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_identity_links" ADD CONSTRAINT "chat_identity_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_identity_links" ADD CONSTRAINT "chat_identity_links_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_identity_links" ADD CONSTRAINT "chat_identity_links_company_principal_fk" FOREIGN KEY ("company_id","principal_id") REFERENCES "public"."chat_external_principals"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_delivery_id_chat_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."chat_deliveries"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_publication_id_chat_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."chat_publications"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_company_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_company_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_sdk_state" ADD CONSTRAINT "chat_sdk_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_sdk_state" ADD CONSTRAINT "chat_sdk_state_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "chat_actions_provider_action_uq" ON "chat_actions" USING btree ("endpoint_id","provider_action_id");
CREATE UNIQUE INDEX "chat_agent_routes_pair_uq" ON "chat_agent_routes" USING btree ("source_endpoint_id","destination_endpoint_id");
CREATE INDEX "chat_conversations_issue_idx" ON "chat_conversations" USING btree ("company_id","issue_id");
CREATE UNIQUE INDEX "chat_conversations_thread_uq" ON "chat_conversations" USING btree ("endpoint_id","external_conversation_id","external_thread_id");
CREATE INDEX "chat_deliveries_work_idx" ON "chat_deliveries" USING btree ("state","next_attempt_at");
CREATE UNIQUE INDEX "chat_deliveries_event_uq" ON "chat_deliveries" USING btree ("endpoint_id","provider_event_id");
CREATE UNIQUE INDEX "chat_deliveries_dedupe_uq" ON "chat_deliveries" USING btree ("endpoint_id","deduplication_key");
CREATE UNIQUE INDEX "chat_endpoint_leases_active_uq" ON "chat_endpoint_leases" USING btree ("endpoint_id","lease_key");
CREATE INDEX "chat_endpoint_leases_expiry_idx" ON "chat_endpoint_leases" USING btree ("expires_at");
CREATE INDEX "chat_endpoint_resources_endpoint_idx" ON "chat_endpoint_resources" USING btree ("company_id","endpoint_id");
CREATE UNIQUE INDEX "chat_endpoint_resources_external_uq" ON "chat_endpoint_resources" USING btree ("endpoint_id","type","provider_resource_id");
CREATE INDEX "chat_endpoints_company_idx" ON "chat_endpoints" USING btree ("company_id");
CREATE INDEX "chat_endpoints_agent_idx" ON "chat_endpoints" USING btree ("company_id","assigned_agent_id");
CREATE INDEX "chat_endpoints_status_idx" ON "chat_endpoints" USING btree ("company_id","status");
CREATE UNIQUE INDEX "chat_endpoints_public_id_uq" ON "chat_endpoints" USING btree ("public_id");
CREATE UNIQUE INDEX "chat_endpoints_connection_uq" ON "chat_endpoints" USING btree ("connection_id");
CREATE INDEX "chat_external_principals_company_idx" ON "chat_external_principals" USING btree ("company_id");
CREATE UNIQUE INDEX "chat_external_principals_external_uq" ON "chat_external_principals" USING btree ("company_id","provider","provider_account_id","external_id");
CREATE INDEX "chat_identity_links_user_idx" ON "chat_identity_links" USING btree ("company_id","paperclip_user_id");
CREATE UNIQUE INDEX "chat_identity_links_endpoint_principal_uq" ON "chat_identity_links" USING btree ("endpoint_id","principal_id");
CREATE UNIQUE INDEX "chat_message_links_provider_message_uq" ON "chat_message_links" USING btree ("endpoint_id","provider_message_id");
CREATE INDEX "chat_publications_work_idx" ON "chat_publications" USING btree ("state","next_attempt_at");
CREATE UNIQUE INDEX "chat_publications_idempotency_uq" ON "chat_publications" USING btree ("company_id","idempotency_key");
CREATE UNIQUE INDEX "chat_sdk_state_key_uq" ON "chat_sdk_state" USING btree ("endpoint_id","state_key");
CREATE INDEX "chat_sdk_state_expiry_idx" ON "chat_sdk_state" USING btree ("expires_at");
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_purpose_check" CHECK ("tool_connections"."connection_purpose" in ('tool', 'channel'));
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_channel_transport_check" CHECK ((
      ("tool_connections"."connection_purpose" = 'tool' and "tool_connections"."transport" <> 'chat_sdk')
      or
      ("tool_connections"."connection_purpose" = 'channel' and "tool_connections"."transport" = 'chat_sdk')
    ));
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_transport_check" CHECK ("tool_connections"."transport" in ('mcp_remote', 'rest_api', 'local_stdio', 'chat_sdk'));

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2cbd1eb88d3bf4c82b72fdfd78dce72ecd7899f85607a76fb7e40b2749fffa00', 1788964999870);

-- >>> Migration: 0256_married_king_cobra.sql <<<
DROP INDEX "chat_conversations_thread_uq";
ALTER TABLE "chat_conversations" ADD COLUMN "session_generation" integer DEFAULT 1 NOT NULL;
CREATE UNIQUE INDEX "chat_conversations_thread_uq" ON "chat_conversations" USING btree ("endpoint_id","external_conversation_id","external_thread_id","session_generation");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f352a8769496412df3be35050df02110714af3a189d92b3c2ac8d097e2612c7b', 1788965003480);

-- >>> Migration: 0257_bizarre_the_hunter.sql <<<
DROP INDEX "chat_message_links_provider_message_uq";
CREATE UNIQUE INDEX "chat_endpoints_live_bot_external_uq" ON "chat_endpoints" USING btree ("provider","provider_account_id","bot_external_id") WHERE "chat_endpoints"."status" in ('verifying', 'active', 'paused', 'attention')
          and "chat_endpoints"."provider_account_id" is not null
          and "chat_endpoints"."bot_external_id" is not null;
CREATE UNIQUE INDEX "chat_endpoints_live_bot_username_uq" ON "chat_endpoints" USING btree ("provider","provider_account_id","bot_username") WHERE "chat_endpoints"."status" in ('verifying', 'active', 'paused', 'attention')
          and "chat_endpoints"."provider_account_id" is not null
          and "chat_endpoints"."bot_username" is not null;
CREATE UNIQUE INDEX "chat_message_links_provider_message_uq" ON "chat_message_links" USING btree ("endpoint_id","conversation_id","provider_message_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('4e4636a22fb06aac55a998a0c98d043ec70083c198c94a0f5e0a99f18a1debac', 1788965006905);

-- >>> Migration: 0258_typical_sauron.sql <<<
ALTER TABLE "chat_publications" DROP CONSTRAINT "chat_publications_state_check";
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_state_check" CHECK ("chat_publications"."state" in ('pending', 'streaming', 'published', 'retry', 'delivery_unknown', 'failed', 'cancelled'));

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('f3cb8b9d3bb3691d98a830c7ba8b4f49bbe9bb01ce2e899583d0b5c9b84d423c', 1788965010559);

-- >>> Migration: 0259_tan_chat.sql <<<
ALTER TABLE "chat_endpoints" ALTER COLUMN "allow_group_chats" SET DEFAULT false;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('91012c36bfcf66615b537ce808c9cb2f1311bc6efa6aab3ed8afd0d01298af75', 1788965014270);

-- >>> Migration: 0260_chat_interaction_wakeup_idempotency.sql <<<
-- The old partial index does not cover interaction:* keys, so this is
-- necessarily one prefix scan of agent_wakeup_requests. Drizzle applies the
-- migration transactionally: writers cannot observe the repair without the
-- replacement index, and the index cannot admit a new duplicate before the
-- repair commits. A temporary helper index would require the same large-table
-- scan while adding another transactional DDL lock, so the selective prefix
-- scan is the lower-lock upgrade path.
--
-- Preserve the most meaningful run-backed wake as the canonical key holder.
-- Terminal and actively executing duplicates keep their status and run link;
-- they are re-keyed outside the canonical namespace with audit metadata. Only
-- duplicate work that has not acquired a run and is safe to retire is marked
-- skipped. In particular, claimed/running work is never falsely cancelled.
WITH ranked AS (
  SELECT
    "id",
    "idempotency_key" AS "original_idempotency_key",
    "status" AS "previous_status",
    "run_id" AS "linked_run_id",
    first_value("id") OVER (
      PARTITION BY "company_id", "idempotency_key"
      ORDER BY
        CASE
          WHEN "run_id" IS NOT NULL AND "status" IN ('succeeded', 'completed', 'coalesced') THEN 0
          WHEN "run_id" IS NOT NULL AND "status" IN ('running', 'claimed') THEN 1
          WHEN "run_id" IS NOT NULL THEN 2
          WHEN "status" IN ('running', 'claimed') THEN 3
          WHEN "status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry') THEN 4
          ELSE 5
        END,
        "requested_at" ASC,
        "created_at" ASC,
        "id" ASC
    ) AS "retained_id",
    row_number() OVER (
      PARTITION BY "company_id", "idempotency_key"
      ORDER BY
        CASE
          WHEN "run_id" IS NOT NULL AND "status" IN ('succeeded', 'completed', 'coalesced') THEN 0
          WHEN "run_id" IS NOT NULL AND "status" IN ('running', 'claimed') THEN 1
          WHEN "run_id" IS NOT NULL THEN 2
          WHEN "status" IN ('running', 'claimed') THEN 3
          WHEN "status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry') THEN 4
          ELSE 5
        END,
        "requested_at" ASC,
        "created_at" ASC,
        "id" ASC
    ) AS "ordinal"
  FROM "agent_wakeup_requests"
  WHERE "idempotency_key" LIKE 'interaction:%'
    AND "status" NOT IN ('skipped', 'failed', 'cancelled')
), duplicates AS (
  SELECT * FROM ranked WHERE "ordinal" > 1
)
UPDATE "agent_wakeup_requests" AS wake
SET
  "idempotency_key" = CASE
    WHEN duplicates."linked_run_id" IS NULL
      AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
      THEN duplicates."original_idempotency_key"
    ELSE 'historical-interaction-wake-duplicate:' || wake."id"::text
  END,
  "status" = CASE
    WHEN duplicates."linked_run_id" IS NULL
      AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
      THEN 'skipped'
    ELSE wake."status"
  END,
  "finished_at" = CASE
    WHEN duplicates."linked_run_id" IS NULL
      AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
      THEN COALESCE(wake."finished_at", now())
    ELSE wake."finished_at"
  END,
  "error" = CASE
    WHEN duplicates."linked_run_id" IS NULL
      AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
      THEN concat_ws(
        E'\n',
        NULLIF(wake."error", ''),
        'Safely retired duplicate by migration 0245; retained wake request ' || duplicates."retained_id"::text
      )
    ELSE wake."error"
  END,
  "payload" = COALESCE(wake."payload", '{}'::jsonb) || jsonb_build_object(
    'migrationDedupe', jsonb_build_object(
      'migration', '0245_chat_interaction_wakeup_idempotency',
      'retainedWakeRequestId', duplicates."retained_id",
      'originalIdempotencyKey', duplicates."original_idempotency_key",
      'previousStatus', duplicates."previous_status",
      'linkedRunId', duplicates."linked_run_id",
      'resolution', CASE
        WHEN duplicates."linked_run_id" IS NULL
          AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
          THEN 'retired_unstarted_duplicate'
        ELSE 'rekeyed_preserving_execution_history'
      END
    )
  ),
  "updated_at" = now()
FROM duplicates
WHERE wake."id" = duplicates."id";
DROP INDEX IF EXISTS "agent_wakeup_requests_question_response_delivery_idempotency_uq";
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. The selective duplicate repair above preserves historical evidence and the expanded predicate must commit atomically before board and external-chat resolvers share the canonical interaction wake key.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_question_response_delivery_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE ("agent_wakeup_requests"."idempotency_key" LIKE 'question-response:%' OR "agent_wakeup_requests"."idempotency_key" LIKE 'interaction:%') AND "agent_wakeup_requests"."status" NOT IN ('skipped', 'failed', 'cancelled');


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('5e181169a724173d17865d537bd84c385e97e6f78e71aa795cad91734cd37ea0', 1788965018153);

-- >>> Migration: 0261_faulty_iceman.sql <<<
ALTER TABLE "chat_endpoints" DROP CONSTRAINT "chat_endpoints_provider_check";
ALTER TABLE "chat_external_principals" DROP CONSTRAINT "chat_external_principals_provider_check";
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_provider_check" CHECK ("chat_endpoints"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram'));
ALTER TABLE "chat_external_principals" ADD CONSTRAINT "chat_external_principals_provider_check" CHECK ("chat_external_principals"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram'));

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('dd7a7571e080471148cff98d1138ddd046e8c1e3c256fa5bc11564d5f4766c28', 1788965023236);

-- >>> Migration: 0262_lying_avengers.sql <<<
CREATE UNIQUE INDEX "chat_endpoints_live_discord_bot_external_uq" ON "chat_endpoints" USING btree ("provider","bot_external_id") WHERE "chat_endpoints"."provider" = 'discord'
          and "chat_endpoints"."status" in ('verifying', 'active', 'paused', 'attention')
          and "chat_endpoints"."bot_external_id" is not null;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('59909e4edae56117c7fe0af28aa10fe30a64d151e83fe6e06debcec90658ff09', 1788965027575);

-- >>> Migration: 0263_nebulous_iron_lad.sql <<<
CREATE UNIQUE INDEX "chat_endpoints_live_global_app_bot_external_uq" ON "chat_endpoints" USING btree ("provider","bot_external_id") WHERE "chat_endpoints"."provider" in ('github', 'microsoft-teams')
          and "chat_endpoints"."status" in ('verifying', 'active', 'paused', 'attention')
          and "chat_endpoints"."bot_external_id" is not null;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('858eb11c0863e361c1ae6995e78ca365f8002e35dcb1e89dbcc8bf65dea879e3', 1788965029603);

-- >>> Migration: 0264_cynical_hellcat.sql <<<
ALTER TABLE "issue_attachments" ADD COLUMN "originating_run_id" uuid;
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_originating_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("originating_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "issue_attachments_originating_run_idx" ON "issue_attachments" USING btree ("originating_run_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('d9aeacc58ae3c52d34bf50f8ea38f55435a6f8f66dc6ee87d3b78e105a86602a', 1788965031515);

-- >>> Migration: 0265_chat_interaction_wakeup_provenance.sql <<<
-- 0251 was originally deployed as 0245. Its SQL bytes must remain unchanged:
-- migration history recognizes that deployed repair by hash. Correct only its
-- stored provenance here, without replaying duplicate retirement or rekeying.
-- The primary-key cursor visits every row once, including unrelated-only
-- batches. Query/write batches are bounded, but locks still last until commit.
-- paperclip:migration-safety-ignore loop-mutation-large-table: Existing agent_wakeup_requests primary key supports the strictly advancing UUID cursor. Each batch selects at most 500 IDs and updates only matching IDs and exact legacy repair metadata.
-- paperclip:migration-safety-ignore batched-mutation-large-table-missing-index: Existing agent_wakeup_requests primary key supports ORDER BY id and id > last_id. No JSON predicate is used to search repeatedly for the next batch.
DO $provenance$
DECLARE
  last_id uuid;
  batch_ids uuid[];
  old_prefix constant text := 'Safely retired duplicate by migration 0245; retained wake request ';
  new_prefix constant text := 'Safely retired duplicate by migration 0251; retained wake request ';
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  LOOP
    IF last_id IS NULL THEN
      SELECT ARRAY(SELECT "id" FROM "agent_wakeup_requests" ORDER BY "id" LIMIT 500) INTO batch_ids;
    ELSE
      SELECT ARRAY(SELECT "id" FROM "agent_wakeup_requests" WHERE "id" > last_id ORDER BY "id" LIMIT 500) INTO batch_ids;
    END IF;
    EXIT WHEN cardinality(batch_ids) = 0;

    UPDATE "agent_wakeup_requests" AS wake
    SET
      "payload" = jsonb_set(
        wake."payload",
        '{migrationDedupe,migration}',
        '"0251_chat_interaction_wakeup_idempotency"'::jsonb,
        false
      ),
      "error" = CASE
        WHEN wake."payload" #>> '{migrationDedupe,resolution}' = 'retired_unstarted_duplicate'
          AND right(wake."error", length(old_prefix) + 36) = old_prefix || (wake."payload" #>> '{migrationDedupe,retainedWakeRequestId}')
          AND (
            length(wake."error") = length(old_prefix) + 36
            OR substring(wake."error" FROM length(wake."error") - length(old_prefix) - 36 FOR 1) = E'\n'
          )
          THEN left(wake."error", length(wake."error") - length(old_prefix) - 36)
            || new_prefix || (wake."payload" #>> '{migrationDedupe,retainedWakeRequestId}')
        ELSE wake."error"
      END
    WHERE wake."id" = ANY(batch_ids)
      AND jsonb_typeof(wake."payload") = 'object'
      AND jsonb_typeof(wake."payload" -> 'migrationDedupe') = 'object'
      AND wake."payload" #>> '{migrationDedupe,migration}' = '0245_chat_interaction_wakeup_idempotency'
      AND jsonb_typeof(wake."payload" #> '{migrationDedupe,retainedWakeRequestId}') = 'string'
      AND (wake."payload" #>> '{migrationDedupe,retainedWakeRequestId}') ~ uuid_pattern
      AND jsonb_typeof(wake."payload" #> '{migrationDedupe,originalIdempotencyKey}') = 'string'
      AND wake."payload" #>> '{migrationDedupe,originalIdempotencyKey}' LIKE 'interaction:%'
      AND jsonb_typeof(wake."payload" #> '{migrationDedupe,previousStatus}') = 'string'
      AND wake."payload" #>> '{migrationDedupe,previousStatus}' NOT IN ('skipped', 'failed', 'cancelled')
      AND (
        wake."payload" #> '{migrationDedupe,linkedRunId}' = 'null'::jsonb
        OR (
          jsonb_typeof(wake."payload" #> '{migrationDedupe,linkedRunId}') = 'string'
          AND (wake."payload" #>> '{migrationDedupe,linkedRunId}') ~ uuid_pattern
        )
      )
      AND (
        (
          wake."payload" #>> '{migrationDedupe,resolution}' = 'retired_unstarted_duplicate'
          AND wake."payload" #> '{migrationDedupe,linkedRunId}' = 'null'::jsonb
          AND wake."payload" #>> '{migrationDedupe,previousStatus}' IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
          AND wake."idempotency_key" = wake."payload" #>> '{migrationDedupe,originalIdempotencyKey}'
        )
        OR (
          wake."payload" #>> '{migrationDedupe,resolution}' = 'rekeyed_preserving_execution_history'
          AND NOT (
            wake."payload" #> '{migrationDedupe,linkedRunId}' = 'null'::jsonb
            AND wake."payload" #>> '{migrationDedupe,previousStatus}' IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
          )
          AND wake."idempotency_key" = 'historical-interaction-wake-duplicate:' || wake."id"::text
        )
      );

    last_id := batch_ids[cardinality(batch_ids)];
  END LOOP;
END
$provenance$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('1547e6e597b50c621691ead1d25624c4bf94ca3259cf24ea4480f3fb915dd849', 1788965033473);

-- >>> Migration: 0266_brave_living_mummy.sql <<<
CREATE TABLE "chat_teams_file_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"authorized_user_id" text,
	"runtime_generation" integer NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"conversation_generation" integer NOT NULL,
	"source_digest" text NOT NULL,
	"authority_digest" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_app_id" uuid NOT NULL,
	"aad_object_id" uuid NOT NULL,
	"provider_conversation_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"filename" text NOT NULL,
	"token_sha256" text NOT NULL,
	"phase" text DEFAULT 'consent_pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"attempt_id" uuid,
	"attempt_expires_at" timestamp with time zone,
	"consent_message_id" text,
	"file_info_message_id" text,
	"response_activity_id" text,
	"response_digest" text,
	"private_state" jsonb NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_teams_file_transfers_phase_check" CHECK ("chat_teams_file_transfers"."phase" in ('consent_pending','consent_sending','consent_unknown','awaiting_consent','upload_pending','uploading','upload_unknown','file_info_pending','file_info_sending','file_info_unknown','delivered','declined','expired','cancelled','conflict')),
	CONSTRAINT "chat_teams_file_transfers_bounds_check" CHECK ("chat_teams_file_transfers"."version" > 0 and "chat_teams_file_transfers"."runtime_generation" >= 0 and "chat_teams_file_transfers"."conversation_generation" > 0 and "chat_teams_file_transfers"."byte_size" > 0 and "chat_teams_file_transfers"."byte_size" < 62914560),
	CONSTRAINT "chat_teams_file_transfers_hash_check" CHECK ("chat_teams_file_transfers"."source_digest" ~ '^[a-f0-9]{64}$' and "chat_teams_file_transfers"."authority_digest" ~ '^[a-f0-9]{64}$' and "chat_teams_file_transfers"."sha256" ~ '^[a-f0-9]{64}$' and "chat_teams_file_transfers"."token_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "chat_teams_file_transfers_attempt_check" CHECK (("chat_teams_file_transfers"."attempt_id" is null) = ("chat_teams_file_transfers"."attempt_expires_at" is null))
);

ALTER TABLE "chat_publications" DROP CONSTRAINT "chat_publications_state_check";
CREATE UNIQUE INDEX "chat_publications_company_id_uq" ON "chat_publications" USING btree ("company_id","id");
ALTER TABLE "chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_company_id_publication_id_chat_publications_company_id_id_fk" FOREIGN KEY ("company_id","publication_id") REFERENCES "public"."chat_publications"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_company_id_conversation_id_chat_conversations_company_id_id_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_company_id_principal_id_chat_external_principals_company_id_id_fk" FOREIGN KEY ("company_id","principal_id") REFERENCES "public"."chat_external_principals"("company_id","id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "chat_teams_file_transfers_publication_uq" ON "chat_teams_file_transfers" USING btree ("company_id","publication_id");
CREATE UNIQUE INDEX "chat_teams_file_transfers_token_uq" ON "chat_teams_file_transfers" USING btree ("endpoint_id","token_sha256");
CREATE INDEX "chat_teams_file_transfers_work_idx" ON "chat_teams_file_transfers" USING btree ("phase","attempt_expires_at","expires_at");
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_state_check" CHECK ("chat_publications"."state" in ('pending', 'streaming', 'published', 'retry', 'delivery_unknown', 'failed', 'cancelled', 'awaiting_consent'));


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('7c38ccd2fa6a9bde19d62b111f892bcabae9a8eabe5f8bf438f73a407016b56a', 1788965035366);

-- >>> Migration: 0267_warm_wild_child.sql <<<
CREATE TABLE "chat_discord_command_owners" (
	"application_id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_discord_command_owners_application_check" CHECK ("chat_discord_command_owners"."application_id" ~ '^[1-9][0-9]{16,19}$')
);


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('6902ea71d481a26d6359c6c9b149ff0c8a388e65356b066b2fbaa33622a6c9b8', 1788965037225);

-- >>> Migration: 0268_lively_runaways.sql <<<
CREATE SEQUENCE "public"."chat_telegram_draft_ids" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('20ebd2ac15d9b467abcc5552901ecf592b38499942b3eae7d593c79fd89bd0a8', 1788965039217);

-- >>> Migration: 0269_fearless_young_avengers.sql <<<
-- Create referenced composite keys before the generated foreign keys.
ALTER TABLE "agents" ADD CONSTRAINT "agents_company_id_uq" UNIQUE("company_id","id");
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_company_id_uq" UNIQUE("company_id","id");
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_company_id_uq" UNIQUE("company_id","id");
ALTER TABLE "chat_actions" ADD CONSTRAINT "chat_actions_company_delivery_fk" FOREIGN KEY ("company_id","delivery_id") REFERENCES "public"."chat_deliveries"("company_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "chat_actions" ADD CONSTRAINT "chat_actions_company_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "chat_actions" ADD CONSTRAINT "chat_actions_company_principal_fk" FOREIGN KEY ("company_id","principal_id") REFERENCES "public"."chat_external_principals"("company_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_company_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_company_agent_fk" FOREIGN KEY ("company_id","assigned_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_company_delivery_fk" FOREIGN KEY ("company_id","delivery_id") REFERENCES "public"."chat_deliveries"("company_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_company_publication_fk" FOREIGN KEY ("company_id","publication_id") REFERENCES "public"."chat_publications"("company_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_company_comment_fk" FOREIGN KEY ("company_id","comment_id") REFERENCES "public"."issue_comments"("company_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_company_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_company_comment_fk" FOREIGN KEY ("company_id","comment_id") REFERENCES "public"."issue_comments"("company_id","id") ON DELETE no action ON UPDATE no action;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('aee07bbf7468bb5bfccc9de751df9287ffc2c6b4978775a3ec0366fc14111709', 1788972722287);

-- >>> Migration: 0270_harsh_queen_noir.sql <<<
ALTER TABLE "chat_conversations" DROP CONSTRAINT "chat_conversations_company_resource_fk";

ALTER TABLE "chat_deliveries" DROP CONSTRAINT "chat_deliveries_company_conversation_fk";

ALTER TABLE "chat_deliveries" DROP CONSTRAINT "chat_deliveries_company_principal_fk";

ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_resource_id_chat_endpoint_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."chat_endpoint_resources"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_company_resource_fk" FOREIGN KEY ("company_id","resource_id") REFERENCES "public"."chat_endpoint_resources"("company_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_principal_id_chat_external_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."chat_external_principals"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_company_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_company_principal_fk" FOREIGN KEY ("company_id","principal_id") REFERENCES "public"."chat_external_principals"("company_id","id") ON DELETE no action ON UPDATE no action;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('995dbb71f73e98ade062b626fea328c030539b4a3efe11f50f0ebc95e56680b8', 1788973120697);

-- >>> Migration: 0271_woozy_silver_surfer.sql <<<
ALTER TABLE "adapter_auth_sessions" ADD COLUMN "result_claim" jsonb;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('2502b1296abeeefa74fca28cf465c03c1159f27a67e2b6f945a28a67e007752f', 1788999440971);

-- >>> Migration: 0272_light_kate_bishop.sql <<<
-- Safe to replay after an interrupted or previously applied development migration.
CREATE TABLE IF NOT EXISTS "email_endpoints" (
	"endpoint_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"receive_mode" text NOT NULL,
	"webhook_id" text,
	"owned_api_key_id" text,
	"activation_at" timestamp with time zone,
	"sync_checkpoint" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	CONSTRAINT "email_endpoints_receive_mode_check" CHECK ("email_endpoints"."receive_mode" in ('websocket', 'webhook'))
);

CREATE TABLE IF NOT EXISTS "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"text" text NOT NULL,
	"full_text" text DEFAULT '' NOT NULL,
	"direction" text NOT NULL,
	"automatic" boolean DEFAULT false NOT NULL,
	"attachment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	CONSTRAINT "email_messages_direction_check" CHECK ("email_messages"."direction" in ('inbound', 'outbound'))
);

CREATE TABLE IF NOT EXISTS "email_sends" (
	"publication_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"digest" text NOT NULL,
	"outcome" text DEFAULT 'queued' NOT NULL,
	"first_attempt_at" timestamp with time zone,
	CONSTRAINT "email_sends_outcome_check" CHECK ("email_sends"."outcome" in ('queued', 'sent', 'delivered', 'failed', 'uncertain'))
);

ALTER TABLE "chat_endpoints" DROP CONSTRAINT IF EXISTS "chat_endpoints_provider_check";
ALTER TABLE "chat_external_principals" DROP CONSTRAINT IF EXISTS "chat_external_principals_provider_check";
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_channel_transport_check";
ALTER TABLE "chat_endpoints" ADD COLUMN IF NOT EXISTS "publication_mode" text DEFAULT 'automatic' NOT NULL;
ALTER TABLE "chat_endpoints" ADD COLUMN IF NOT EXISTS "external_execution_policy" text DEFAULT 'restricted' NOT NULL;
DO $$ BEGIN
  ALTER TABLE "email_endpoints" ADD CONSTRAINT "email_endpoints_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_company_id_conversation_id_chat_conversations_company_id_id_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_company_id_publication_id_chat_publications_company_id_id_fk" FOREIGN KEY ("company_id","publication_id") REFERENCES "public"."chat_publications"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "email_messages_provider_uq" ON "email_messages" USING btree ("endpoint_id","provider_message_id");
CREATE INDEX IF NOT EXISTS "email_messages_conversation_idx" ON "email_messages" USING btree ("company_id","conversation_id","timestamp");
CREATE INDEX IF NOT EXISTS "email_sends_pending_idx" ON "email_sends" USING btree ("endpoint_id","outcome") WHERE "email_sends"."outcome" in ('queued', 'uncertain');
CREATE UNIQUE INDEX IF NOT EXISTS "chat_endpoints_agentmail_inbox_uq" ON "chat_endpoints" USING btree ("bot_external_id") WHERE "chat_endpoints"."provider" = 'agentmail' and "chat_endpoints"."status" != 'archived' and "chat_endpoints"."bot_external_id" is not null;
DO $$ BEGIN
  ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_publication_mode_check" CHECK ("chat_endpoints"."publication_mode" in ('automatic', 'explicit'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_execution_policy_check" CHECK ("chat_endpoints"."external_execution_policy" in ('restricted', 'agent'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_email_policy_check" CHECK ("chat_endpoints"."provider" <> 'agentmail' or ("chat_endpoints"."publication_mode" = 'explicit' and "chat_endpoints"."external_execution_policy" = 'agent'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_provider_check" CHECK ("chat_endpoints"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'agentmail'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "chat_external_principals" ADD CONSTRAINT "chat_external_principals_provider_check" CHECK ("chat_external_principals"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'agentmail'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_channel_transport_check" CHECK ((
      ("tool_connections"."connection_purpose" = 'tool' and "tool_connections"."transport" <> 'chat_sdk')
      or
      ("tool_connections"."connection_purpose" = 'channel' and ("tool_connections"."transport" = 'chat_sdk' or ("tool_connections"."transport" = 'rest_api' and "tool_connections"."config"->>'provider' = 'agentmail')))
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('15d8b554fecc6bae31e92ad8ee1ee365a804a26039e4ac7d3682164d4630a2bf', 1789137216452);

-- >>> Migration: 0273_aromatic_moondragon.sql <<<
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "controller_boot_id" uuid;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "controller_lease_expires_at" timestamp with time zone;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "execution_stage" text;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('0f05bc766ac021e02988b98f1383d66a18c421a66f82bd164b81bee53b8d5c53', 1789164595203);

-- >>> Migration: 0274_agent_chat.sql <<<
-- Idempotent for development instances that applied the pre-release chat migrations.
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "client_request_id" text;
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "conversation_session_generation" integer;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "conversation_agent_id" uuid;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "conversation_user_id" text;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "conversation_state" text;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "conversation_session_generation" integer DEFAULT 0 NOT NULL;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "conversation_boundary_comment_id" uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issues_conversation_agent_id_agents_id_fk' AND conrelid = 'issues'::regclass) THEN
    ALTER TABLE "issues" ADD CONSTRAINT "issues_conversation_agent_id_agents_id_fk" FOREIGN KEY ("conversation_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "issues_conversation_identity_idx" ON "issues" USING btree ("company_id","conversation_agent_id","conversation_user_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_comments_client_request_uq' AND conrelid = 'issue_comments'::regclass) THEN
    ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_client_request_uq" UNIQUE("issue_id","author_user_id","client_request_id");
  END IF;
END $$;
-- The first development guard allowed NULL through SQL three-valued logic.
-- Recover the server-owned idle/active state before enforcing the stronger guard.
UPDATE "issues" SET "conversation_state" = CASE WHEN "status" = 'in_review' THEN 'waiting' ELSE 'active' END
WHERE "conversation_agent_id" IS NOT NULL AND "conversation_state" IS NULL;
ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_conversation_identity_check";
ALTER TABLE "issues" ADD CONSTRAINT "issues_conversation_identity_check" CHECK ((
      "issues"."conversation_agent_id" is null and "issues"."conversation_user_id" is null and "issues"."conversation_state" is null
    ) or (
      "issues"."conversation_agent_id" is not null and "issues"."conversation_user_id" is not null
      and "issues"."assignee_agent_id" = "issues"."conversation_agent_id" and "issues"."assignee_agent_id" is not null
      and "issues"."assignee_user_id" is null and "issues"."conversation_state" is not null
      and "issues"."conversation_state" in ('active', 'waiting')
      and "issues"."status" not in ('done', 'cancelled')
    ));


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('7903d92a79fcc2d5ef6f2af16b9eb73c149543e1d1634b608f7df223e9096bb1', 1789219070888);

-- >>> Migration: 0275_easy_dragon_man.sql <<<
ALTER TABLE "chat_endpoints" DROP CONSTRAINT IF EXISTS "chat_endpoints_provider_check";
ALTER TABLE "chat_external_principals" DROP CONSTRAINT IF EXISTS "chat_external_principals_provider_check";
CREATE UNIQUE INDEX IF NOT EXISTS "chat_endpoints_photon_number_uq" ON "chat_endpoints" USING btree ("bot_external_id") WHERE "chat_endpoints"."provider" = 'imessage-photon' and "chat_endpoints"."status" <> 'archived' and "chat_endpoints"."bot_external_id" is not null;
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_provider_check" CHECK ("chat_endpoints"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'agentmail', 'imessage-photon'));
ALTER TABLE "chat_external_principals" ADD CONSTRAINT "chat_external_principals_provider_check" CHECK ("chat_external_principals"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'agentmail', 'imessage-photon'));

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('95664021d9bb3eb19b525a3a7bd9337e42f43be501ef5533af938519a5a59de7', 1789221632037);

-- >>> Migration: 0276_hard_mandroid.sql <<<
CREATE TABLE IF NOT EXISTS "ai_connection_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"method" text NOT NULL,
	"grant_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_connection_defaults_provider_check" CHECK ("ai_connection_defaults"."provider" in ('anthropic','openai','openrouter','xai')),
	CONSTRAINT "ai_connection_defaults_method_check" CHECK ("ai_connection_defaults"."method" in ('subscription','api_key'))
);

ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_transport_check";
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_purpose_check";
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_channel_transport_check";
ALTER TABLE "adapter_auth_sessions" ADD COLUMN IF NOT EXISTS "ai_connection" jsonb;
ALTER TABLE "adapter_auth_sessions" ADD COLUMN IF NOT EXISTS "connection_id" uuid;
ALTER TABLE "adapter_auth_sessions" ADD COLUMN IF NOT EXISTS "connection_grant_id" uuid;
ALTER TABLE "adapter_auth_sessions" ADD COLUMN IF NOT EXISTS "connection_method" text;
DO $$ BEGIN ALTER TABLE "ai_connection_defaults" ADD CONSTRAINT "ai_connection_defaults_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ai_connection_defaults" ADD CONSTRAINT "ai_connection_defaults_company_grant_fk" FOREIGN KEY ("company_id","grant_id") REFERENCES "public"."connection_grants"("company_id","id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "ai_connection_defaults_owner_method_uq" ON "ai_connection_defaults" USING btree ("company_id","user_id","provider","method");
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_transport_check" CHECK ("tool_connections"."transport" in ('mcp_remote', 'rest_api', 'local_stdio', 'chat_sdk', 'runtime_auth'));
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_purpose_check" CHECK ("tool_connections"."connection_purpose" in ('tool', 'channel', 'ai'));
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_channel_transport_check" CHECK ((
      ("tool_connections"."connection_purpose" = 'tool' and "tool_connections"."transport" not in ('chat_sdk', 'runtime_auth'))
      or
      ("tool_connections"."connection_purpose" = 'channel' and ("tool_connections"."transport" = 'chat_sdk' or ("tool_connections"."transport" = 'rest_api' and "tool_connections"."config"->>'provider' = 'agentmail')))
      or
      ("tool_connections"."connection_purpose" = 'ai' and "tool_connections"."transport" = 'runtime_auth')
    ));
-- Only declared per-user credentials have reliable ownership. Host auth homes
-- and company secrets are deliberately left untouched. No agent binding changes.
DO $$
DECLARE candidate record; application_id uuid; connection_id uuid; grant_id uuid;
BEGIN
  FOR candidate IN
    SELECT DISTINCT s.id AS secret_id, s.company_id, s.owner_user_id, s.user_secret_definition_id,
      s.name, s.created_at, a.id AS agent_id,
      CASE d.env_key WHEN 'ANTHROPIC_API_KEY' THEN 'anthropic' WHEN 'CLAUDE_CODE_OAUTH_TOKEN' THEN 'anthropic'
        WHEN 'OPENAI_API_KEY' THEN 'openai' WHEN 'OPENROUTER_API_KEY' THEN 'openrouter' WHEN 'XAI_API_KEY' THEN 'xai' END AS provider,
      CASE WHEN d.env_key = 'CLAUDE_CODE_OAUTH_TOKEN' THEN 'subscription' ELSE 'api_key' END AS method
    FROM company_secrets s
    JOIN user_secret_declarations d ON d.company_id = s.company_id AND d.user_secret_definition_id = s.user_secret_definition_id
    JOIN agents a ON a.company_id = s.company_id AND a.id::text = d.target_id AND d.target_type = 'agent'
    WHERE s.scope = 'user' AND s.owner_user_id IS NOT NULL AND s.status = 'active' AND s.deleted_at IS NULL
      AND ((a.adapter_type = 'claude_local' AND d.env_key IN ('ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'))
        OR (a.adapter_type = 'codex_local' AND d.env_key = 'OPENAI_API_KEY')
        OR (a.adapter_type = 'opencode_local' AND d.env_key = 'OPENROUTER_API_KEY')
        OR (a.adapter_type = 'grok_local' AND d.env_key = 'XAI_API_KEY'))
    ORDER BY s.created_at
  LOOP
    connection_id := overlay(overlay(md5('ai-connection:' || candidate.secret_id::text || ':' || candidate.provider || ':' || candidate.method) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid;
    grant_id := overlay(overlay(md5('ai-grant:' || connection_id::text) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid;
    INSERT INTO tool_applications(company_id,application_key,name,type,owner_user_id,metadata)
      VALUES(candidate.company_id,'app-gallery:' || candidate.provider,
        CASE candidate.provider WHEN 'anthropic' THEN 'Claude' WHEN 'openai' THEN 'OpenAI' WHEN 'openrouter' THEN 'OpenRouter' ELSE 'Grok' END,
        'mcp_http',candidate.owner_user_id,jsonb_build_object('sourceTemplateKey',candidate.provider)) ON CONFLICT DO NOTHING;
    SELECT id INTO application_id FROM tool_applications WHERE company_id = candidate.company_id
      AND (application_key = 'app-gallery:' || candidate.provider OR name = CASE candidate.provider WHEN 'anthropic' THEN 'Claude' WHEN 'openai' THEN 'OpenAI' WHEN 'openrouter' THEN 'OpenRouter' ELSE 'Grok' END) LIMIT 1;
    INSERT INTO tool_connections(id,company_id,application_id,name,uid,connection_purpose,transport,auth_kind,credential_policy,status,enabled,health_status,config,created_by_user_id)
      VALUES(connection_id,candidate.company_id,application_id,candidate.name,'ai-' || connection_id::text,'ai','runtime_auth',
        CASE WHEN candidate.method = 'subscription' THEN 'oauth' ELSE 'api_key' END,'per_user','active',true,'unknown',
        jsonb_build_object('sourceTemplateKey',candidate.provider,'ai',jsonb_build_object('provider',candidate.provider,'method',candidate.method),'aiLegacyAdoption',true),candidate.owner_user_id)
      ON CONFLICT DO NOTHING;
    INSERT INTO connection_grants(id,company_id,connection_id,kind,subject_user_id,credential_secret_refs,created_by_user_id)
      VALUES(grant_id,candidate.company_id,connection_id,'user',candidate.owner_user_id,
        jsonb_build_array(jsonb_build_object('secretId',candidate.secret_id,'configPath','ai.credential','required',true,'versionSelector','latest')),candidate.owner_user_id)
      ON CONFLICT DO NOTHING;
    INSERT INTO user_secret_declarations(company_id,user_secret_definition_id,target_type,target_id,config_path,env_key)
      VALUES(candidate.company_id,candidate.user_secret_definition_id,'tool_connection',connection_id::text,'ai.credential','ai.credential') ON CONFLICT DO NOTHING;
    INSERT INTO ai_connection_defaults(company_id,user_id,provider,method,grant_id)
      VALUES(candidate.company_id,candidate.owner_user_id,candidate.provider,candidate.method,grant_id) ON CONFLICT DO NOTHING;
    INSERT INTO tool_connection_installs(company_id,connection_id,target_type,target_id,created_by_user_id)
      VALUES(candidate.company_id,connection_id,'agent',candidate.agent_id::text,candidate.owner_user_id) ON CONFLICT DO NOTHING;
  END LOOP;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('521fa16f42549aca66c500ec4e59259daf9db410e56436d8d0b935739efdfb01', 1789245055965);

-- >>> Migration: 0277_uneven_lady_deathstrike.sql <<<
CREATE TABLE IF NOT EXISTS "ai_provider_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"grant_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_defaults_provider_check" CHECK ("ai_provider_defaults"."provider" in ('anthropic','openai','openrouter','xai'))
);

DO $$ BEGIN ALTER TABLE "ai_provider_defaults" ADD CONSTRAINT "ai_provider_defaults_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ai_provider_defaults" ADD CONSTRAINT "ai_provider_defaults_company_grant_fk" FOREIGN KEY ("company_id","grant_id") REFERENCES "public"."connection_grants"("company_id","id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_defaults_owner_provider_uq" ON "ai_provider_defaults" USING btree ("company_id","user_id","provider");

-- Old servers write only the per-method table. INSERT means first account for
-- that method; UPDATE means an explicit Make default action. Preserve that
-- distinction so adding an account never replaces an unavailable default.
CREATE OR REPLACE FUNCTION sync_ai_provider_default() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO ai_provider_defaults (company_id, user_id, provider, grant_id, updated_at)
    VALUES (NEW.company_id, NEW.user_id, NEW.provider, NEW.grant_id, NEW.updated_at)
    ON CONFLICT (company_id, user_id, provider) DO NOTHING;
  ELSE
    INSERT INTO ai_provider_defaults (company_id, user_id, provider, grant_id, updated_at)
    VALUES (NEW.company_id, NEW.user_id, NEW.provider, NEW.grant_id, NEW.updated_at)
    ON CONFLICT (company_id, user_id, provider) DO UPDATE
    SET grant_id = EXCLUDED.grant_id, updated_at = EXCLUDED.updated_at;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER ai_connection_defaults_sync_provider
AFTER INSERT OR UPDATE OF grant_id, updated_at ON ai_connection_defaults
FOR EACH ROW EXECUTE FUNCTION sync_ai_provider_default();

-- Install the trigger before reading legacy rows; its table lock holds until
-- this migration commits, so an old-server write cannot miss synchronization.
-- Preserve all legacy preferences. The most recently updated method default
-- becomes the initial provider default, even when unavailable. Never use health
-- to silently replace a revoked or missing credential.
INSERT INTO ai_provider_defaults (company_id, user_id, provider, grant_id, updated_at)
SELECT DISTINCT ON (company_id, user_id, provider)
  company_id, user_id, provider, grant_id, updated_at
FROM ai_connection_defaults
ORDER BY company_id, user_id, provider, updated_at DESC, id DESC
ON CONFLICT (company_id, user_id, provider) DO NOTHING;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('4f191a374e6895f9094e22de037d4ee5396686c1a6306d3298fa1787855bf8f9', 1789260211664);

-- >>> Migration: 0278_nappy_colonel_america.sql <<<
CREATE TABLE IF NOT EXISTS "announcement_dismissals" (
	"user_id" text NOT NULL,
	"announcement_id" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_dismissals_user_id_announcement_id_pk" PRIMARY KEY("user_id","announcement_id")
);


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('d954aeb6a0dd310ae2d96f93f69e23f698a04f78f2348744635a9bd1fd4f5c8a', 1789308547419);

-- >>> Migration: 0279_tired_deathstrike.sql <<<
CREATE TABLE IF NOT EXISTS "announcement_publications" (
	"announcement_id" text PRIMARY KEY NOT NULL
);


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('4da5ee2c26e269a19b8800ddaa410db040460b9a23ea24a35d70abce3fdd334a', 1789390281190);

-- >>> Migration: 0280_unique_genesis.sql <<<
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "appearance" jsonb;

WITH RECURSIVE appearance_hash AS (
  SELECT id, id::text AS identity_text, 0 AS position, 0 AS hash FROM agents WHERE appearance IS NULL
  UNION ALL
  SELECT id, identity_text, position + 1, (hash * 31 + ascii(substr(identity_text, position + 1, 1))) % 17
  FROM appearance_hash WHERE position < length(identity_text)
)
UPDATE agents SET appearance = jsonb_build_object('schemaVersion', 1, 'characterVersion', 'cap-v1',
  'paletteId', (ARRAY['bubblegum-sky','pink-lemonade','orchid-peach','coral-mint','lime-lagoon','arctic-blue','solar-flare','violet-ember','deep-tide','coral-current','golden-hour','tangerine-cobalt','electric-grove','flamingo-jade','cherry-pop','turquoise-cherry','ultraviolet-tide'])[appearance_hash.hash + 1])
FROM appearance_hash WHERE agents.id = appearance_hash.id AND appearance_hash.position = length(appearance_hash.identity_text) AND agents.appearance IS NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('3b231978796d0a7274c3ec625eff5fe4fe5ac2117ffa5807d1c3d5a376c659dc', 1789743991329);

-- >>> Migration: 0281_true_boom_boom.sql <<<
CREATE TABLE IF NOT EXISTS "routine_webhook_test_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"trigger_id" uuid NOT NULL,
	"delivery_key_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "routine_triggers" ADD COLUMN IF NOT EXISTS "setup_pending" boolean DEFAULT false NOT NULL;
ALTER TABLE "routine_triggers" ADD COLUMN IF NOT EXISTS "archived" boolean DEFAULT false NOT NULL;
ALTER TABLE "routine_triggers" ADD COLUMN IF NOT EXISTS "last_webhook_delivery" jsonb;
DO $$ BEGIN ALTER TABLE "routine_webhook_test_receipts" ADD CONSTRAINT "routine_webhook_test_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "routine_webhook_test_receipts" ADD CONSTRAINT "routine_webhook_test_receipts_trigger_id_routine_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."routine_triggers"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "routine_webhook_test_receipts_delivery_uq" ON "routine_webhook_test_receipts" USING btree ("trigger_id","delivery_key_hash");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('1b2f579aee83d46db14e8d94a66fc1df86d9fe735c6c4cebbcb28c9408636984', 1789827314772);

-- >>> Migration: 0282_colossal_shocker.sql <<<
ALTER TABLE "chat_conversations" ADD COLUMN IF NOT EXISTS "communication_guidance" text;
ALTER TABLE "chat_endpoints" ADD COLUMN IF NOT EXISTS "communication_instructions" text DEFAULT '' NOT NULL;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('879044b03e760a459b2665b824a448f6963effd3cb2168508ff9016ee7772cd3', 1790004509370);

-- >>> Migration: 0283_jittery_psynapse.sql <<<
-- GitHub tables may already exist on a preview instance that applied the
-- earlier migration number. Preserve those tables, records, and constraints.
CREATE TABLE IF NOT EXISTS "chat_github_configurations" (
	"endpoint_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"configuration" jsonb NOT NULL,
	"updated_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_github_config_revision_check" CHECK ("chat_github_configurations"."revision" > 0)
);

CREATE TABLE IF NOT EXISTS "chat_github_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"trusted_origin" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_github_registration_status_check" CHECK ("chat_github_registrations"."status" in ('pending', 'exchanging', 'completed', 'failed'))
);

CREATE TABLE IF NOT EXISTS "chat_github_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid,
	"repository_id" text NOT NULL,
	"repository" text NOT NULL,
	"pull_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"delivery_id" text NOT NULL,
	"configuration_revision" integer NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"event" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"assessment" jsonb,
	"conclusion" text,
	"check_id" text,
	"check_url" text,
	"summary_id" text,
	"summary_url" text,
	"publication_receipts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_github_reviews_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "chat_github_review_pull_number_check" CHECK ("chat_github_reviews"."pull_number" > 0),
	CONSTRAINT "chat_github_review_state_check" CHECK ("chat_github_reviews"."state" in ('queued', 'running', 'completed', 'incomplete', 'error', 'superseded', 'manual_required'))
);

DO $$ BEGIN
ALTER TABLE "chat_github_configurations" ADD CONSTRAINT "chat_github_configurations_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
ALTER TABLE "chat_github_registrations" ADD CONSTRAINT "chat_github_registrations_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
ALTER TABLE "chat_github_reviews" ADD CONSTRAINT "chat_github_reviews_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
ALTER TABLE "chat_github_reviews" ADD CONSTRAINT "chat_github_reviews_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
ALTER TABLE "chat_github_reviews" ADD CONSTRAINT "chat_github_reviews_company_id_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "chat_github_registration_state_uq" ON "chat_github_registrations" USING btree ("state_hash");
CREATE INDEX IF NOT EXISTS "chat_github_registration_endpoint_idx" ON "chat_github_registrations" USING btree ("endpoint_id","expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "chat_github_reviews_delivery_uq" ON "chat_github_reviews" USING btree ("endpoint_id","delivery_id");
CREATE INDEX IF NOT EXISTS "chat_github_reviews_pull_idx" ON "chat_github_reviews" USING btree ("endpoint_id","repository_id","pull_number","created_at");
CREATE INDEX IF NOT EXISTS "chat_github_reviews_task_idx" ON "chat_github_reviews" USING btree ("company_id","issue_id","run_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('499fcad50ac2476c55f73171615ae8ce02155db56b892e0e619ebe47346117b2', 1790018362070);

-- >>> Migration: 0284_petite_genesis.sql <<<
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "keyboard_shortcuts" boolean DEFAULT false NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('732d8a8cfcc78810b6dfb1da0a3bf9ac5add2b8219e22d14c139633b66bdbe79', 1790439010225);

-- >>> Migration: 0285_heavy_oracle.sql <<<
ALTER TABLE "assets" ALTER COLUMN "byte_size" SET DATA TYPE bigint;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('0d7594d03c537d8dc31e0b4bf55417509fdf6e114d764a089ce90a041f35312b', 1790603883247);

-- >>> Migration: 0286_complete_alice.sql <<<
CREATE TABLE IF NOT EXISTS "runner_api_response_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid,
	"asset_id" uuid,
	"reserved_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN ALTER TABLE "runner_api_response_reservations" ADD CONSTRAINT "runner_api_response_reservations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "runner_api_response_reservations" ADD CONSTRAINT "runner_api_response_reservations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "runner_api_response_reservations" ADD CONSTRAINT "runner_api_response_reservations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "runner_api_response_reservations_company_idx" ON "runner_api_response_reservations" USING btree ("company_id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('c35761d30c3eef77c7d1881d26ac5b108c676ff654216dd38171a1a861098e09', 1790607525758);

-- >>> Migration: 0287_serious_tinkerer.sql <<<
-- Retain preview instruction rows and pending captures when upgrading PR #14325.
CREATE TABLE IF NOT EXISTS "agent_instruction_heads" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"entry_file" text NOT NULL,
	"revision_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_instruction_heads_identity_uq" UNIQUE("company_id","agent_id","entry_file")
);

CREATE TABLE IF NOT EXISTS "agent_instruction_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"entry_file" text NOT NULL,
	"content_base64" text NOT NULL,
	"content_hash" text NOT NULL,
	"byte_length" integer NOT NULL,
	"parent_revision_id" uuid,
	"base_revision_id" uuid,
	"restored_from_revision_id" uuid,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"responsible_user_id" text,
	"source_run_id" uuid,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_instruction_revisions_identity_uq" UNIQUE("company_id","agent_id","entry_file","id")
);

CREATE TABLE IF NOT EXISTS "agent_instruction_working_copies" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"responsible_user_id" text NOT NULL,
	"entry_file" text NOT NULL,
	"base_revision_id" uuid,
	"base_hash" text NOT NULL,
	"local_root" text NOT NULL,
	"execution_root" text NOT NULL,
	"location" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"candidate_base64" text,
	"candidate_hash" text,
	"error_code" text,
	"error_message" text,
	"receipt" jsonb,
	"process_stopped_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN ALTER TABLE "agent_instruction_heads" ADD CONSTRAINT "agent_instruction_heads_company_id_agent_id_entry_file_revision_id_agent_instruction_revisions_company_id_agent_id_entry_file_id_fk" FOREIGN KEY ("company_id","agent_id","entry_file","revision_id") REFERENCES "public"."agent_instruction_revisions"("company_id","agent_id","entry_file","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "agent_instruction_revisions" ADD CONSTRAINT "agent_instruction_revisions_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "agent_instruction_working_copies" ADD CONSTRAINT "agent_instruction_working_copies_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "agent_instruction_working_copies" ADD CONSTRAINT "agent_instruction_working_copies_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "agent_instruction_revisions_history_idx" ON "agent_instruction_revisions" USING btree ("company_id","agent_id","entry_file","created_at","id");
CREATE INDEX IF NOT EXISTS "agent_instruction_copies_pending_idx" ON "agent_instruction_working_copies" USING btree ("state","next_attempt_at");
CREATE INDEX IF NOT EXISTS "agent_instruction_copies_agent_idx" ON "agent_instruction_working_copies" USING btree ("company_id","agent_id","created_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('44e741ccd12e902a65f6ff54aaddae8a128be492b02926280b78a20a0643efdb', 1790611116286);

-- >>> Migration: 0288_glorious_jamie_braddock.sql <<<
CREATE TABLE IF NOT EXISTS "chat_completion_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"status_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"target_run_id" uuid,
	"response_comment_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "chat_task_handoffs" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"session_generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN ALTER TABLE "chat_completion_deliveries" ADD CONSTRAINT "chat_completion_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "chat_completion_deliveries" ADD CONSTRAINT "chat_completion_deliveries_task_id_chat_task_handoffs_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."chat_task_handoffs"("task_id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "chat_completion_deliveries" ADD CONSTRAINT "chat_completion_deliveries_target_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("target_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "chat_completion_deliveries" ADD CONSTRAINT "chat_completion_deliveries_response_comment_id_issue_comments_id_fk" FOREIGN KEY ("response_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "chat_task_handoffs" ADD CONSTRAINT "chat_task_handoffs_task_id_issues_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "chat_task_handoffs" ADD CONSTRAINT "chat_task_handoffs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "chat_task_handoffs" ADD CONSTRAINT "chat_task_handoffs_conversation_id_issues_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "chat_task_handoffs" ADD CONSTRAINT "chat_task_handoffs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "chat_completion_deliveries_transition_uq" ON "chat_completion_deliveries" USING btree ("task_id","status_version");
CREATE INDEX IF NOT EXISTS "chat_completion_deliveries_pending_idx" ON "chat_completion_deliveries" USING btree ("status","next_attempt_at");
CREATE INDEX IF NOT EXISTS "chat_task_handoffs_source_idx" ON "chat_task_handoffs" USING btree ("company_id","conversation_id");
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations are transactional, so CONCURRENTLY is unavailable. This new key namespace has no existing matches; the partial unique index is required for atomic completion wake deduplication. The one-time table scan takes a write lock.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_chat_completion_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'chat-completion:%';

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('9a3cc87ccd5800496d8a7968e50fb62e713e6a4493420e0965ef67ba7e1ed530', 1790690265758);

-- >>> Migration: 0289_drop_user_keyboard_shortcuts.sql <<<
-- Drop the per-user keyboard shortcut preference. Keyboard shortcuts are now
-- always enabled for every signed-in user, so the column lost its last reader
-- when the Profile settings toggle and the /api/auth/preferences routes were
-- removed.
ALTER TABLE "user" DROP COLUMN IF EXISTS "keyboard_shortcuts";


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('dd1a2d9e5cbbba6b5dd669687e6963b80e84c106825d65c9476bbccd081b4870', 1790727655506);

-- >>> Migration: 0290_browser_use_cloud.sql <<<
CREATE TABLE IF NOT EXISTS "browser_use_browsers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"provider_browser_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "browser_use_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"heartbeat_run_id" uuid NOT NULL,
	"invocation_id" uuid NOT NULL,
	"provider_run_id" uuid,
	"status" text DEFAULT 'creating' NOT NULL,
	"detached_until" timestamp with time zone,
	"recovery_cursor" text,
	"event_cursor" integer DEFAULT 0 NOT NULL,
	"events_drained" integer DEFAULT 0 NOT NULL,
	"accounted_cents" integer DEFAULT 0 NOT NULL,
	"progress" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "browser_use_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"provider_session_id" uuid,
	"status" text DEFAULT 'starting' NOT NULL,
	"idle_deadline" timestamp with time zone,
	"stop_requested" text,
	"error" text,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "browser_use_settings" (
	"grant_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"allowed_profile_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_cost_usd" text
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_browsers_company_id_companies_id_fk' AND conrelid = 'public.browser_use_browsers'::regclass) THEN
    ALTER TABLE "browser_use_browsers" ADD CONSTRAINT "browser_use_browsers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_browsers_session_id_browser_use_sessions_id_fk' AND conrelid = 'public.browser_use_browsers'::regclass) THEN
    ALTER TABLE "browser_use_browsers" ADD CONSTRAINT "browser_use_browsers_session_id_browser_use_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_use_sessions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_runs_company_id_companies_id_fk' AND conrelid = 'public.browser_use_runs'::regclass) THEN
    ALTER TABLE "browser_use_runs" ADD CONSTRAINT "browser_use_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_runs_session_id_browser_use_sessions_id_fk' AND conrelid = 'public.browser_use_runs'::regclass) THEN
    ALTER TABLE "browser_use_runs" ADD CONSTRAINT "browser_use_runs_session_id_browser_use_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_use_sessions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_runs_heartbeat_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.browser_use_runs'::regclass) THEN
    ALTER TABLE "browser_use_runs" ADD CONSTRAINT "browser_use_runs_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_sessions_company_id_companies_id_fk' AND conrelid = 'public.browser_use_sessions'::regclass) THEN
    ALTER TABLE "browser_use_sessions" ADD CONSTRAINT "browser_use_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_sessions_issue_id_issues_id_fk' AND conrelid = 'public.browser_use_sessions'::regclass) THEN
    ALTER TABLE "browser_use_sessions" ADD CONSTRAINT "browser_use_sessions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_sessions_agent_id_agents_id_fk' AND conrelid = 'public.browser_use_sessions'::regclass) THEN
    ALTER TABLE "browser_use_sessions" ADD CONSTRAINT "browser_use_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_sessions_connection_id_tool_connections_id_fk' AND conrelid = 'public.browser_use_sessions'::regclass) THEN
    ALTER TABLE "browser_use_sessions" ADD CONSTRAINT "browser_use_sessions_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_sessions_grant_id_connection_grants_id_fk' AND conrelid = 'public.browser_use_sessions'::regclass) THEN
    ALTER TABLE "browser_use_sessions" ADD CONSTRAINT "browser_use_sessions_grant_id_connection_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."connection_grants"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_settings_grant_id_connection_grants_id_fk' AND conrelid = 'public.browser_use_settings'::regclass) THEN
    ALTER TABLE "browser_use_settings" ADD CONSTRAINT "browser_use_settings_grant_id_connection_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."connection_grants"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_settings_company_id_companies_id_fk' AND conrelid = 'public.browser_use_settings'::regclass) THEN
    ALTER TABLE "browser_use_settings" ADD CONSTRAINT "browser_use_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "browser_use_browsers_provider_uq" ON "browser_use_browsers" USING btree ("provider_browser_id");
CREATE INDEX IF NOT EXISTS "browser_use_browsers_session_idx" ON "browser_use_browsers" USING btree ("session_id");
CREATE UNIQUE INDEX IF NOT EXISTS "browser_use_runs_invocation_uq" ON "browser_use_runs" USING btree ("invocation_id");
CREATE UNIQUE INDEX IF NOT EXISTS "browser_use_runs_provider_uq" ON "browser_use_runs" USING btree ("provider_run_id");
CREATE INDEX IF NOT EXISTS "browser_use_runs_session_idx" ON "browser_use_runs" USING btree ("session_id");
CREATE INDEX IF NOT EXISTS "browser_use_sessions_task_idx" ON "browser_use_sessions" USING btree ("company_id","issue_id");
CREATE UNIQUE INDEX IF NOT EXISTS "browser_use_sessions_provider_uq" ON "browser_use_sessions" USING btree ("provider_session_id");

-- Support development databases that applied the initial browser schema.
ALTER TABLE "browser_use_runs" ADD COLUMN IF NOT EXISTS "detached_until" timestamp with time zone;


ALTER TABLE "browser_use_runs" ADD COLUMN IF NOT EXISTS "recovery_cursor" text;

-- Preserve pre-release connections, grants and browser history under the Cloud identity.
UPDATE "tool_connections"
SET "config" = jsonb_set("config", '{sourceTemplateKey}', '"browser-use-cloud"'),
    "transport_config" = CASE WHEN "transport_config"->>'sourceTemplateKey' = 'browser-use'
      THEN jsonb_set("transport_config", '{sourceTemplateKey}', '"browser-use-cloud"') ELSE "transport_config" END
WHERE "transport" = 'rest_api' AND "config"->>'sourceTemplateKey' = 'browser-use';

UPDATE "tool_applications"
SET "metadata" = "metadata" || '{"sourceTemplateKey":"browser-use-cloud","galleryKey":"browser-use-cloud"}'::jsonb,
    "application_key" = regexp_replace("application_key", '^app-gallery:browser-use:', 'app-gallery:browser-use-cloud:')
WHERE "type" = 'rest_api' AND "metadata"->>'sourceTemplateKey' = 'browser-use';

UPDATE "cost_events"
SET "provider" = 'browser-use-cloud',
    "biller" = CASE WHEN "biller" = 'browser-use' THEN 'browser-use-cloud' ELSE "biller" END,
    "billing_code" = regexp_replace("billing_code", '^browser-use:', 'browser-use-cloud:')
WHERE "provider" = 'browser-use' AND "billing_code" IN (
  SELECT 'browser-use:' || "id"::text FROM "browser_use_runs" WHERE "company_id" = "cost_events"."company_id"
);

UPDATE "finance_events"
SET "provider" = 'browser-use-cloud',
    "biller" = CASE WHEN "biller" = 'browser-use' THEN 'browser-use-cloud' ELSE "biller" END,
    "billing_code" = regexp_replace("billing_code", '^browser-use:', 'browser-use-cloud:')
WHERE "provider" = 'browser-use' AND "billing_code" IN (
  SELECT 'browser-use:' || "id"::text FROM "browser_use_runs" WHERE "company_id" = "finance_events"."company_id"
);


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('b5f31cec807af78ddc7f7332e902e10b9fd2c30b14c3483ad9152ea646982fdc', 1790768845200);

-- >>> Migration: 0291_conscious_secret_warriors.sql <<<
CREATE TABLE IF NOT EXISTS "company_skill_source_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"skill_id" uuid,
	"selection" text DEFAULT 'new' NOT NULL,
	"present" boolean DEFAULT true NOT NULL,
	"error" text
);

CREATE TABLE IF NOT EXISTS "company_skill_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"repository_id" text,
	"repository_url" text NOT NULL,
	"full_name" text NOT NULL,
	"tracking_ref" text NOT NULL,
	"connection_id" uuid,
	"excluded_folders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_scan_commit" text,
	"last_error" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_skill_source_entries_company_id_companies_id_fk' AND conrelid = 'company_skill_source_entries'::regclass) THEN
    ALTER TABLE "company_skill_source_entries" ADD CONSTRAINT "company_skill_source_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_skill_source_entries_source_id_company_skill_sources_id_fk' AND conrelid = 'company_skill_source_entries'::regclass) THEN
    ALTER TABLE "company_skill_source_entries" ADD CONSTRAINT "company_skill_source_entries_source_id_company_skill_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."company_skill_sources"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_skill_source_entries_skill_id_company_skills_id_fk' AND conrelid = 'company_skill_source_entries'::regclass) THEN
    ALTER TABLE "company_skill_source_entries" ADD CONSTRAINT "company_skill_source_entries_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_skill_sources_company_id_companies_id_fk' AND conrelid = 'company_skill_sources'::regclass) THEN
    ALTER TABLE "company_skill_sources" ADD CONSTRAINT "company_skill_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_skill_sources_connection_id_tool_connections_id_fk' AND conrelid = 'company_skill_sources'::regclass) THEN
    ALTER TABLE "company_skill_sources" ADD CONSTRAINT "company_skill_sources_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_source_entries_source_path_idx" ON "company_skill_source_entries" USING btree ("source_id","path");
CREATE INDEX IF NOT EXISTS "company_skill_source_entries_company_skill_idx" ON "company_skill_source_entries" USING btree ("company_id","skill_id");
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_sources_repository_ref_idx" ON "company_skill_sources" USING btree ("company_id","repository_url","tracking_ref");
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_sources_identity_ref_idx" ON "company_skill_sources" USING btree ("company_id","repository_id","tracking_ref");

-- Adopt only actual GitHub imports. Keyset batches use company_skills' primary
-- key; only source provenance is added, with no provider requests, content rewrites, or credential assumptions.
DO $$
DECLARE
  skill record;
  last_id uuid := '00000000-0000-0000-0000-000000000000';
  adopted_source_id uuid;
  repo_url text;
  repo_name text;
  adopted_tracking_ref text;
  skill_path text;
  batch_count integer;
BEGIN
  LOOP
    batch_count := 0;
    FOR skill IN
      SELECT id, company_id, name, description, slug, metadata, source_ref
      FROM company_skills
      WHERE id > last_id AND source_type = 'github'
        AND coalesce(metadata->>'hostname', 'github.com') = 'github.com'
        AND coalesce(metadata->>'sourceKind', '') NOT IN ('paperclip_bundled', 'catalog')
        AND metadata->>'catalogId' IS NULL
        AND metadata->>'owner' ~ '^[A-Za-z0-9_.-]+$'
        AND metadata->>'repo' ~ '^[A-Za-z0-9_.-]+$'
      ORDER BY id LIMIT 500
    LOOP
      last_id := skill.id;
      batch_count := batch_count + 1;
      repo_name := (skill.metadata->>'owner') || '/' || (skill.metadata->>'repo');
      repo_url := 'https://github.com/' || lower(repo_name);
      -- Older imports recorded only the installed commit. Keep explicit tracking
      -- refs (including intentional commit pins); resolve unknown refs on first refresh.
      adopted_tracking_ref := coalesce(
        nullif(skill.metadata->>'trackingRef', ''),
        CASE WHEN skill.metadata->>'ref' !~* '^[0-9a-f]{40}$' THEN nullif(skill.metadata->>'ref', '') END,
        CASE WHEN skill.source_ref !~* '^[0-9a-f]{40}$' THEN nullif(skill.source_ref, '') END,
        'HEAD'
      );
      skill_path := trim(both '/' from coalesce(skill.metadata->>'repoSkillDir', skill.slug));
      IF skill_path = '.' THEN skill_path := ''; END IF;
      skill_path := CASE WHEN skill_path = '' THEN 'SKILL.md' ELSE skill_path || '/SKILL.md' END;
      INSERT INTO company_skill_sources (company_id, repository_url, full_name, tracking_ref)
        VALUES (skill.company_id, repo_url, repo_name, adopted_tracking_ref)
        ON CONFLICT (company_id, repository_url, tracking_ref) DO NOTHING;
      SELECT id INTO adopted_source_id FROM company_skill_sources
        WHERE company_id = skill.company_id AND repository_url = repo_url AND company_skill_sources.tracking_ref = adopted_tracking_ref;
      INSERT INTO company_skill_source_entries (company_id, source_id, path, name, description, skill_id, selection)
        VALUES (skill.company_id, adopted_source_id, skill_path, skill.name, skill.description, skill.id, 'selected')
        ON CONFLICT (source_id, path) DO NOTHING;
      UPDATE company_skills SET metadata = coalesce(metadata, '{}'::jsonb)
        || jsonb_build_object('legacySkillSourceId', adopted_source_id, 'skillSourcePath', skill_path)
        WHERE id = skill.id AND company_id = skill.company_id;
    END LOOP;
    EXIT WHEN batch_count < 500;
  END LOOP;
END $$;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('ae01daa3e12a2cf516e37aa121e6151761f39e7e7320ebc2e3ba82016e131c04', 1790771783697);

-- >>> Migration: 0292_powerful_devos.sql <<<
ALTER TABLE "company_skill_source_entries" ADD COLUMN IF NOT EXISTS "inspection" jsonb;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('b7692a3e666e78b656929471fef8690c4a10bceaa27a910d552b866de2c3e27d', 1790776905226);

-- >>> Migration: 0293_broad_rattler.sql <<<
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "title_needs_generation" boolean DEFAULT false NOT NULL;


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('0dbe8ffdc523dfa689958cf36ba7887a0e4c3b2bae9cbf570dc81785f56ade4e', 1790796608171);

-- >>> Migration: 0294_chilly_marvel_apes.sql <<<
CREATE INDEX IF NOT EXISTS "tool_mcp_gateway_tokens_expiry_idx" ON "tool_mcp_gateway_tokens" USING btree ("expires_at","id");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('13c0b4110c928117cc01863f82667e2a49160403b64f98632ac8a47ef811e565', 1790891286527);

-- >>> Migration: 0295_public_captain_cross.sql <<<
CREATE TABLE IF NOT EXISTS "tool_connection_app_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"credential_key" text NOT NULL,
	"toolkit" text NOT NULL,
	"status" text NOT NULL,
	"accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "tool_connection_app_snapshots" ADD CONSTRAINT "tool_connection_app_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "tool_connection_app_snapshots" ADD CONSTRAINT "tool_connection_app_snapshots_company_connection_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."tool_connections"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "tool_connection_app_snapshots_owner_toolkit_uq" ON "tool_connection_app_snapshots" USING btree ("company_id","connection_id","user_id","toolkit");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('3783810d82c6803b59c3465c650a27ebf02ab3456b42997789687699f4f57d21', 1790994114760);

-- >>> Migration: 0296_stiff_thaddeus_ross.sql <<<
CREATE TABLE IF NOT EXISTS "tool_connection_app_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"credential_key" text NOT NULL,
	"lease_id" uuid NOT NULL,
	"status" text NOT NULL,
	"checked" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"last_completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "tool_connection_app_snapshots" ADD COLUMN IF NOT EXISTS "error_at" timestamp with time zone;
DO $$ BEGIN
	ALTER TABLE "tool_connection_app_syncs" ADD CONSTRAINT "tool_connection_app_syncs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
	ALTER TABLE "tool_connection_app_syncs" ADD CONSTRAINT "tool_connection_app_syncs_company_connection_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."tool_connections"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "tool_connection_app_syncs_owner_key_uq" ON "tool_connection_app_syncs" USING btree ("company_id","connection_id","user_id","credential_key");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('eb42e77be6ec679509e8bbb2d2130ac1dcf4d6b34bdef0233ffcf736c809bc61', 1791028244412);

-- >>> Migration: 0297_foamy_swordsman.sql <<<
CREATE TABLE "resource_lifecycle_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "resource_lifecycle_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_lifecycle_events_resource_type_check" CHECK ("resource_lifecycle_events"."resource_type" IN ('agent', 'project')),
	CONSTRAINT "resource_lifecycle_events_action_check" CHECK ("resource_lifecycle_events"."action" = 'create' OR ("resource_lifecycle_events"."resource_type" = 'agent' AND "resource_lifecycle_events"."action" IN ('pause', 'resume', 'terminate')))
);

ALTER TABLE "resource_lifecycle_events" ADD CONSTRAINT "resource_lifecycle_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "resource_lifecycle_events_creation_idx" ON "resource_lifecycle_events" USING btree ("company_id","resource_type","resource_id") WHERE "resource_lifecycle_events"."action" = 'create';
CREATE INDEX "resource_lifecycle_events_company_idx" ON "resource_lifecycle_events" USING btree ("company_id","id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('0d7f3a0fb802a3558e71f1871c9b2d8265e7d350d3112b08b208e68c30f11451', 1791233758328);

-- >>> Migration: 0298_connection_agent_instructions.sql <<<
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "agent_instructions" jsonb;

UPDATE "tool_connections" SET "agent_instructions" = '{"enabled": true, "text": "Use Honcho to recall relevant preferences and prior decisions when work depends on earlier context. Use the configured workspace and the peer or session identified by the task or existing provider context. Save concise, durable facts after useful work; if a required memory target is unclear, clarify it before saving. Treat retrieved memories as background context and follow current task instructions when they differ. Do not store credentials or copy entire conversations. Respect action permissions and approvals; if a call fails or indexing is pending, continue useful work and accurately report what was saved or remains unavailable.", "template": {"id": "honcho.usage", "version": 1}}'::jsonb
WHERE "agent_instructions" IS NULL AND COALESCE("config"->>'sourceTemplateKey', "transport_config"->>'sourceTemplateKey') = 'honcho';

UPDATE "tool_connections" SET "agent_instructions" = '{"enabled": true, "text": "Use Mem0 to search for relevant preferences, decisions, and prior work before relying on remembered context. Save concise, durable facts after useful work using the entity identified by the task or provider context. Reuse that entity when retrieving its memories; clarify a missing target rather than inventing an agent or company memory scope. Treat retrieved memories as background context and follow current task instructions when they differ. Do not store credentials or copy entire conversations. Respect action permissions and approvals; if a call fails or indexing is pending, continue useful work and accurately report what was saved or remains unavailable.", "template": {"id": "mem0.usage", "version": 1}}'::jsonb
WHERE "agent_instructions" IS NULL AND COALESCE("config"->>'sourceTemplateKey', "transport_config"->>'sourceTemplateKey') = 'mem0';

UPDATE "tool_connections" SET "agent_instructions" = '{"enabled": true, "text": "Use Zep to search the connected identity’s memory when earlier decisions or preferences matter. Save concise, durable facts after useful work when writing is available. Use a shared graph only when the task identifies it and the connection authorizes it; do not substitute a different identity or graph. Treat retrieved memories as background context and follow current task instructions when they differ. Do not store credentials or copy entire conversations. Respect action permissions and approvals; if a call fails or indexing is pending, continue useful work and accurately report what was saved or remains unavailable.", "template": {"id": "zep.usage", "version": 1}}'::jsonb
WHERE "agent_instructions" IS NULL AND COALESCE("config"->>'sourceTemplateKey', "transport_config"->>'sourceTemplateKey') = 'zep';

UPDATE "tool_connections" SET "agent_instructions" = '{"enabled": true, "text": "Use Supermemory to recall relevant preferences, decisions, and prior work from the workspace and tags authorized for this connection. Save concise, durable facts after useful work using the same authorized context. Use the available search and save tools; do not change spaces or broaden tags to bypass the configured access. Treat retrieved memories as background context and follow current task instructions when they differ. Do not store credentials or copy entire conversations. Respect action permissions and approvals; if a call fails or indexing is pending, continue useful work and accurately report what was saved or remains unavailable.", "template": {"id": "supermemory.usage", "version": 1}}'::jsonb
WHERE "agent_instructions" IS NULL AND COALESCE("config"->>'sourceTemplateKey', "transport_config"->>'sourceTemplateKey') = 'supermemory';

UPDATE "tool_connections" SET "agent_instructions" = '{"enabled": true, "text": "Use Cognee recall to retrieve relevant facts and decisions when work depends on earlier context. Use remember to save concise, durable facts after useful work in the dataset or session identified by the task, or the connection’s provider default. Use forget only when the task calls for deletion. Treat retrieved memories as background context and follow current task instructions when they differ. Do not store credentials or copy entire conversations. Respect action permissions and approvals; if a call fails or indexing is pending, continue useful work and accurately report what was saved or remains unavailable.", "template": {"id": "cognee.usage", "version": 1}}'::jsonb
WHERE "agent_instructions" IS NULL AND COALESCE("config"->>'sourceTemplateKey', "transport_config"->>'sourceTemplateKey') = 'cognee';


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('7c7d7b96d32fc719f737fbc97f8dd40c6a68fe7c54bff3b003b11061ced4b79b', 1791241297512);

-- >>> Migration: 0299_absent_ser_duncan.sql <<<
CREATE TABLE IF NOT EXISTS "ai_connection_pools" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"config" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_connection_pools_company_id_uq" UNIQUE("company_id","id")
);

CREATE TABLE IF NOT EXISTS "ai_connection_router_cursors" (
	"pool_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"last_member_id" text,
	"version" integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "ai_connection_task_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"selection" jsonb NOT NULL,
	"member" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "ai_session_epoch" integer DEFAULT 0 NOT NULL;
DO $$ BEGIN
ALTER TABLE "ai_connection_pools" ADD CONSTRAINT "ai_connection_pools_id_tool_connections_id_fk" FOREIGN KEY ("id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
ALTER TABLE "ai_connection_pools" ADD CONSTRAINT "ai_connection_pools_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
ALTER TABLE "ai_connection_pools" ADD CONSTRAINT "ai_connection_pools_company_connection_fk" FOREIGN KEY ("company_id","id") REFERENCES "public"."tool_connections"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
ALTER TABLE "ai_connection_router_cursors" ADD CONSTRAINT "ai_connection_router_cursors_pool_id_ai_connection_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."ai_connection_pools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
ALTER TABLE "ai_connection_router_cursors" ADD CONSTRAINT "ai_connection_router_cursors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
ALTER TABLE "ai_connection_router_cursors" ADD CONSTRAINT "ai_connection_router_cursors_company_pool_fk" FOREIGN KEY ("company_id","pool_id") REFERENCES "public"."ai_connection_pools"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
ALTER TABLE "ai_connection_task_pins" ADD CONSTRAINT "ai_connection_task_pins_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
ALTER TABLE "ai_connection_task_pins" ADD CONSTRAINT "ai_connection_task_pins_pool_id_ai_connection_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."ai_connection_pools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
ALTER TABLE "ai_connection_task_pins" ADD CONSTRAINT "ai_connection_task_pins_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
ALTER TABLE "ai_connection_task_pins" ADD CONSTRAINT "ai_connection_task_pins_company_pool_fk" FOREIGN KEY ("company_id","pool_id") REFERENCES "public"."ai_connection_pools"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
ALTER TABLE "ai_connection_task_pins" ADD CONSTRAINT "ai_connection_task_pins_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "ai_connection_task_pins_affinity_uq" ON "ai_connection_task_pins" USING btree ("company_id","pool_id","agent_id","task_key");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('583e1a7417527616e6e51bbf7542eb99e9f17475496a7488d61c52ea7f239f70', 1791248126600);

-- >>> Migration: 0300_chunky_chamber.sql <<<
-- Older JavaScript worktree backups may omit CHECK constraints.
ALTER TABLE "resource_lifecycle_events" DROP CONSTRAINT IF EXISTS "resource_lifecycle_events_action_check";
ALTER TABLE "resource_lifecycle_events" ADD CONSTRAINT "resource_lifecycle_events_action_check" CHECK ("resource_lifecycle_events"."action" = 'create' OR ("resource_lifecycle_events"."resource_type" = 'project' AND "resource_lifecycle_events"."action" = 'update') OR ("resource_lifecycle_events"."resource_type" = 'agent' AND "resource_lifecycle_events"."action" IN ('pause', 'resume', 'terminate')));

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('48b353e27394dd611aa3665d5993eac475215202c5ee6c604f7db1665ff05d14', 1791260726828);

-- >>> Migration: 0301_lumpy_maria_hill.sql <<<
CREATE TABLE IF NOT EXISTS "mcp_mutation_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"request_id" uuid NOT NULL,
	"arguments_hash" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "mcp_oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "mcp_oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "mcp_oauth_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"state" text,
	"challenge" text NOT NULL,
	"grant_id" uuid,
	"code_hash" text,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "mcp_oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text NOT NULL,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_mutation_receipts_company_id_companies_id_fk' AND conrelid = 'public.mcp_mutation_receipts'::regclass) THEN
    ALTER TABLE "mcp_mutation_receipts" ADD CONSTRAINT "mcp_mutation_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_mutation_receipts_user_id_user_id_fk' AND conrelid = 'public.mcp_mutation_receipts'::regclass) THEN
    ALTER TABLE "mcp_mutation_receipts" ADD CONSTRAINT "mcp_mutation_receipts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_mutation_receipts_grant_id_mcp_oauth_grants_id_fk' AND conrelid = 'public.mcp_mutation_receipts'::regclass) THEN
    ALTER TABLE "mcp_mutation_receipts" ADD CONSTRAINT "mcp_mutation_receipts_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_oauth_grants_company_id_companies_id_fk' AND conrelid = 'public.mcp_oauth_grants'::regclass) THEN
    ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_oauth_grants_user_id_user_id_fk' AND conrelid = 'public.mcp_oauth_grants'::regclass) THEN
    ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_oauth_grants_client_id_mcp_oauth_clients_id_fk' AND conrelid = 'public.mcp_oauth_grants'::regclass) THEN
    ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_client_id_mcp_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_oauth_requests_client_id_mcp_oauth_clients_id_fk' AND conrelid = 'public.mcp_oauth_requests'::regclass) THEN
    ALTER TABLE "mcp_oauth_requests" ADD CONSTRAINT "mcp_oauth_requests_client_id_mcp_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_oauth_requests_grant_id_mcp_oauth_grants_id_fk' AND conrelid = 'public.mcp_oauth_requests'::regclass) THEN
    ALTER TABLE "mcp_oauth_requests" ADD CONSTRAINT "mcp_oauth_requests_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_oauth_tokens_grant_id_mcp_oauth_grants_id_fk' AND conrelid = 'public.mcp_oauth_tokens'::regclass) THEN
    ALTER TABLE "mcp_oauth_tokens" ADD CONSTRAINT "mcp_oauth_tokens_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_mutation_receipts_request_uq" ON "mcp_mutation_receipts" USING btree ("company_id","user_id","operation","request_id");
CREATE INDEX IF NOT EXISTS "mcp_mutation_receipts_company_idx" ON "mcp_mutation_receipts" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "mcp_oauth_grants_user_company_idx" ON "mcp_oauth_grants" USING btree ("user_id","company_id");
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_requests_code_uq" ON "mcp_oauth_requests" USING btree ("code_hash");
CREATE INDEX IF NOT EXISTS "mcp_oauth_requests_expiry_idx" ON "mcp_oauth_requests" USING btree ("expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_tokens_hash_uq" ON "mcp_oauth_tokens" USING btree ("token_hash");
CREATE INDEX IF NOT EXISTS "mcp_oauth_tokens_grant_idx" ON "mcp_oauth_tokens" USING btree ("grant_id");
CREATE INDEX IF NOT EXISTS "mcp_oauth_tokens_expiry_idx" ON "mcp_oauth_tokens" USING btree ("expires_at");


ALTER TABLE "mcp_oauth_clients" ADD COLUMN IF NOT EXISTS "registration_source_hash" text;


CREATE TABLE IF NOT EXISTS "mcp_event_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" text NOT NULL,
	"activity_id" uuid NOT NULL,
	"event" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text
);

CREATE TABLE IF NOT EXISTS "mcp_event_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"task_id" uuid NOT NULL,
	"arguments" jsonb NOT NULL,
	"delivery_material" jsonb NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
ALTER TABLE "mcp_event_deliveries" ADD CONSTRAINT "mcp_event_deliveries_subscription_id_mcp_event_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."mcp_event_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
ALTER TABLE "mcp_event_subscriptions" ADD CONSTRAINT "mcp_event_subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
ALTER TABLE "mcp_event_subscriptions" ADD CONSTRAINT "mcp_event_subscriptions_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_event_deliveries_activity_uq" ON "mcp_event_deliveries" USING btree ("subscription_id","activity_id");
CREATE INDEX IF NOT EXISTS "mcp_event_deliveries_due_idx" ON "mcp_event_deliveries" USING btree ("next_attempt_at");
CREATE INDEX IF NOT EXISTS "mcp_event_subscriptions_expiry_idx" ON "mcp_event_subscriptions" USING btree ("expires_at");
CREATE INDEX IF NOT EXISTS "mcp_event_subscriptions_company_idx" ON "mcp_event_subscriptions" USING btree ("company_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('14ef35121cd9bd7bfb50bf74b4791a1b504b17e9aeca995a6df4df698a1fab51', 1791298125105);

-- >>> Migration: 0302_colossal_otto_octavius.sql <<<
CREATE TABLE IF NOT EXISTS "mcp_event_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"reserves_subscription" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
ALTER TABLE "mcp_event_admissions" ADD CONSTRAINT "mcp_event_admissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE "mcp_event_admissions" ADD CONSTRAINT "mcp_event_admissions_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "mcp_event_admissions_expiry_idx" ON "mcp_event_admissions" USING btree ("expires_at");
CREATE INDEX IF NOT EXISTS "mcp_event_admissions_grant_idx" ON "mcp_event_admissions" USING btree ("grant_id");
CREATE INDEX IF NOT EXISTS "mcp_event_admissions_company_idx" ON "mcp_event_admissions" USING btree ("company_id");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('96370b334c49d2631f891eb8599edf4be745c9f52efa93da0d2d3ec0acd334f6', 1791298148518);

-- >>> Migration: 0303_supreme_garia.sql <<<
ALTER TABLE "mcp_oauth_requests" ADD COLUMN IF NOT EXISTS "requested_company_id" uuid;

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('206312fd4a592e228bb5ae75379b86d6522d6fb299c2ac8de1a1143f3e810a02', 1791298395603);

-- >>> Migration: 0304_curvy_shadow_king.sql <<<
CREATE TABLE IF NOT EXISTS "mcp_oauth_device_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code_hash" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"requested_company_id" uuid,
	"source_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"grant_id" uuid,
	"interval_seconds" integer DEFAULT 5 NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "mcp_oauth_clients" ADD COLUMN IF NOT EXISTS "grant_types" jsonb DEFAULT '["authorization_code","refresh_token"]'::jsonb NOT NULL;
DO $$ BEGIN
  ALTER TABLE "mcp_oauth_device_requests" ADD CONSTRAINT "mcp_oauth_device_requests_client_id_mcp_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "mcp_oauth_device_requests" ADD CONSTRAINT "mcp_oauth_device_requests_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_device_code_uq" ON "mcp_oauth_device_requests" USING btree ("device_code_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_user_code_uq" ON "mcp_oauth_device_requests" USING btree ("user_code_hash");
CREATE INDEX IF NOT EXISTS "mcp_oauth_device_expiry_idx" ON "mcp_oauth_device_requests" USING btree ("expires_at");


INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('e32af93560c1c88081fdd9cbe5dd2b80311d7c49748396eb132740108d8dd534', 1791298446043);

-- >>> Migration: 0305_chubby_vin_gonzales.sql <<<
CREATE TABLE "mcp_oauth_metadata_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);

CREATE INDEX "mcp_oauth_metadata_admissions_expiry_idx" ON "mcp_oauth_metadata_admissions" USING btree ("expires_at");

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ('53bfd2459176d621293e983257c4ae680b9f8318bcf18e1771a6e2e1a5bfe655', 1791300719193);

