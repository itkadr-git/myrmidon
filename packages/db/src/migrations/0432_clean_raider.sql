ALTER TABLE "knowledge_revisions" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD COLUMN "summary" text;--> statement-breakpoint
UPDATE "knowledge_revisions" r
SET "title" = k."title",
    "summary" = k."summary"
FROM "knowledge_items" k
WHERE r."item_id" = k."id" AND r."title" IS NULL;