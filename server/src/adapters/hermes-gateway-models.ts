import type { Db } from "@myrmidon/db";
import { secretService } from "../services/secrets.js";
import type { AdapterModel } from "./types.js";

export const GATEWAY_MODELS_CACHE_TTL_MS = 15_000;

interface CacheEntry {
  models: AdapterModel[];
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

export interface GatewayModelsOptions {
  forceRefresh?: boolean;
  env?: NodeJS.ProcessEnv;
  companyId?: string;
  db?: Db;
}

async function resolveCatalogApiKey(env: NodeJS.ProcessEnv, options: GatewayModelsOptions): Promise<string | null> {
  const direct = resolveGatewayApiKey(env);
  if (direct) return direct;
  const names = [env.MYRMIDON_LITELLM_KEY_SECRET, env.MYRMIDON_LITELLM_ADMIN_KEY_SECRET]
    .map((name) => name?.trim()).filter((name): name is string => Boolean(name));
  if (names.length === 0) return null;
  if (!options.db || !options.companyId) throw new Error("Gateway catalog secrets require company context");
  const secrets = secretService(options.db);
  for (const name of names) {
    const row = await secrets.getByName(options.companyId, name);
    if (!row) continue;
    const value = (await secrets.resolveSecretValue(options.companyId, row.id, "latest")).trim();
    if (value) return value;
  }
  throw new Error("Gateway catalog key secret has no value");
}

export function resolveGatewayBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw =
    env.MYRMIDON_LITELLM_BASE_URL ??
    env.LITELLM_BASE_URL ??
    env.HERMES_GATEWAY_URL ??
    env.HERMES_API_BASE_URL;
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function resolveGatewayApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw =
    env.MYRMIDON_LITELLM_KEY ??
    env.MYRMIDON_LITELLM_API_KEY ??
    env.MYRMIDON_LITELLM_MASTER_KEY ??
    env.MYRMIDON_LITELLM_ADMIN_KEY ??
    env.LITELLM_MASTER_KEY ??
    env.LLM_GATEWAY_API_KEY ??
    env.OPENAI_API_KEY;
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

export function parseGatewayModelsResponse(data: unknown): AdapterModel[] {
  if (!data || typeof data !== "object") return [];
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { data?: unknown }).data)
      ? (data as { data: unknown[] }).data
      : Array.isArray((data as { models?: unknown }).models)
        ? (data as { models: unknown[] }).models
        : [];

  const seen = new Set<string>();
  const result: AdapterModel[] = [];

  for (const item of list) {
    if (!item) continue;
    let id: string | null = null;
    let label: string | null = null;
    if (typeof item === "string") {
      id = item.trim();
    } else if (typeof item === "object") {
      const obj = item as Record<string, unknown>;
      if (typeof obj.id === "string") id = obj.id.trim();
      else if (typeof obj.name === "string") id = obj.name.trim();
      else if (typeof obj.model === "string") id = obj.model.trim();

      if (typeof obj.label === "string" && obj.label.trim()) {
        label = obj.label.trim();
      } else if (typeof obj.display_name === "string" && obj.display_name.trim()) {
        label = obj.display_name.trim();
      } else if (typeof obj.name === "string" && obj.name.trim() && obj.name !== id) {
        label = obj.name.trim();
      }
    }
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push({ id, label: label ?? id });
    }
  }
  return result;
}

export async function fetchGatewayModels(
  baseUrl: string,
  apiKey: string | null,
  timeoutMs = 5000,
): Promise<AdapterModel[]> {
  const url = `${baseUrl}/v1/models`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`LLM gateway answered HTTP ${response.status} from ${url}`);
  }

  const json = await response.json();
  return parseGatewayModelsResponse(json);
}

export async function listGatewayModels(
  options: GatewayModelsOptions = {},
): Promise<AdapterModel[]> {
  const now = Date.now();
  const env = options.env ?? process.env;
  const baseUrl = resolveGatewayBaseUrl(env);
  const cacheKey = JSON.stringify([options.companyId ?? null, baseUrl]);
  const cached = cache.get(cacheKey);
  if (!options.forceRefresh && cached && now - cached.cachedAt < GATEWAY_MODELS_CACHE_TTL_MS) {
    return cached.models;
  }
  if (!baseUrl) {
    // A missing gateway URL means the live catalog could not be consulted at
    // all — a discovery failure, not an authoritative empty catalog. Throw so
    // the adapter registry falls back to PAPERCLIP_ADAPTER_MODELS / declared
    // models; an authoritative `[]` requires a successful HTTP response.
    throw new Error(
      "LLM gateway base URL is not configured (set MYRMIDON_LITELLM_BASE_URL or LITELLM_BASE_URL)",
    );
  }

  const apiKey = await resolveCatalogApiKey(env, options);
  try {
    const models = await fetchGatewayModels(baseUrl, apiKey);
    cache.set(cacheKey, { models, cachedAt: now });
    return models;
  } catch (error) {
    // A failed request is distinct from a successful empty catalog. Throw so
    // the adapter registry can use PAPERCLIP_ADAPTER_MODELS as its fallback;
    // an empty successful response remains authoritative for hermes_gateway.
    throw error;
  }
}

export async function refreshGatewayModels(): Promise<AdapterModel[]> {
  // Propagates the same failure semantics as listGatewayModels: a missing URL
  // or failed fetch throws instead of resolving to an authoritative `[]`.
  return listGatewayModels({ forceRefresh: true });
}

export function resetGatewayModelsCacheForTests(): void {
  cache.clear();
}
