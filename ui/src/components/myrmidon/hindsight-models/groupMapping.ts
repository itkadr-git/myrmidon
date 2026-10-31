// ui/src/components/myrmidon/hindsight-models/groupMapping.ts
//
// OPE-9858: Mapping of Hindsight's three memory roles (write, summarize, search)
// to standard model groups for the Model Providers and Models settings screen.
//
// Links selection to Hindsight configuration without modifying secrets/env.
// Values persist without server restart (runtime sync to Hindsight container
// depends on OPE-9469).

import {
  DEFAULT_HINDSIGHT_MODELS,
  HINDSIGHT_API_LIMITATIONS,
  HINDSIGHT_ROLE_META,
  HINDSIGHT_ROLES,
  type HindsightApiLimitations,
  type HindsightModelGroupView,
  type HindsightRole,
} from "@myrmidon/shared";

export {
  DEFAULT_HINDSIGHT_MODELS,
  HINDSIGHT_API_LIMITATIONS,
  HINDSIGHT_ROLE_META,
  HINDSIGHT_ROLES,
  type HindsightApiLimitations,
  type HindsightModelGroupView,
  type HindsightRole,
};

export interface GenericModelGroupItem {
  id: string;
  role: HindsightRole;
  name: string;
  description: string;
  model: string;
  defaultModel: string;
  source: "setting" | "default";
  editable: boolean;
  isHindsight: true;
  suggestedModels: string[];
}

export interface HindsightLimitationDetail {
  id: string;
  title: string;
  description: string;
  severity: "warning" | "info";
  relatedIssue?: "OPE-9469" | "OPE-9850";
}

export const HINDSIGHT_SUGGESTED_MODELS: Record<HindsightRole, string[]> = {
  write: ["gpt-4o-mini", "claude-3-5-haiku", "qwen-plus", "deepseek-chat"],
  summarize: ["gpt-4o-mini", "claude-3-5-haiku", "qwen-plus", "deepseek-chat"],
  search: ["gpt-4o-mini", "text-embedding-3-small", "bge-m3", "qwen-plus"],
};

export function hindsightRoleToGroupId(role: HindsightRole): string {
  return `hindsight-${role}`;
}

export function groupIdToHindsightRole(groupId: string): HindsightRole | null {
  const normalized = groupId.trim().toLowerCase();
  if (normalized === "hindsight-write" || normalized === "write") return "write";
  if (normalized === "hindsight-summarize" || normalized === "summarize") return "summarize";
  if (normalized === "hindsight-search" || normalized === "search") return "search";
  return null;
}

export function isHindsightGroup(groupId: string): boolean {
  return groupIdToHindsightRole(groupId) !== null;
}

export function getHindsightApiLimitations(): HindsightLimitationDetail[] {
  return [
    {
      id: "ope-9469-runtime-dependency",
      title: "Горячее применение в контейнере ожидает OPE-9469",
      description:
        "Настройки сохраняются в конфигурации доски без перезапуска сервера Myrmidon. Реальное применение в работающий контейнер Hindsight без перезапуска контейнера зависит от реализации hot-reload API в OPE-9469.",
      severity: "warning",
      relatedIssue: "OPE-9469",
    },
    {
      id: "no-secret-mutation",
      title: "Без правки секретов и переменных окружения",
      description:
        "Ключи доступа к провайдерам не передаются и не изменяются через этот интерфейс. Все учетные данные изолированы в секретах компании.",
      severity: "info",
    },
    {
      id: "embedding-reindex-requirement",
      title: "Смена модели поиска требует переиндексации",
      description:
        "Векторные пространства разных моделей эмбеддингов несовместимы между собой. Изменение модели search для существующих банков памяти потребует переиндексации (reindex).",
      severity: "warning",
    },
    {
      id: "gateway-catalog-presence",
      title: "Наличие в каталоге LiteLLM",
      description:
        "Выбранные модели должны быть доступны в шлюзе LiteLLM или среди настроенных активных провайдеров доски.",
      severity: "info",
      relatedIssue: "OPE-9850",
    },
    {
      id: "instant-persistence",
      title: "Мгновенное сохранение без перезапуска доски",
      description:
        "Конфигурация перечитывается при каждом обращении к сервису, поэтому перезапуск сервера Myrmidon не требуется.",
      severity: "info",
    },
  ];
}

export function mapHindsightToCatalogGroups(
  groups: HindsightModelGroupView[],
): GenericModelGroupItem[] {
  return groups.map((g) => ({
    id: g.group || hindsightRoleToGroupId(g.role),
    role: g.role,
    name: g.name,
    description: g.description,
    model: g.model,
    defaultModel: g.defaultModel,
    source: g.source,
    editable: true,
    isHindsight: true,
    suggestedModels: HINDSIGHT_SUGGESTED_MODELS[g.role] ?? ["gpt-4o-mini"],
  }));
}
