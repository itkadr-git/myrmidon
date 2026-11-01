-- Preserve approved Paperclip migration fields without introducing their runtime behavior.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "appearance" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "title_needs_generation" boolean DEFAULT false NOT NULL;
