-- myrmidon(1.7 KNOWLEDGE L-6): language and canonical translation linkage.
ALTER TABLE "knowledge_revisions" ADD COLUMN "lang" text DEFAULT 'en' NOT NULL;
ALTER TABLE "knowledge_revisions" ADD COLUMN "translation_of" uuid;
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_translation_of_knowledge_revisions_id_fk"
  FOREIGN KEY ("translation_of") REFERENCES "public"."knowledge_revisions"("id") ON DELETE SET NULL;
CREATE INDEX "knowledge_revisions_translation_idx" ON "knowledge_revisions" USING btree ("translation_of");
