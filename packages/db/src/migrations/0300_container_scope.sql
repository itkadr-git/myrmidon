-- myrmidon(CONTAINER-SCOPE): the container axis of an isolation area.
-- Additive only: the disk tables of BOT-DISK-F (0298) and every vendor
-- table stay untouched.

CREATE TABLE "myrmidon_container_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"container_mode" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "myrmidon_container_states" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"applied_container_key" text,
	"restart_required_at" timestamp with time zone,
	"restart_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "myrmidon_container_settings" ADD CONSTRAINT "myrmidon_container_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "myrmidon_container_states" ADD CONSTRAINT "myrmidon_container_states_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "myrmidon_container_states" ADD CONSTRAINT "myrmidon_container_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "myrmidon_container_settings_instance_uq" ON "myrmidon_container_settings" USING btree ("company_id","scope_kind","scope_id");--> statement-breakpoint
CREATE INDEX "myrmidon_container_states_company_idx" ON "myrmidon_container_states" USING btree ("company_id");