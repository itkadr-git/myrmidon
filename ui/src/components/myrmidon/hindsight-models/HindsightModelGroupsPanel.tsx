// ui/src/components/myrmidon/hindsight-models/HindsightModelGroupsPanel.tsx
//
// OPE-9858: UI section displaying Hindsight's three memory roles (write, summarize, search)
// as ordinary model groups on the Model Providers / Models screen.
//
// Links selection to Hindsight configuration without modifying secrets/env.
// Values persist in instance settings without server restart.
// Explicitly displays API limitations and runtime dependency on OPE-9469.

import { useState, useEffect } from "react";
import { AlertCircle, CheckCircle2, Clock, Cpu, Save } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getHindsightApiLimitations,
  HINDSIGHT_ROLES,
  HINDSIGHT_SUGGESTED_MODELS,
  mapHindsightToCatalogGroups,
  type HindsightModelCatalogView,
  type HindsightModelGroupView,
  type HindsightRole,
} from "./groupMapping";
import {
  hindsightModelsApi,
  hindsightModelGroupsQueryKey,
} from "./hindsightModelsApi";

export interface HindsightModelGroupsPanelProps {
  companyId?: string;
  initialGroups?: HindsightModelGroupView[];
  onSaveSuccess?: () => void;
}

const DEFAULT_FALLBACK_GROUPS: HindsightModelGroupView[] = [
  {
    role: "write",
    group: "hindsight-write",
    name: "Hindsight Write (память: запись)",
    description: "Извлечение фактов, связывание сущностей и сохранение воспоминаний.",
    model: "gpt-4o-mini",
    defaultModel: "gpt-4o-mini",
    source: "default",
    updatedAt: null,
  },
  {
    role: "summarize",
    group: "hindsight-summarize",
    name: "Hindsight Summarize (память: сведение)",
    description: "Сведение разрозненных фактов и периодическая консолидация памяти.",
    model: "gpt-4o-mini",
    defaultModel: "gpt-4o-mini",
    source: "default",
    updatedAt: null,
  },
  {
    role: "search",
    group: "hindsight-search",
    name: "Hindsight Search (память: поиск)",
    description: "Семантический поиск, генерация запросов воспоминания и ранжирование.",
    model: "gpt-4o-mini",
    defaultModel: "gpt-4o-mini",
    source: "default",
    updatedAt: null,
  },
];

export function HindsightModelGroupsPanel({
  companyId,
  initialGroups,
  onSaveSuccess,
}: HindsightModelGroupsPanelProps) {
  const queryClient = useQueryClient();

  const query = useQuery<HindsightModelCatalogView>({
    queryKey: [...hindsightModelGroupsQueryKey, companyId ?? "global"],
    queryFn: () =>
      hindsightModelsApi.getCatalog(companyId).catch(() => ({
        groups: initialGroups ?? DEFAULT_FALLBACK_GROUPS,
        limitations: {
          runtimeDependency: "OPE-9469",
          summary: "Конфигурация сохраняется без перезапуска.",
          items: [],
        },
        status: "mock_stored",
        hotReloadDependency: "OPE-9469",
        hotReloadAvailable: false,
      })),
    initialData: initialGroups
      ? {
          groups: initialGroups,
          limitations: {
            runtimeDependency: "OPE-9469",
            summary: "Конфигурация сохраняется без перезапуска.",
            items: [],
          },
          status: "mock_stored",
          hotReloadDependency: "OPE-9469",
          hotReloadAvailable: false,
        }
      : undefined,
  });

  const catalog = query.data;
  const groups = catalog?.groups ?? initialGroups ?? DEFAULT_FALLBACK_GROUPS;

  const [models, setModels] = useState<Record<HindsightRole, string>>({
    write: "gpt-4o-mini",
    summarize: "gpt-4o-mini",
    search: "gpt-4o-mini",
  });
  const [dirty, setDirty] = useState(false);
  const [saveSuccessNotice, setSaveSuccessNotice] = useState(false);

  useEffect(() => {
    if (groups.length > 0) {
      const next: Record<HindsightRole, string> = {
        write: "gpt-4o-mini",
        summarize: "gpt-4o-mini",
        search: "gpt-4o-mini",
      };
      for (const g of groups) {
        next[g.role] = g.model;
      }
      setModels(next);
      setDirty(false);
    }
  }, [groups]);

  const saveMutation = useMutation({
    mutationFn: (modelsToSave: Record<HindsightRole, string>) =>
      hindsightModelsApi.updateCatalog(
        {
          models: {
            write: modelsToSave.write,
            summarize: modelsToSave.summarize,
            search: modelsToSave.search,
          },
        },
        companyId,
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(
        [...hindsightModelGroupsQueryKey, companyId ?? "global"],
        data,
      );
      setDirty(false);
      setSaveSuccessNotice(true);
      setTimeout(() => setSaveSuccessNotice(false), 4000);
      onSaveSuccess?.();
    },
  });

  const handleModelChange = (role: HindsightRole, value: string) => {
    setModels((prev) => ({ ...prev, [role]: value }));
    setDirty(true);
  };

  const handleSelectSuggested = (role: HindsightRole, model: string) => {
    setModels((prev) => ({ ...prev, [role]: model }));
    setDirty(true);
  };

  const handleSave = () => {
    saveMutation.mutate(models);
  };

  const mappedCatalogGroups = mapHindsightToCatalogGroups(groups);
  const limitations = getHindsightApiLimitations();

  return (
    <section
      className="space-y-4 rounded-lg border border-border p-4 bg-card"
      data-testid="myrmidon-hindsight-model-groups-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 className="text-sm font-semibold tracking-tight">
              Модели памяти Hindsight (запись, сведение, поиск)
            </h2>
            <span
              className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground"
              data-testid="hindsight-groups-count-badge"
            >
              3 группы
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Группы моделей для трех ключевых ролей сервиса памяти Hindsight. Выбор связывается с
            конфигурацией доски без правки секретов и переменных окружения.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {saveSuccessNotice ? (
            <span
              className="flex items-center gap-1 text-xs text-emerald-600 font-medium"
              data-testid="hindsight-save-success-indicator"
            >
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
              Сохранено без перезапуска
            </span>
          ) : null}

          <Button
            size="sm"
            onClick={handleSave}
            disabled={!dirty || saveMutation.isPending}
            data-testid="hindsight-save-models-button"
            className="gap-1.5"
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            {saveMutation.isPending ? "Сохранение..." : "Сохранить"}
          </Button>
        </div>
      </div>

      {/* Limitations and Architecture Banner */}
      <div
        className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 space-y-2 text-xs"
        data-testid="hindsight-limitations-banner"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-semibold text-foreground">
              Ограничения API и статус горячего применения (OPE-9469):
            </p>
            <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
              {limitations.map((lim) => (
                <li key={lim.id} data-testid={`hindsight-limitation-${lim.id}`}>
                  <strong className="text-foreground">{lim.title}:</strong> {lim.description}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {saveMutation.isError ? (
        <div
          className="rounded-md border border-destructive/20 bg-destructive/10 p-2 text-xs text-destructive flex items-center gap-2"
          data-testid="hindsight-save-error"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Не удалось сохранить конфигурацию: {(saveMutation.error as Error)?.message || "Ошибка API"}</span>
        </div>
      ) : null}

      {/* 3 Model Groups */}
      <div className="grid gap-3 md:grid-cols-3" data-testid="hindsight-model-groups-list">
        {HINDSIGHT_ROLES.map((role) => {
          const groupItem = mappedCatalogGroups.find((g) => g.role === role);
          const currentVal = models[role] ?? groupItem?.model ?? "gpt-4o-mini";
          const suggested = HINDSIGHT_SUGGESTED_MODELS[role] ?? [];

          return (
            <div
              key={role}
              className="flex flex-col justify-between rounded-md border border-border bg-background p-3 space-y-3"
              data-testid={`hindsight-group-card-${role}`}
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="font-mono text-xs font-semibold text-primary">
                    hindsight-{role}
                  </span>
                  <span
                    className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground uppercase"
                    data-testid={`hindsight-role-badge-${role}`}
                  >
                    {role}
                  </span>
                </div>

                <h3 className="text-xs font-semibold text-foreground">
                  {groupItem?.name ?? `Hindsight ${role}`}
                </h3>

                <p className="text-xs text-muted-foreground line-clamp-2">
                  {groupItem?.description ?? ""}
                </p>
              </div>

              <div className="space-y-2 pt-1 border-t border-border">
                <div className="space-y-1">
                  <Label htmlFor={`model-input-${role}`} className="text-xs text-muted-foreground">
                    Модель группы:
                  </Label>
                  <Input
                    id={`model-input-${role}`}
                    value={currentVal}
                    onChange={(e) => handleModelChange(role, e.target.value)}
                    className="h-8 font-mono text-xs"
                    placeholder="название модели"
                    data-testid={`hindsight-model-input-${role}`}
                  />
                </div>

                {/* Suggestions */}
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Быстрый выбор:</span>
                  <div className="flex flex-wrap gap-1">
                    {suggested.map((sug) => (
                      <button
                        key={sug}
                        type="button"
                        onClick={() => handleSelectSuggested(role, sug)}
                        className={`rounded border px-1.5 py-0.5 text-xs font-mono transition-colors ${
                          currentVal === sug
                            ? "border-primary bg-primary/10 text-primary font-medium"
                            : "border-border hover:bg-muted text-muted-foreground"
                        }`}
                        data-testid={`hindsight-sug-${role}-${sug}`}
                      >
                        {sug}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" aria-hidden="true" />
                    Без рестарта
                  </span>
                  <span className="italic font-mono">
                    def: {groupItem?.defaultModel ?? "gpt-4o-mini"}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
