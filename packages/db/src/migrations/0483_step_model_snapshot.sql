-- myrmidon(1.8 MODEL-BY-STEP / OPE-12998): per-run model decision snapshot.
-- The run resolves its model once at start (caste rule > company rule > the
-- agent's effective model) and persists the decision; no run changes its model
-- mid-flight. Additive columns only, backfill-free: existing rows keep NULL,
-- which readers treat as "resolved before this feature".

ALTER TABLE "heartbeat_runs" ADD COLUMN "step_class" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "step_model_group" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "step_model" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "step_model_reason" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "step_model_snapshot_json" jsonb;

-- myrmidon(1.8 MODEL-BY-STEP / OPE-12998): per-caste override of the company
-- step-class -> model rule document (written by the settings surface, read
-- permissively by the run-start resolver).
ALTER TABLE "agent_castes" ADD COLUMN "step_model_rules" jsonb;
