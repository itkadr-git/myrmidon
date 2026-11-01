CREATE TABLE "knowledge_deviations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"nest_id" uuid NOT NULL,
	"page" text NOT NULL,
	"was" text NOT NULL,
	"became" text NOT NULL,
	"how_verified" text NOT NULL,
	"task" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by_agent_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_deviations" ADD CONSTRAINT "knowledge_deviations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_deviations" ADD CONSTRAINT "knowledge_deviations_nest_id_companies_id_fk" FOREIGN KEY ("nest_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_deviations_company_idx" ON "knowledge_deviations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "knowledge_deviations_nest_idx" ON "knowledge_deviations" USING btree ("nest_id");--> statement-breakpoint
CREATE INDEX "knowledge_deviations_page_idx" ON "knowledge_deviations" USING btree ("page");--> statement-breakpoint
CREATE INDEX "knowledge_deviations_task_idx" ON "knowledge_deviations" USING btree ("task");--> statement-breakpoint
CREATE INDEX "knowledge_deviations_nest_created_at_idx" ON "knowledge_deviations" USING btree ("nest_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_deviations_nest_status_idx" ON "knowledge_deviations" USING btree ("nest_id","status");
