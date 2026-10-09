-- myrmidon(1.6.5 F-26 T10 SCENT): the stored scent of tasks and agents
-- (design §7.1 п.4a).
--
--   issues.scent        jsonb — the one-time classification of the task:
--                       {tags[≤8], casteProbs{casteKey: p}, complexity
--                       {coordination, uncertainty, consequences}}. NULL =
--                       not classified yet (empty text or classifier down);
--                       the markup queue retries it within its hour budget.
--   issues.caste_source text — who set the caste: 'manual' (the caller),
--                       'project' (project default), 'auto' (the classifier),
--                       'default' (company default). NULL on rows that predate
--                       the column or never went through the hook.
--   agents.scent_tags   text[] NOT NULL DEFAULT '{}' — the agent's tags
--                       distilled from `capabilities`; an empty array is "not
--                       classified yet" (the queue skips an agent with empty
--                       capabilities without a call).
--   agents.scent_classified_at timestamptz — when the tags were last written
--                       (a manual refresh or the queue).
--   agents.model_tier   text NOT NULL DEFAULT 'light' — the personal override
--                       of the caste's model tier.
--   agent_castes.model_tier text NOT NULL DEFAULT 'light' — the caste default;
--                       the effective tier of an agent is the personal value
--                       when set, else the caste's (design §2.4).
--
-- Column ownership: `issues.caste_key`/`pheromone_strength` and
-- `projects.default_caste_key` belong to T2 (migrations 0382/0383);
-- `agent_castes.is_default` + the default-caste unique index belong to T3
-- (migration 0384). This migration only adds the §7.1 п.4a columns.

ALTER TABLE issues ADD COLUMN IF NOT EXISTS scent jsonb;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS caste_source text;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS scent_tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS scent_classified_at timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_tier text NOT NULL DEFAULT 'light';

ALTER TABLE agent_castes ADD COLUMN IF NOT EXISTS model_tier text NOT NULL DEFAULT 'light';
