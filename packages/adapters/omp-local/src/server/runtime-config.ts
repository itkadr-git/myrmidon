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

// myrmidon(REBRAND-C): the omp adapter is ours, so its variable is named
// MYRMIDON_OMP_PROVIDERS. PAPERCLIP_OMP_PROVIDERS (the name it shipped with by
// mistake) stays a deprecated alias for one release; MYRMIDON_PI_PROVIDERS /
// PAPERCLIP_PI_PROVIDERS (the pi adapter's variable) remain the fallback.
export const OMP_PROVIDERS_ENV = "MYRMIDON_OMP_PROVIDERS";
const PROVIDER_ENV_NAMES = [
  ["MYRMIDON_OMP_PROVIDERS", "PAPERCLIP_OMP_PROVIDERS"],
  ["MYRMIDON_PI_PROVIDERS", "PAPERCLIP_PI_PROVIDERS"],
] as const;

type ParsedProviderConfig = {
  providers: Record<string, unknown> | null;
  warning: string | null;
};

export function parseProviderConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
  sourceName: string = OMP_PROVIDERS_ENV,
): ParsedProviderConfig {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { providers: null, warning: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return {
        providers: null,
        warning: `${sourceName} is set but is not a JSON object; custom providers ignored.`,
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
        ? `${sourceName}: skipped provider(s) with non-object values: ${skipped.join(", ")}.`
        : null,
    };
  } catch {
    return {
      providers: null,
      warning: `${sourceName} contains invalid JSON; custom providers ignored.`,
    };
  }
}

/**
 * Finds the provider configuration: the run env before the process env, the
 * MYRMIDON_* name before its PAPERCLIP_* alias. Returns the name it was read
 * from so warnings point at the variable the operator actually set.
 */
export function findProviderConfig(
  env: Record<string, string | undefined>,
  processEnv: Record<string, string | undefined> = process.env,
): { name: string; raw: string } | null {
  for (const names of PROVIDER_ENV_NAMES) {
    for (const source of [env, processEnv]) {
      for (const name of names) {
        const raw = source[name];
        if (raw !== undefined) return { name, raw };
      }
    }
  }
  return null;
}

// myrmidon(OPE-12805): omp settings every board-managed run starts with.
//
// omp 18.9.2 ships `launch.enabled: true`. With it the `bash` tool schema gains
// the service-launch fields `name` and `ready`, and a call that carries a
// non-blank `name` is a service launch: omp rejects it when `timeout` or
// `async` is also present ("Service mode does not accept async or timeout; use
// ready.timeout for readiness."). Models that fill every optional field of a
// tool schema (seen on the engineers' fallback model: `name`, `timeout: 30`,
// `ready: {host: "", log: "", port: 0, timeout: 0}` on every call) therefore
// had every shell command rejected. Board runs are one-shot `omp -p` runs and
// do not supervise long-lived services, so the feature is switched off: omp
// then offers `bash` without `name` and `ready`.
export const OMP_MANAGED_SETTINGS_FILE = "config.yml";
export const OMP_MANAGED_SETTINGS: YamlMapping = {
  launch: { enabled: false },
};

// Write the managed omp settings into an agent config dir the board owns
// (never into a user's own ~/.omp/agent).
export async function writeOmpManagedSettings(agentConfigDir: string): Promise<void> {
  await fs.writeFile(
    path.join(agentConfigDir, OMP_MANAGED_SETTINGS_FILE),
    writeYamlDocument(OMP_MANAGED_SETTINGS),
    "utf8",
  );
}

// Materialize custom OMP providers supplied via MYRMIDON_OMP_PROVIDERS (or the
// pi fallback, see PROVIDER_ENV_NAMES) into a managed models.yml inside agent
// config dir ($PI_CODING_AGENT_DIR).
export async function prepareOmpRuntimeConfig(input: {
  env: Record<string, string>;
}): Promise<PreparedOmpRuntimeConfig> {
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const source = findProviderConfig(input.env);
  const aliasNote = source && source.name.startsWith("PAPERCLIP_")
    ?`${source.name} is a deprecated alias of MYRMIDON_${source.name.slice("PAPERCLIP_".length)}; rename it in the agent environment.`
    : null;

  const { providers, warning } = parseProviderConfig(source?.raw, resolveEnv, source?.name);
  const leadingNotes = [...(aliasNote ? [aliasNote] : []), ...(warning ? [warning] : [])];
  if (!providers) {
    return {
      env: input.env,
      notes: leadingNotes,
      agentConfigDir: null,
      cleanup: async () => {},
    };
  }

  const agentConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-omp-agent-config-"));
  try {
    const yamlContent = writeYamlDocument({ providers: providers as YamlMapping });
    await fs.writeFile(
      path.join(agentConfigDir, "models.yml"),
      yamlContent,
      "utf8",
    );
    await writeOmpManagedSettings(agentConfigDir);
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
      ...leadingNotes,
      `Injected ${Object.keys(providers).length} custom OMP provider(s) into a managed models.yml: ${Object.keys(providers).join(", ")}.`,
    ],
    agentConfigDir,
    cleanup: async () => {
      await fs.rm(agentConfigDir, { recursive: true, force: true });
    },
  };
}
