-- myrmidon(1.6.6 KNOWLEDGE-2.0): knowledge_unaccent names its dictionary with the schema.
-- The 0313 body cast 'unaccent'::regdictionary unqualified; pg_dump/pg_restore run with an
-- empty search_path, so restoring a database that ran 0313 failed on CREATE TABLE
-- knowledge_search ("text search dictionary \"unaccent\" does not exist") — every backup
-- and the predeploy copy of 12.10 were not restorable. Same signature and result; for
-- databases created after the 0313 fix this is a no-op.
CREATE OR REPLACE FUNCTION knowledge_unaccent(txt text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, coalesce(txt, '')) $$;
