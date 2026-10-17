ALTER TABLE "user_ui_language"
  ADD COLUMN "custom_catalogs" jsonb NOT NULL DEFAULT '{}'::jsonb;
