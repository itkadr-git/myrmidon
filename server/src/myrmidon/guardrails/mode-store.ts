import { and, eq } from "drizzle-orm";
import { guardrailModeSettings, type Db } from "@paperclipai/db";
import { GUARDRAIL_LEVELS, GUARDRAIL_RULES, guardrailModeSchema, resolveGuardrailMode, type GuardrailLevel, type GuardrailOverride, type GuardrailRule, type EffectiveGuardrailMode } from "./modes.js";

const CACHE_TTL_MS = 5_000;

export function createGuardrailModeStore(db: Db) {
  const cache = new Map<string, { expiresAt: number; value: EffectiveGuardrailMode[] }>();
  const invalidate = (companyId: string) => {
    for (const key of cache.keys()) if (key.startsWith(`${companyId}:`)) cache.delete(key);
  };
  async function overrides(companyId: string): Promise<GuardrailOverride[]> {
    const rows = await db.select().from(guardrailModeSettings).where(eq(guardrailModeSettings.companyId, companyId));
    return rows.filter((row) =>
      GUARDRAIL_LEVELS.includes(row.level as GuardrailLevel) &&
      GUARDRAIL_RULES.includes(row.rule as GuardrailRule) &&
      guardrailModeSchema.safeParse({ rule: row.rule, mode: row.mode }).success,
    ).map((row) => ({ level: row.level as GuardrailLevel, targetId: row.targetId, rule: row.rule as GuardrailRule, mode: row.mode as GuardrailOverride["mode"] }));
  }
  return {
    async listEffective(companyId: string, casteKey: string, agentId: string) {
      const cacheKey = `${companyId}:${casteKey}:${agentId}`;
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      const all = await overrides(companyId);
      const scoped = all.filter((row) =>
        (row.level === "company" && row.targetId === companyId) ||
        (row.level === "caste" && row.targetId === casteKey) ||
        (row.level === "agent" && row.targetId === agentId),
      );
      const value = GUARDRAIL_RULES.map((rule) => {
        const candidates = scoped.filter((row) => row.rule === rule);
        return resolveGuardrailMode(rule, candidates);
      });
      cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
      return value;
    },
    async set(companyId: string, level: GuardrailLevel, targetId: string, rule: GuardrailRule, mode: GuardrailOverride["mode"]) {
      if (!guardrailModeSchema.safeParse({ rule, mode }).success) throw new Error("Invalid guardrail rule or mode");
      const [row] = await db.insert(guardrailModeSettings).values({ companyId, level, targetId, rule, mode })
        .onConflictDoUpdate({ target: [guardrailModeSettings.companyId, guardrailModeSettings.level, guardrailModeSettings.targetId, guardrailModeSettings.rule], set: { mode, updatedAt: new Date() } }).returning();
      invalidate(companyId);
      return row;
    },
    async remove(companyId: string, level: GuardrailLevel, targetId: string, rule: GuardrailRule) {
      await db.delete(guardrailModeSettings).where(and(eq(guardrailModeSettings.companyId, companyId), eq(guardrailModeSettings.level, level), eq(guardrailModeSettings.targetId, targetId), eq(guardrailModeSettings.rule, rule)));
      invalidate(companyId);
    },
    invalidate,
  };
}
