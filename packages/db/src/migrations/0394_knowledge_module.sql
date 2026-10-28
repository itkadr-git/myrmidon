CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE OR REPLACE FUNCTION knowledge_unaccent(txt text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT public.unaccent('unaccent'::regdictionary, coalesce(txt, '')) $$;--> statement-breakpoint
CREATE TABLE "knowledge_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"nest_id" uuid NOT NULL,
	"item_id" uuid,
	"revision_id" uuid,
	"event" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
;--> statement-breakpoint
CREATE TABLE "knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"nest_id" uuid NOT NULL,
	"kind" text DEFAULT 'note' NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"folder_path" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_required" boolean DEFAULT false NOT NULL,
	"approver_kind" text,
	"delivered_revision_id" uuid,
	"current_revision_number" integer DEFAULT 0 NOT NULL,
	"superseded_by_item_id" uuid,
	"created_by_agent_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
;--> statement-breakpoint
CREATE TABLE "knowledge_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"nest_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"target_slug" text NOT NULL,
	"resolved_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
;--> statement-breakpoint
CREATE TABLE "knowledge_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"nest_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"content" text NOT NULL,
	"change_summary" text,
	"rolled_back_from_revision_id" uuid,
	"approval_id" uuid,
	"approved_by_kind" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_by_agent_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
;--> statement-breakpoint
CREATE TABLE "knowledge_search" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"nest_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body" text DEFAULT '' NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, knowledge_unaccent(coalesce("title", '') || ' ' || coalesce("summary", '') || ' ' || coalesce("body", '')))) STORED,
	"body_trgm" text GENERATED ALWAYS AS (lower(coalesce("body", '') || ' ' || coalesce("title", ''))) STORED NOT NULL
);
;--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"nest_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
;--> statement-breakpoint
CREATE TABLE "knowledge_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"nest_id" uuid NOT NULL,
	"target_item_id" uuid,
	"body" text NOT NULL,
	"rationale" text,
	"source_kind" text,
	"source_ref" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by_agent_id" text,
	"created_by_user_id" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
;--> statement-breakpoint
ALTER TABLE "knowledge_events" ADD CONSTRAINT "knowledge_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_events" ADD CONSTRAINT "knowledge_events_nest_id_companies_id_fk" FOREIGN KEY ("nest_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_events" ADD CONSTRAINT "knowledge_events_item_id_knowledge_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_nest_id_companies_id_fk" FOREIGN KEY ("nest_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_links" ADD CONSTRAINT "knowledge_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_links" ADD CONSTRAINT "knowledge_links_nest_id_companies_id_fk" FOREIGN KEY ("nest_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_links" ADD CONSTRAINT "knowledge_links_source_item_id_knowledge_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_nest_id_companies_id_fk" FOREIGN KEY ("nest_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_item_id_knowledge_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_search" ADD CONSTRAINT "knowledge_search_item_id_knowledge_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_search" ADD CONSTRAINT "knowledge_search_nest_id_companies_id_fk" FOREIGN KEY ("nest_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_nest_id_companies_id_fk" FOREIGN KEY ("nest_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_revision_id_knowledge_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."knowledge_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_suggestions" ADD CONSTRAINT "knowledge_suggestions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_suggestions" ADD CONSTRAINT "knowledge_suggestions_nest_id_companies_id_fk" FOREIGN KEY ("nest_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_events_nest_created_idx" ON "knowledge_events" USING btree ("nest_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_events_item_created_idx" ON "knowledge_events" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_events_company_idx" ON "knowledge_events" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_items_nest_slug_uq" ON "knowledge_items" USING btree ("nest_id","slug");--> statement-breakpoint
CREATE INDEX "knowledge_items_nest_status_idx" ON "knowledge_items" USING btree ("nest_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_items_nest_kind_status_idx" ON "knowledge_items" USING btree ("nest_id","kind","status");--> statement-breakpoint
CREATE INDEX "knowledge_items_nest_folder_idx" ON "knowledge_items" USING btree ("nest_id","folder_path");--> statement-breakpoint
CREATE INDEX "knowledge_items_company_idx" ON "knowledge_items" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_links_source_target_uq" ON "knowledge_links" USING btree ("source_item_id","target_slug");--> statement-breakpoint
CREATE INDEX "knowledge_links_nest_target_idx" ON "knowledge_links" USING btree ("nest_id","resolved_item_id");--> statement-breakpoint
CREATE INDEX "knowledge_links_company_idx" ON "knowledge_links" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_revisions_item_revision_uq" ON "knowledge_revisions" USING btree ("item_id","revision_number");--> statement-breakpoint
CREATE INDEX "knowledge_revisions_nest_idx" ON "knowledge_revisions" USING btree ("nest_id");--> statement-breakpoint
CREATE INDEX "knowledge_revisions_company_idx" ON "knowledge_revisions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "knowledge_search_vector_idx" ON "knowledge_search" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "knowledge_search_trgm_idx" ON "knowledge_search" USING gin ("body_trgm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "knowledge_search_slug_trgm_idx" ON "knowledge_search" USING gin ("slug" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "knowledge_search_nest_idx" ON "knowledge_search" USING btree ("nest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_revision_source_uq" ON "knowledge_sources" USING btree ("revision_id","kind","ref");--> statement-breakpoint
CREATE INDEX "knowledge_sources_nest_idx" ON "knowledge_sources" USING btree ("nest_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_company_idx" ON "knowledge_sources" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "knowledge_suggestions_nest_status_idx" ON "knowledge_suggestions" USING btree ("nest_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_suggestions_company_idx" ON "knowledge_suggestions" USING btree ("company_id");
