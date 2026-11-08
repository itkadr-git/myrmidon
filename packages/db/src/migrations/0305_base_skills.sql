CREATE TABLE "company_base_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_base_skills" ADD CONSTRAINT "company_base_skills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_base_skills" ADD CONSTRAINT "company_base_skills_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_base_skills" ADD CONSTRAINT "company_base_skills_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_base_skills_company_skill_idx" ON "company_base_skills" USING btree ("company_id","skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_base_skills_company_key_idx" ON "company_base_skills" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "company_base_skills_company_created_idx" ON "company_base_skills" USING btree ("company_id","created_at");