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

export const HINDSIGHT_ROLES = ["write", "summarize", "search"] as const;
export type HindsightRole = (typeof HINDSIGHT_ROLES)[number];

export interface HindsightModelsConfig {
  write?: string;
  summarize?: string;
  search?: string;
}

export const DEFAULT_HINDSIGHT_MODELS: Record<HindsightRole, string> = {
  write: "gpt-4o-mini",
  summarize: "gpt-4o-mini",
  search: "gpt-4o-mini",
};

export const HINDSIGHT_ROLE_META: Record<
  HindsightRole,
  {
    role: HindsightRole;
    group: string;
    name: string;
    description: string;
    defaultModel: string;
  }
> = {
  write: {
    role: "write",
    group: "hindsight-write",
    name: "Hindsight Write (память: запись)",
    description: "Извлечение фактов, связывание сущностей и сохранение воспоминаний (retention).",
    defaultModel: "gpt-4o-mini",
  },
  summarize: {
    role: "summarize",
    group: "hindsight-summarize",
    name: "Hindsight Summarize (память: сведение)",
    description: "Сведение разрозненных фактов и периодическая консолидация памяти (consolidation).",
    defaultModel: "gpt-4o-mini",
  },
  search: {
    role: "search",
    group: "hindsight-search",
    name: "Hindsight Search (память: поиск)",
    description: "Семантический поиск, генерация запросов воспоминания и ранжирование (recall / search).",
    defaultModel: "gpt-4o-mini",
  },
};

export interface HindsightModelGroupView {
  role: HindsightRole;
  group: string;
  name: string;
  description: string;
  model: string;
  defaultModel: string;
  source: "setting" | "default";
  updatedAt?: string | null;
}

export interface HindsightApiLimitations {
  runtimeDependency: "OPE-9469";
  summary: string;
  items: string[];
}

export interface HindsightModelCatalogView {
  groups: HindsightModelGroupView[];
  limitations: HindsightApiLimitations;
  status: "mock_stored" | "ready";
  hotReloadDependency: "OPE-9469";
  hotReloadAvailable: boolean;
}

export const HINDSIGHT_API_LIMITATIONS = [
  "Hot-reload in running Hindsight container depends on OPE-9469: configurations are saved in board settings without restart, but live container hot-reload requires the Hindsight reload API.",
  "No secret or environment variable mutation: provider API keys and secrets cannot be edited through this interface and are managed securely via company secrets.",
  "Vector embedding model compatibility: changing the search model on existing memory banks requires re-indexing, as embeddings from different models are mathematically incompatible.",
  "Catalog availability: selected models must be configured in LiteLLM router groups or active provider endpoints.",
  "Immediate board persistence: changes persist in instance settings and take effect immediately on subsequent reads without restarting the Myrmidon server.",
] as const;

export interface AgentMemorySettings {
  /** `false` switches the section off even when an address is configured. */
  enabled?: boolean;
  /** Base address of the memory service (`http(s)://…`). */
  apiUrl?: string;
  /** Name of the company secret holding the service API key. */
  keySecretName?: string;
  /** Configured models for Hindsight roles (write, summarize, search). */
  hindsightModels?: HindsightModelsConfig;
  writeModel?: string;
  summarizeModel?: string;
  searchModel?: string;
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

const modelNameSchema = z.string().trim().min(1).max(256);

export const hindsightModelsSchema = z
  .object({
    write: modelNameSchema.optional(),
    summarize: modelNameSchema.optional(),
    search: modelNameSchema.optional(),
  })
  .strict();

export const patchHindsightModelsSchema = z
  .object({
    role: z.enum(HINDSIGHT_ROLES).optional(),
    model: modelNameSchema.optional(),
    write: modelNameSchema.nullable().optional(),
    summarize: modelNameSchema.nullable().optional(),
    search: modelNameSchema.nullable().optional(),
    models: z
      .object({
        write: modelNameSchema.nullable().optional(),
        summarize: modelNameSchema.nullable().optional(),
        search: modelNameSchema.nullable().optional(),
      })
      .optional(),
  })
  .strict();

export type PatchHindsightModels = z.infer<typeof patchHindsightModelsSchema>;

export const agentMemorySettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    apiUrl: httpUrl.optional(),
    keySecretName: z.string().trim().min(1).max(256).optional(),
    hindsightModels: hindsightModelsSchema.optional(),
    writeModel: modelNameSchema.optional(),
    summarizeModel: modelNameSchema.optional(),
    searchModel: modelNameSchema.optional(),
  })
  .strict();

/** Body of `PATCH /api/myrmidon/agent-memory`: `null` clears a field. */
export const patchAgentMemorySettingsSchema = z
  .object({
    enabled: z.boolean().nullable().optional(),
    apiUrl: httpUrl.nullable().optional(),
    keySecretName: z.string().trim().min(1).max(256).nullable().optional(),
    hindsightModels: z
      .object({
        write: modelNameSchema.nullable().optional(),
        summarize: modelNameSchema.nullable().optional(),
        search: modelNameSchema.nullable().optional(),
      })
      .nullable()
      .optional(),
    writeModel: modelNameSchema.nullable().optional(),
    summarizeModel: modelNameSchema.nullable().optional(),
    searchModel: modelNameSchema.nullable().optional(),
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

  const rawModels =
    value.hindsightModels !== null && typeof value.hindsightModels === "object" && !Array.isArray(value.hindsightModels)
      ? (value.hindsightModels as Record<string, unknown>)
      : null;

  const writeParsed = modelNameSchema.safeParse(rawModels?.write ?? value.writeModel);
  const summarizeParsed = modelNameSchema.safeParse(rawModels?.summarize ?? value.summarizeModel);
  const searchParsed = modelNameSchema.safeParse(rawModels?.search ?? value.searchModel);

  const models: HindsightModelsConfig = {};
  if (writeParsed.success) {
    models.write = writeParsed.data;
    out.writeModel = writeParsed.data;
  }
  if (summarizeParsed.success) {
    models.summarize = summarizeParsed.data;
    out.summarizeModel = summarizeParsed.data;
  }
  if (searchParsed.success) {
    models.search = searchParsed.data;
    out.searchModel = searchParsed.data;
  }

  if (Object.keys(models).length > 0) {
    out.hindsightModels = models;
  }

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

  const existingModels: HindsightModelsConfig = { ...(stored.hindsightModels ?? {}) };
  if (stored.writeModel && !existingModels.write) existingModels.write = stored.writeModel;
  if (stored.summarizeModel && !existingModels.summarize) existingModels.summarize = stored.summarizeModel;
  if (stored.searchModel && !existingModels.search) existingModels.search = stored.searchModel;

  let modelsChanged = false;

  if (patch.writeModel !== undefined) {
    modelsChanged = true;
    if (patch.writeModel === null) {
      delete existingModels.write;
      delete next.writeModel;
    } else {
      existingModels.write = patch.writeModel;
      next.writeModel = patch.writeModel;
    }
  }

  if (patch.summarizeModel !== undefined) {
    modelsChanged = true;
    if (patch.summarizeModel === null) {
      delete existingModels.summarize;
      delete next.summarizeModel;
    } else {
      existingModels.summarize = patch.summarizeModel;
      next.summarizeModel = patch.summarizeModel;
    }
  }

  if (patch.searchModel !== undefined) {
    modelsChanged = true;
    if (patch.searchModel === null) {
      delete existingModels.search;
      delete next.searchModel;
    } else {
      existingModels.search = patch.searchModel;
      next.searchModel = patch.searchModel;
    }
  }

  if (patch.hindsightModels !== undefined) {
    modelsChanged = true;
    if (patch.hindsightModels === null) {
      delete next.hindsightModels;
      delete next.writeModel;
      delete next.summarizeModel;
      delete next.searchModel;
    } else {
      for (const role of HINDSIGHT_ROLES) {
        const val = patch.hindsightModels[role];
        if (val === undefined) continue;
        if (val === null) {
          delete existingModels[role];
          delete next[`${role}Model`];
        } else {
          existingModels[role] = val;
          next[`${role}Model`] = val;
        }
      }
    }
  }

  if (modelsChanged && patch.hindsightModels !== null) {
    if (Object.keys(existingModels).length > 0) {
      next.hindsightModels = existingModels;
    } else {
      delete next.hindsightModels;
    }
  }

  return next as AgentMemorySettings;
}
