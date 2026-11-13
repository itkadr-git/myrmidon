-- myrmidon(1.8 AGENT-LIVENESS A1, OPE-13021): response-probe liveness on
-- agent_runtime_state. lastResponseAt is the last time the model actually
-- produced work (tokens spent or a model response started); lastProbeAt /
-- lastProbeOutcome record the process probe (the runtime's health endpoint).
-- Nullable: null = never probed / never answered. The derived honest status
-- (`answering` / `alive_but_not_answering` / `unreachable`) is computed at
-- read time (packages/shared/src/agent-liveness.ts), never stored.

ALTER TABLE "agent_runtime_state" ADD COLUMN "last_response_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD COLUMN "last_probe_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD COLUMN "last_probe_outcome" text;
