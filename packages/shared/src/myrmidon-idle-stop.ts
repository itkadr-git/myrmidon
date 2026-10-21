import { z } from "zod";

export const idleStopSettingsSchema = z.object({
  enabled: z.boolean(),
  afterSec: z.number().int().min(60).max(31_536_000),
  healthTimeoutMs: z.number().int().min(1_000).max(600_000),
}).strict();

export type IdleStopSettings = z.infer<typeof idleStopSettingsSchema>;
export const patchIdleStopSettingsSchema = idleStopSettingsSchema.partial();
export type IdleStopSettingsPatch = z.infer<typeof patchIdleStopSettingsSchema>;
export const storedIdleStopSettingsSchema = idleStopSettingsSchema.partial().optional().catch(undefined);

const defaultIdleStopEnv: Record<string, string | undefined> = {};

export function normalizeIdleStopSettings(raw: unknown, env: Record<string, string | undefined> = defaultIdleStopEnv): IdleStopSettings {
  const parsed = storedIdleStopSettingsSchema.safeParse(raw);
  const stored = parsed.success ? parsed.data : undefined;
  const enabledEnv = env.MYRMIDON_IDLE_STOP_ENABLED?.trim().toLowerCase();
  return {
    enabled: stored?.enabled ?? (enabledEnv === undefined || !["false", "0", "no", "off"].includes(enabledEnv)),
    afterSec: stored?.afterSec ?? Number.parseInt(env.MYRMIDON_IDLE_STOP_AFTER_SEC || "1800", 10),
    healthTimeoutMs: stored?.healthTimeoutMs ?? Number.parseInt(env.MYRMIDON_IDLE_START_HEALTH_TIMEOUT_MS || "30000", 10),
  };
}

export function mergeIdleStopSettings(raw: unknown, patch: IdleStopSettingsPatch, env: Record<string, string | undefined> = defaultIdleStopEnv): IdleStopSettings {
  return idleStopSettingsSchema.parse({ ...normalizeIdleStopSettings(raw, env), ...patch });
}
export const idleStopModeSchema = z.enum(["on_demand", "always_on"]);
export type IdleStopMode = z.infer<typeof idleStopModeSchema>;

/** Mass change of the per-bot IDLE-STOP mode. */
export const patchIdleStopBotModesSchema = z.object({
  agentIds: z.array(z.string().uuid()).min(1).max(500),
  mode: idleStopModeSchema,
}).strict();
