import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeYamlDocument, type YamlMapping } from "./deterministic-yaml.js";

export type PreparedOmpRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  /** The managed agent-config dir, or null when no provider config was written. */
  agentConfigDir: string | null;
  cleanup: () => Promise<void>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recursively replace {env:VAR} placeholders with the resolved value.
export function expandEnvPlaceholders<T>(value: T, resolve: (name: string) => string | undefined): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = resolve(name);
      return resolved !== undefined && resolved.length > 0 ? resolved : match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, resolve)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = expandEnvPlaceholders(entry, resolve);
    }
    return out as unknown as T;
  }
  return value;
}

type ParsedProviderConfig = {
  providers: Record<string, unknown> | null;
  warning: string | null;
};

export function parseProviderConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
): ParsedProviderConfig {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { providers: null, warning: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return {
        providers: null,
        warning: "PAPERCLIP_OMP_PROVIDERS is set but is not a JSON object; custom providers ignored.",
      };
    }
    const providers: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (isPlainObject(value)) providers[key] = expandEnvPlaceholders(value, resolveEnv);
      else skipped.push(key);
    }
    return {
      providers: Object.keys(providers).length > 0 ? providers : null,
      warning: skipped.length > 0
        ? `PAPERCLIP_OMP_PROVIDERS: skipped provider(s) with non-object values: ${skipped.join(", ")}.`
        : null,
    };
  } catch {
    return {
      providers: null,
      warning: "PAPERCLIP_OMP_PROVIDERS contains invalid JSON; custom providers ignored.",
    };
  }
}

// Materialize custom OMP providers supplied via PAPERCLIP_OMP_PROVIDERS (or PAPERCLIP_PI_PROVIDERS)
// into a managed models.yml inside agent config dir ($PI_CODING_AGENT_DIR).
export async function prepareOmpRuntimeConfig(input: {
  env: Record<string, string>;
}): Promise<PreparedOmpRuntimeConfig> {
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const rawConfig =
    input.env.PAPERCLIP_OMP_PROVIDERS ??
    process.env.PAPERCLIP_OMP_PROVIDERS ??
    input.env.PAPERCLIP_PI_PROVIDERS ??
    process.env.PAPERCLIP_PI_PROVIDERS;

  const { providers, warning } = parseProviderConfig(rawConfig, resolveEnv);
  if (!providers) {
    return {
      env: input.env,
      notes: warning ? [warning] : [],
      agentConfigDir: null,
      cleanup: async () => {},
    };
  }

  const agentConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-omp-agent-config-"));
  try {
    const yamlContent = writeYamlDocument({ providers: providers as YamlMapping });
    await fs.writeFile(
      path.join(agentConfigDir, "models.yml"),
      yamlContent,
      "utf8",
    );
  } catch (err) {
    await fs.rm(agentConfigDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return {
    env: {
      ...input.env,
      PI_CODING_AGENT_DIR: agentConfigDir,
      OMP_CODING_AGENT_DIR: agentConfigDir,
    },
    notes: [
      ...(warning ? [warning] : []),
      `Injected ${Object.keys(providers).length} custom OMP provider(s) into a managed models.yml: ${Object.keys(providers).join(", ")}.`,
    ],
    agentConfigDir,
    cleanup: async () => {
      await fs.rm(agentConfigDir, { recursive: true, force: true });
    },
  };
}
