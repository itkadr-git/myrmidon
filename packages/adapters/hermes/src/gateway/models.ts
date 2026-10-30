import type { AdapterModel } from "@myrmidon/adapter-utils";

export const GATEWAY_MODELS_CACHE_TTL_MS = 15_000;

interface CacheEntry {
  models: AdapterModel[];
  cachedAt: number;
}

let cache: CacheEntry | null = null;

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
  options: { forceRefresh?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<AdapterModel[]> {
  const now = Date.now();
  if (
    !options.forceRefresh &&
    cache &&
    now - cache.cachedAt < GATEWAY_MODELS_CACHE_TTL_MS
  ) {
    return cache.models;
  }

  const env = options.env ?? process.env;
  const baseUrl = resolveGatewayBaseUrl(env);
  if (!baseUrl) {
    return cache?.models ?? [];
  }

  const apiKey = resolveGatewayApiKey(env);
  try {
    const models = await fetchGatewayModels(baseUrl, apiKey);
    cache = { models, cachedAt: now };
    return models;
  } catch (err) {
    if (cache) {
      return cache.models;
    }
    return [];
  }
}

export async function refreshGatewayModels(): Promise<AdapterModel[]> {
  return listGatewayModels({ forceRefresh: true });
}

export function resetGatewayModelsCacheForTests(): void {
  cache = null;
}
