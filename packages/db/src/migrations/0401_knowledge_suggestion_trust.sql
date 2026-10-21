-- myrmidon(1.7-KNOWLEDGE-L5): retain trust provenance on knowledge proposals.
-- The 1.6.5 migration line now uses 0315 for foraging spend; 1.7 main's
-- current migration head is 0397, so this additive change takes the next slot.
ALTER TABLE "knowledge_suggestions" ADD COLUMN IF NOT EXISTS "trust" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_suggestions_trust_idx" ON "knowledge_suggestions" ("trust");
