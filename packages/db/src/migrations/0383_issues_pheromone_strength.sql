-- 1.6.5 (F-27 PHEROMONE): the numeric pheromone strength of a task. The swarm
-- queue orders by it inside the P0 band; zero means "no scent". The column
-- lands with DEFAULT 0, so existing rows start at 0 here — migration 0384
-- (the next one) backfills the rows still at 0 from `priority` by the default
-- mapping (critical 100 / high 30 / medium 10 / low 1), the same numbers the
-- `pheromone` swarm settings seed new tasks with.
ALTER TABLE "issues" ADD COLUMN "pheromone_strength" integer DEFAULT 0 NOT NULL;
