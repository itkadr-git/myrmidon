import type { Db } from "@myrmidon/db";
import {
  DEFAULT_HINDSIGHT_MODELS,
  HINDSIGHT_API_LIMITATIONS,
  HINDSIGHT_ROLE_META,
  HINDSIGHT_ROLES,
  type AgentMemorySettings,
  type HindsightApiLimitations,
  type HindsightModelCatalogView,
  type HindsightModelGroupView,
  type HindsightModelsConfig,
  type HindsightRole,
  type PatchHindsightModels,
} from "@myrmidon/shared";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { AGENT_MEMORY_SETTINGS_KEY } from "./settings.js";

export function hindsightRoleToGroup(role: HindsightRole): string {
  return `hindsight-${role}`;
}

export function groupToHindsightRole(group: string): HindsightRole | null {
  const normalized = group.trim().toLowerCase();
  if (normalized === "hindsight-write" || normalized === "write") return "write";
  if (normalized === "hindsight-summarize" || normalized === "summarize") return "summarize";
  if (normalized === "hindsight-search" || normalized === "search") return "search";
  return null;
}

export function isHindsightGroup(group: string): boolean {
  return groupToHindsightRole(group) !== null;
}

export function formatHindsightApiLimitations(): HindsightApiLimitations {
  return {
    runtimeDependency: "OPE-9469",
    summary:
      "Конфигурация ролей write/summarize/search сохраняется в настройках доски без перезапуска. Реальное применение в работающем сервисе Hindsight зависит от задачи OPE-9469 (hot-reload API сервиса).",
    items: [...HINDSIGHT_API_LIMITATIONS],
  };
}

export interface HindsightModelsStorageDeps {
  getGeneral: () => Promise<Record<string, unknown>>;
  updateGeneral: (patch: Record<string, unknown>) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export function hindsightModelsAdapter(deps: HindsightModelsStorageDeps) {
  async function readStoredSettings(): Promise<AgentMemorySettings> {
    const general = await deps.getGeneral();
    const raw = general[AGENT_MEMORY_SETTINGS_KEY];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as AgentMemorySettings;
    }
    return {};
  }

  return {
    hindsightRoleToGroup,
    groupToHindsightRole,
    isHindsightGroup,

    async getCatalog(): Promise<HindsightModelCatalogView> {
      const stored = await readStoredSettings();
      const configuredModels = stored.hindsightModels ?? {};

      const groups: HindsightModelGroupView[] = HINDSIGHT_ROLES.map((role) => {
        const meta = HINDSIGHT_ROLE_META[role];
        const directKey = `${role}Model` as const;
        const configured = configuredModels[role] ?? (stored[directKey] as string | undefined);

        return {
          role,
          group: meta.group,
          name: meta.name,
          description: meta.description,
          model: configured || meta.defaultModel,
          defaultModel: meta.defaultModel,
          source: configured ? "setting" : "default",
          updatedAt: null,
        };
      });

      return {
        groups,
        limitations: formatHindsightApiLimitations(),
        status: "mock_stored",
        hotReloadDependency: "OPE-9469",
        hotReloadAvailable: false,
      };
    },

    async updateCatalog(patch: PatchHindsightModels): Promise<HindsightModelCatalogView> {
      const stored = await readStoredSettings();
      const currentModels: HindsightModelsConfig = { ...(stored.hindsightModels ?? {}) };

      // Sync legacy/direct fields if present
      if (stored.writeModel && !currentModels.write) currentModels.write = stored.writeModel;
      if (stored.summarizeModel && !currentModels.summarize) currentModels.summarize = stored.summarizeModel;
      if (stored.searchModel && !currentModels.search) currentModels.search = stored.searchModel;

      // Apply single role update: { role: "write", model: "..." }
      if (patch.role && patch.model !== undefined) {
        currentModels[patch.role] = patch.model;
      }

      // Apply top-level keys
      if (patch.write !== undefined) {
        if (patch.write === null) delete currentModels.write;
        else currentModels.write = patch.write;
      }
      if (patch.summarize !== undefined) {
        if (patch.summarize === null) delete currentModels.summarize;
        else currentModels.summarize = patch.summarize;
      }
      if (patch.search !== undefined) {
        if (patch.search === null) delete currentModels.search;
        else currentModels.search = patch.search;
      }

      // Apply models sub-object
      if (patch.models) {
        if (patch.models.write !== undefined) {
          if (patch.models.write === null) delete currentModels.write;
          else currentModels.write = patch.models.write;
        }
        if (patch.models.summarize !== undefined) {
          if (patch.models.summarize === null) delete currentModels.summarize;
          else currentModels.summarize = patch.models.summarize;
        }
        if (patch.models.search !== undefined) {
          if (patch.models.search === null) delete currentModels.search;
          else currentModels.search = patch.models.search;
        }
      }

      const nextSettings: AgentMemorySettings = {
        ...stored,
        hindsightModels: currentModels,
        writeModel: currentModels.write,
        summarizeModel: currentModels.summarize,
        searchModel: currentModels.search,
      };

      await deps.updateGeneral({ [AGENT_MEMORY_SETTINGS_KEY]: nextSettings });

      return this.getCatalog();
    },
  };
}

export function hindsightModelsDbAdapter(db: Db, env: NodeJS.ProcessEnv = process.env) {
  const settings = instanceSettingsService(db);
  return hindsightModelsAdapter({
    getGeneral: async () => (await settings.get()).general,
    updateGeneral: async (patch) => {
      await settings.updateGeneral(patch);
    },
    env,
  });
}
