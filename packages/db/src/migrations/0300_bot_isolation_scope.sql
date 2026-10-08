CREATE TABLE "myrmidon_scope_agent_prefs" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"isolate" boolean DEFAULT false NOT NULL,
	"group_id" uuid,
	"project_id" uuid,
	"applied_kind" text DEFAULT 'isolated' NOT NULL,
	"applied_dir" text,
	"applied_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "myrmidon_scope_group_members" (
	"group_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "myrmidon_scope_group_members_pk" PRIMARY KEY("group_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "myrmidon_scope_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "myrmidon_scope_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"mode" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "myrmidon_scope_agent_prefs" ADD CONSTRAINT "myrmidon_scope_agent_prefs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "myrmidon_scope_agent_prefs" ADD CONSTRAINT "myrmidon_scope_agent_prefs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "myrmidon_scope_group_members" ADD CONSTRAINT "myrmidon_scope_group_members_group_id_myrmidon_scope_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."myrmidon_scope_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "myrmidon_scope_group_members" ADD CONSTRAINT "myrmidon_scope_group_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "myrmidon_scope_groups" ADD CONSTRAINT "myrmidon_scope_groups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "myrmidon_scope_settings" ADD CONSTRAINT "myrmidon_scope_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "myrmidon_scope_agent_prefs_company_idx" ON "myrmidon_scope_agent_prefs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "myrmidon_scope_group_members_agent_idx" ON "myrmidon_scope_group_members" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "myrmidon_scope_groups_company_name_uq" ON "myrmidon_scope_groups" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "myrmidon_scope_settings_instance_uq" ON "myrmidon_scope_settings" USING btree ("company_id","scope_kind","scope_id");