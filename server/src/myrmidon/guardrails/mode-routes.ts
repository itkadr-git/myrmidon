import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import { createGuardrailModeStore } from "./mode-store.js";
import { GUARDRAIL_LEVELS, GUARDRAIL_MODES, GUARDRAIL_RULES, type GuardrailLevel, type GuardrailMode, type GuardrailRule } from "./modes.js";

const writeSchema = z.object({ level: z.enum(GUARDRAIL_LEVELS), targetId: z.string().min(1).max(200), rule: z.enum(GUARDRAIL_RULES), mode: z.enum(GUARDRAIL_MODES) });

export function guardrailModeRoutes(db: Db) {
  const router = Router();
  const store = createGuardrailModeStore(db);
  router.get("/myrmidon/companies/:companyId/agents/:agentId/guardrails/modes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.params.agentId as string;
    const [agent] = await db.query.agents.findMany({ where: (table, { and, eq }) => and(eq(table.id, agentId), eq(table.companyId, companyId)), limit: 1 });
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json({ modes: await store.listEffective(companyId, agent.role, agentId) });
  });
  router.put("/myrmidon/companies/:companyId/guardrails/modes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const parsed = writeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid guardrail setting" });
    const { level, targetId, rule, mode } = parsed.data as { level: GuardrailLevel; targetId: string; rule: GuardrailRule; mode: GuardrailMode };
    if ((level === "company" && targetId !== companyId) || (level === "agent" && !(await db.query.agents.findMany({ where: (table, { and, eq }) => and(eq(table.id, targetId), eq(table.companyId, companyId)), limit: 1 })).length)) return res.status(400).json({ error: "Target does not belong to company" });
    res.json({ setting: await store.set(companyId, level, targetId, rule, mode) });
  });
  return router;
}
