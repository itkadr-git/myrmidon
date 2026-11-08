-- myrmidon(1.7-AGENT-EXCHANGE-A): discussion rooms on issue cards.
-- The room row freezes roster, finisher and the ceilings resolved at open;
-- the message rows are the round grid (one cell per participant per round).
CREATE TABLE IF NOT EXISTS "agent_exchange_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opener_type" text NOT NULL,
	"opener_id" text NOT NULL,
	"stopper_type" text NOT NULL,
	"stopper_id" text NOT NULL,
	"participants" jsonb NOT NULL,
	"finisher" jsonb,
	"max_rounds" integer NOT NULL,
	"token_budget" integer NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"current_round" integer DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"summary_document_key" text,
	"judge" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "agent_exchange_rooms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade,
	CONSTRAINT "agent_exchange_rooms_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_exchange_rooms_company_issue_idx" ON "agent_exchange_rooms" USING btree ("company_id","issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_exchange_rooms_company_status_idx" ON "agent_exchange_rooms" USING btree ("company_id","status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_exchange_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"participant_index" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"content" text,
	"error" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_exchange_messages_room_id_agent_exchange_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."agent_exchange_rooms"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_exchange_messages_room_round_idx" ON "agent_exchange_messages" USING btree ("room_id","round");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_exchange_messages_cell_uq" ON "agent_exchange_messages" USING btree ("room_id","round","participant_index");
