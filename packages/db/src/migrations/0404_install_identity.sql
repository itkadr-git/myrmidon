-- myrmidon(OPE-8836): the permanent installation id of the board. One row,
-- written once by the first start (ON CONFLICT DO NOTHING) and never updated.
CREATE TABLE IF NOT EXISTS "myrmidon_install_identity" (
	"singleton_key" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"install_id" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
