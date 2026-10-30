-- REMOTE-SITES-T4: site health state, replica-sourced moves, one unfinished move per bot.
ALTER TABLE "myrmidon_fleet_sites" ADD COLUMN "health" jsonb;
--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_moves" ADD COLUMN "source" text DEFAULT 'live' NOT NULL;
--> statement-breakpoint
UPDATE "myrmidon_fleet_moves" SET "phase" = 'failed', "error" = coalesce("error", 'superseded by a newer unfinished move (migration 0414)'), "updated_at" = now()
WHERE "id" IN (
	SELECT "id" FROM (
		SELECT "id", row_number() OVER (PARTITION BY "company_id", "bot_key" ORDER BY "started_at" DESC, "id" DESC) AS rn
		FROM "myrmidon_fleet_moves" WHERE "phase" NOT IN ('done', 'failed')
	) ranked WHERE ranked.rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX "myrmidon_fleet_moves_active_bot_uq" ON "myrmidon_fleet_moves" USING btree ("company_id","bot_key") WHERE "myrmidon_fleet_moves"."phase" NOT IN ('done', 'failed');
