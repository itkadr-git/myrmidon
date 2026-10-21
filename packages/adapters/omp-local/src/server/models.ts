import { createHash } from "node:crypto";
import type { AdapterModel } from "@myrmidonai/adapter-utils";
import { asString, runChildProcess } from "@myrmidonai/adapter-utils/server-utils";

const MODELS_CACHE_TTL_MS = 60_000;

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

const IGNORED_MODEL_HEADINGS = new Set([
  "provider",
  "model",
  "context",
  "max-out",
  "warn",
  "warning",
  "info",
  "error",
  "debug",
  "notice",
  "note",
]);

const VALID_PROVIDER_RE = /^[a-zA-Z0-9_-]+$/;
const VALID_MODEL_RE = /^[a-zA-Z0-9._:/-]+$/;

export function parseModelsOutput(output: string): AdapterModel[] {
  // First attempt: JSON parse
  try {
    const trimmed = output.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const parsed = JSON.parse(trimmed) as { models?: Array<{ provider?: string; id?: string; selector?: string }> };
      if (Array.isArray(parsed.models)) {
        return parsed.models
          .map((m) => {
            const id = m.selector || (m.provider && m.id ? `${m.provider}/${m.id}` : m.id || "");
            return id ? { id, label: id } : null;
          })
          .filter((m): m is AdapterModel => m !== null);
      }
    }
  } catch {
    // Fall through to text parsing
  }

  // Second attempt: parse table / lines
  const parsed: AdapterModel[] = [];
  const lines = output.split(/\r?\n/);

  let currentProvider: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Check for provider heading, e.g. "openai (12)" or bold/colored provider
    const providerHeaderMatch = /^([a-zA-Z0-9._-]+)\s*\(\d+\)$/.exec(line);
    if (providerHeaderMatch) {
      currentProvider = providerHeaderMatch[1];
      continue;
    }

    // Skip table header / border lines
    if (line.startsWith("┌") || line.startsWith("├") || line.startsWith("└") || line.startsWith("|---") || line.startsWith("+---")) {
      continue;
    }
    if (line.includes("model") && (line.includes("context") || line.includes("max-out") || line.includes("provider"))) {
      continue;
    }

    // Columnar line: "provider   model   context..." or inside box table "| model_id | context |..."
    if (line.startsWith("│") || line.startsWith("|")) {
      const cells = line.split(/[│|]/).map((c) => c.trim()).filter(Boolean);
      if (cells.length > 0 && currentProvider) {
        const modelName = cells[0];
        if (
          modelName &&
          !IGNORED_MODEL_HEADINGS.has(modelName.toLowerCase()) &&
          VALID_MODEL_RE.test(modelName)
        ) {
          const id = modelName.includes("/") ? modelName : `${currentProvider}/${modelName}`;
          parsed.push({ id, label: id });
        }
      }
      continue;
    }

    // Free columnar format: "provider   model   ..."
    const parts = line.split(/\s{2,}/);
    if (parts.length >= 2) {
      const provider = parts[0].trim();
      const model = parts[1].trim();
      if (
        provider &&
        model &&
        VALID_PROVIDER_RE.test(provider) &&
        VALID_MODEL_RE.test(model) &&
        !IGNORED_MODEL_HEADINGS.has(provider.toLowerCase()) &&
        !IGNORED_MODEL_HEADINGS.has(model.toLowerCase())
      ) {
        const id = model.includes("/") ? model : `${provider}/${model}`;
        parsed.push({ id, label: id });
        continue;
      }
    }

    // Single model id with provider prefix, e.g. "openai/gpt-4o"
    if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/.test(line)) {
      const [prov, mod] = line.split("/");
      if (
        !IGNORED_MODEL_HEADINGS.has(prov.toLowerCase()) &&
        !IGNORED_MODEL_HEADINGS.has(mod.toLowerCase())
      ) {
        parsed.push({ id: line, label: line });
      }
    }
  }

  return parsed;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function resolveOmpCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_OMP_COMMAND === "string" &&
    process.env.PAPERCLIP_OMP_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_OMP_COMMAND.trim()
      : "omp";
  return asString(input, envOverride);
}

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID"]);

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(command: string, cwd: string, env: Record<string, string>) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${cwd}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }
}

export async function discoverOmpModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOmpCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const runtimeEnv = normalizeEnv({ ...process.env, ...env });

  // First try `omp models ls --json`
  let result = await runChildProcess(
    `omp-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["models", "ls", "--json"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: 20,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  // Fallback to `omp models ls` without --json if --json failed
  if ((result.exitCode ?? 1) !== 0 && !result.timedOut) {
    result = await runChildProcess(
      `omp-models-fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      ["models", "ls"],
      {
        cwd,
        env: runtimeEnv,
        timeoutSec: 20,
        graceSec: 3,
        onLog: async () => {},
      },
    );
  }

  if (result.timedOut) {
    throw new Error("`omp models ls` timed out.");
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`omp models ls\` failed: ${detail}` : "`omp models ls` failed.");
  }

  const output = result.stdout.trim() ? result.stdout : "";
  return sortModels(dedupeModels(parseModelsOutput(output)));
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export async function discoverOmpModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOmpCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverOmpModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export async function ensureOmpModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = asString(input.model, "").trim();
  if (!model) {
    throw new Error("OMP requires `adapterConfig.model` in provider/model format.");
  }

  const models = await discoverOmpModelsCached({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
  });

  if (models.length === 0) {
    throw new Error("OMP returned no models. Run `omp models ls` and verify provider auth.");
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured OMP model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

export async function listOmpModels(): Promise<AdapterModel[]> {
  try {
    return await discoverOmpModelsCached();
  } catch {
    return [];
  }
}

export function resetOmpModelsCacheForTests() {
  discoveryCache.clear();
}
