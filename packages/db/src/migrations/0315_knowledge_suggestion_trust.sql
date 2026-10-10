-- myrmidon(1.7-KNOWLEDGE-L5): foraging findings become knowledge proposals
-- (L-5). The link is the suggestion itself: `candidate_ref` now carries the id
-- of the `knowledge_suggestions` row the port created, and every suggestion the
-- forager proposes is external by construction — its only source is a foreign
-- url. `trust` marks that on the row (the §2.2 trust=external of the
-- architecture), so the review side can filter external provenance without
-- parsing `source_ref`.
ALTER TABLE "knowledge_suggestions" ADD COLUMN IF NOT EXISTS "trust" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_suggestions_trust_idx" ON "knowledge_suggestions" ("trust");