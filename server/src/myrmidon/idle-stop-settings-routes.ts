import { Router } from "express";
import type { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, type Db } from "@myrmidon/db";
import { instanceSettingsService } from "../services/instance-settings.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../routes/authz.js";
import { validate } from "../middleware/validate.js";
import { agentService } from "../services/agents.js";
import { botKeyForAgent } from "./bot-containers/agent-config.js";
import { getBotContainerRuntime } from "./bot-containers/routes-wiring.js";
import { idleStopRuntimeFromStatus } from "./idle-stop-runtime.js";
import { idleStopSettingsSchema, patchIdleStopSettingsSchema, normalizeIdleStopSettings, mergeIdleStopSettings, patchIdleStopBotModesSchema } from "@myrmidon/shared";

export function idleStopSettingsRoutes(db: Db, invalidateConfigCache?: () => void) {
  const router = Router();
  const settings = instanceSettingsService(db) as unknown as { getGeneral(): Promise<{ idleStop?: unknown }>; updateGeneral(patch: { idleStop: unknown }): Promise<unknown> };
  router.get("/myrmidon/idle-stop", async (req, res) => {
    assertBoardOrgAccess(req);
    const general = await settings.getGeneral();
    res.json({ settings: normalizeIdleStopSettings(general.idleStop, process.env), stored: general.idleStop ?? null });
  });
  router.patch("/myrmidon/idle-stop", validate(patchIdleStopSettingsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const general = await settings.getGeneral();
    const next = mergeIdleStopSettings(general.idleStop, req.body, process.env);
    const parsed = idleStopSettingsSchema.parse(next);
    await settings.updateGeneral({ idleStop: parsed });
    invalidateConfigCache?.();
    res.json({ settings: parsed, stored: parsed });
  });

  // Per-bot mode, as a list: every container bot with its mode and container state.
  router.get("/myrmidon/idle-stop/bots", async (req, res) => {
    assertInstanceAdmin(req);
    const rows = await db
      .select({ id: agents.id, name: agents.name, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(containerBotFilter());
    const runtime = getBotContainerRuntime();
    const bots = [];
    for (let i = 0; i < rows.length; i += 8) {
      const chunk = rows.slice(i, i + 8);
      bots.push(
        ...(await Promise.all(
          chunk.map(async (row) => {
            const container = (row.adapterConfig as { container?: { idleStopMode?: unknown } } | null)?.container;
            const bot = {
              agentId: row.id,
              name: row.name,
              mode: container?.idleStopMode === "always_on" ? ("always_on" as const) : ("on_demand" as const),
              state: null as string | null,
              idleStopped: false,
              lastStoppedAt: null as string | null,
              lastStartedAt: null as string | null,
            };
            const botKey = botKeyForAgent(row.id);
            if (runtime && botKey) {
              try {
                const status = await runtime.driver.status(botKey);
                const times = idleStopRuntimeFromStatus(status);
                bot.state = status.state;
                bot.idleStopped = times.idleStopped;
                bot.lastStoppedAt = times.lastStoppedAt?.toISOString() ?? null;
                bot.lastStartedAt = times.lastStartedAt?.toISOString() ?? null;
              } catch {
                // the container state stays unknown for this bot
              }
            }
            return bot;
          }),
        )),
      );
    }
    bots.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ bots });
  });

  // Mass mode change: takes effect on the next sweep, no restart and no container recreate.
  router.patch("/myrmidon/idle-stop/bots", validate(patchIdleStopBotModesSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const { agentIds, mode } = req.body as z.infer<typeof patchIdleStopBotModesSchema>;
    const eligible = await db
      .select({ id: agents.id, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(and(inArray(agents.id, agentIds), containerBotFilter()));
    const svc = agentService(db);
    for (const row of eligible) {
      const config = (row.adapterConfig ?? {}) as Record<string, unknown>;
      const container = { ...((config.container as Record<string, unknown> | undefined) ?? {}), idleStopMode: mode };
      await svc.update(row.id, { adapterConfig: { ...config, container } });
    }
    const updated = new Set(eligible.map((row) => row.id));
    res.json({ updated: eligible.length, skipped: agentIds.filter((id) => !updated.has(id)), mode });
  });
  return router;
}

function containerBotFilter() {
  return and(
    eq(agents.adapterType, "hermes_gateway"),
    sql`${agents.status} != 'terminated'`,
    sql`${agents.adapterConfig} #> '{container,enabled}' = 'true'::jsonb`,
  );
}