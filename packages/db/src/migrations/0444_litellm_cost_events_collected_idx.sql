CREATE INDEX "litellm_cost_events_company_occurred_collected_idx" ON "litellm_cost_events" USING btree ("company_id","occurred_at") INCLUDE ("collected_at");
--> statement-breakpoint
DROP INDEX IF EXISTS "adm_tmp_lce_company_occurred_collected";