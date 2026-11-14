import {
  DEFAULT_AGENT_LIVENESS_SETTINGS,
  resolveAgentLivenessSettings as resolveSharedAgentLivenessSettings,
  type AgentLivenessSettings,
} from "@myrmidon/shared";
import type { Db } from "@myrmidon/db";
import { instanceSettingsService } from "../../services/instance-settings.js";

/** Default TTL for in-memory settings cache (30 seconds). */
export const AGENT_LIVENESS_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  settings: AgentLivenessSettings;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function clearAgentLivenessSettingsCache(companyId?: string | null): void {
  if (companyId) {
    cache.delete(companyId);
  } else {
    cache.clear();
  }
}

export interface ResolveAgentLivenessOptions {
  db?: Db | null;
  bypassCache?: boolean;
  ttlMs?: number;
  now?: number;
}

/**
 * Resolves effective agent-liveness settings for a company/instance.
 * Caches settings in memory with TTL and supports cache invalidation on applier events.
 * Falls back to default settings without DB access or on DB errors.
 */
export async function resolveAgentLivenessSettings(
  companyId?: string | null,
  options: ResolveAgentLivenessOptions = {},
): Promise<AgentLivenessSettings> {
  const key = companyId || "__default__";
  const now = options.now ?? Date.now();

  if (!options.bypassCache) {
    const entry = cache.get(key);
    if (entry && entry.expiresAt > now) {
      return entry.settings;
    }
  }

  const db = options.db;
  if (!db) {
    return DEFAULT_AGENT_LIVENESS_SETTINGS;
  }

  let settings: AgentLivenessSettings;
  try {
    const general = (await instanceSettingsService(db).getGeneral()) as unknown as Record<string, unknown>;
    settings = resolveSharedAgentLivenessSettings(general.agentLiveness);
  } catch {
    settings = DEFAULT_AGENT_LIVENESS_SETTINGS;
  }

  const ttlMs = options.ttlMs ?? AGENT_LIVENESS_CACHE_TTL_MS;
  cache.set(key, {
    settings,
    expiresAt: now + ttlMs,
  });

  return settings;
}
