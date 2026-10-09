-- 1.6.5 (F-27 PHEROMONE): the numeric pheromone strength of a task. The swarm
-- queue orders by it inside the P0 band; zero means "no scent". Existing rows
-- start at 0 — the historical behaviour (priority enum only) — and the owner
-- seeds a baseline from `priority` via the swarm settings mapping when needed.
ALTER TABLE "issues" ADD COLUMN "pheromone_strength" integer DEFAULT 0 NOT NULL;
