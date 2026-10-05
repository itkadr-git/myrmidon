import { z } from "zod";

/**
 * Agent memory (card Memory tab) instance setting.
 *
 * Stored in `instance_settings.general.agentMemory`, changed from the instance
 * settings page and `PATCH /api/myrmidon/agent-memory`. Every field is
 * optional; the server re-reads the row on every request, so a change applies
 * without a restart.
 *
 * Precedence of the service address: this setting, then
 * `MYRMIDON_HINDSIGHT_API_URL`, then `MYRMIDON_BOT_HINDSIGHT_API_URL` (the same
 * service as seen by the bots). The API key is optional: a service without
 * authentication needs none, and the key is sent only when a secret name is
 * set (this setting, then `MYRMIDON_HINDSIGHT_KEY_SECRET`).
 */
export const AGENT_MEMORY_SETTINGS_KEY = "agentMemory";

export interface AgentMemorySettings {
  /** `false` switches the section off even when an address is configured. */
  enabled?: boolean;
  /** Base address of the memory service (`http(s)://…`). */
  apiUrl?: string;
  /** Name of the company secret holding the service API key. */
  keySecretName?: string;
}

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "Enter an http(s):// address");

export const agentMemorySettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    apiUrl: httpUrl.optional(),
    keySecretName: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

/** Body of `PATCH /api/myrmidon/agent-memory`: `null` clears a field. */
export const patchAgentMemorySettingsSchema = z
  .object({
    enabled: z.boolean().nullable().optional(),
    apiUrl: httpUrl.nullable().optional(),
    keySecretName: z.string().trim().min(1).max(256).nullable().optional(),
  })
  .strict();

export type PatchAgentMemorySettings = z.infer<typeof patchAgentMemorySettingsSchema>;

/**
 * Lenient read of a stored value: unknown shapes and invalid fields are
 * dropped one by one, never thrown, so a damaged row cannot take the agent
 * page down.
 */
export function normalizeAgentMemorySettings(raw: unknown): AgentMemorySettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const out: AgentMemorySettings = {};
  if (typeof value.enabled === "boolean") out.enabled = value.enabled;
  const apiUrl = httpUrl.safeParse(value.apiUrl);
  if (apiUrl.success) out.apiUrl = apiUrl.data;
  const key = z.string().trim().min(1).max(256).safeParse(value.keySecretName);
  if (key.success) out.keySecretName = key.data;
  return out;
}

/** Apply a PATCH body to stored settings: `null` removes the field. */
export function applyAgentMemoryPatch(
  stored: AgentMemorySettings,
  patch: PatchAgentMemorySettings,
): AgentMemorySettings {
  const next: Record<string, unknown> = { ...stored };
  for (const key of ["enabled", "apiUrl", "keySecretName"] as const) {
    if (patch[key] === undefined) continue;
    if (patch[key] === null) delete next[key];
    else next[key] = patch[key];
  }
  return next as AgentMemorySettings;
}
