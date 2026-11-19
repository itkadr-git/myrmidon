// ui/src/components/myrmidon/model-providers/ModelGroupRulesSection.tsx
//
// myrmidon(1.8 MODEL-BY-STEP, OPE-12997): the owner-facing company settings
// editor for model groups by run step and caste. The table is intentionally a
// single PUT body; an unset cell remains absent, so it does not invent a
// model-group rule for that class/scope.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Save } from "lucide-react";
import { useTranslation } from "@/i18n";
import { ApiError, api } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  MODEL_GROUP_RULE_MAX_GROUP_CHARS,
  RUN_STEP_CLASSES,
  type CompanyModelGroupRule,
  type CompanyModelGroupRulesView,
  type RunStepClass,
} from "@myrmidon/shared";
import { modelGroupRulesApi, modelGroupRulesQueryKey } from "./modelGroupRulesApi";
import { sanitizeErrorMessage } from "./ModelProvidersScreen";

interface CasteOption {
  key: string;
  nameEn: string;
  nameRu: string;
}

interface CastesResponse {
  castes: CasteOption[];
}

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

const EMPTY_RULES: CompanyModelGroupRule[] = [];

export function ModelGroupRulesSection({ companyId }: { companyId: string }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [rules, setRules] = useState<CompanyModelGroupRule[]>(EMPTY_RULES);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const query = useQuery({
    queryKey: modelGroupRulesQueryKey(companyId),
    queryFn: () => modelGroupRulesApi.get(companyId),
    enabled: companyId.length > 0,
  });
  const castesQuery = useQuery({
    queryKey: ["myrmidon", "castes", companyId],
    queryFn: () => api.get<CastesResponse>(`/myrmidon/companies/${companyId}/castes`),
    enabled: companyId.length > 0,
  });

  useEffect(() => {
    if (query.data) {
      setRules(query.data.rules.map(({ stepClass, modelGroup, casteKey }) => ({
        stepClass,
        modelGroup,
        casteKey,
      })));
      setError(null);
    }
  }, [query.data]);

  const view: CompanyModelGroupRulesView | undefined = query.data;
  const castes = castesQuery.data?.castes ?? [];
  const groups = view?.availableGroups ?? [];
  const catalogUnavailable = Boolean(view?.catalogUnavailable);
  const initialGroups = (view?.rules ?? []).map((r) => r.modelGroup).filter(Boolean);
  const configuredGroups = rules.map((r) => r.modelGroup).filter(Boolean);
  const selectableGroups = Array.from(new Set([...groups, ...initialGroups, ...configuredGroups]));
  const language = i18n.language.startsWith("ru") ? "ru" : "en";
  const scopes: Array<{ key: string | null; label: string }> = [
    { key: null, label: t("area.settings-models-runtime-2.model-group-rules.companyScope") },
    ...castes.map((caste) => ({
      key: caste.key,
      label: language === "ru" ? caste.nameRu : caste.nameEn,
    })),
  ];

  const update = (scope: string | null, stepClass: RunStepClass, modelGroup: string) => {
    setSaved(false);
    setRules((current) => {
      const without = current.filter(
        (rule) => !(rule.casteKey === scope && rule.stepClass === stepClass),
      );
      const addition: CompanyModelGroupRule = { stepClass, modelGroup, casteKey: scope };
      return modelGroup ? [...without, addition] : without;
    });
  };

  const save = async () => {
    setError(null);
    setSaved(false);
    try {
      const result = await modelGroupRulesApi.save(companyId, { rules });
      setRules(result.rules.map(({ stepClass, modelGroup, casteKey }) => ({
        stepClass,
        modelGroup,
        casteKey,
      })));
      await queryClient.invalidateQueries({ queryKey: modelGroupRulesQueryKey(companyId) });
      setSaved(true);
    } catch (caught) {
      setError(sanitizeErrorMessage(readable(caught)));
    }
  };

  if (query.isLoading || castesQuery.isLoading) {
    return (
      <section className="space-y-3" data-testid="myrmidon-model-group-rules-section">
        <h2 className="text-sm font-semibold">{t("area.settings-models-runtime-2.model-group-rules.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("area.settings-models-runtime-2.model-group-rules.loading")}</p>
      </section>
    );
  }

  const loadError = query.error ?? castesQuery.error;
  if (loadError) {
    return (
      <section className="space-y-3" data-testid="myrmidon-model-group-rules-section">
        <h2 className="text-sm font-semibold">{t("area.settings-models-runtime-2.model-group-rules.title")}</h2>
        <p className="text-sm text-destructive" role="alert">
          {sanitizeErrorMessage(readable(loadError))}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="myrmidon-model-group-rules-section">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{t("area.settings-models-runtime-2.model-group-rules.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("area.settings-models-runtime-2.model-group-rules.description")}
        </p>
      </div>
      {catalogUnavailable ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          {t("area.settings-models-runtime-2.model-group-rules.catalogUnavailable")}
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="p-2 font-medium">{t("area.settings-models-runtime-2.model-group-rules.scope")}</th>
              {RUN_STEP_CLASSES.map((stepClass) => (
                <th key={stepClass} className="p-2 font-medium">
                  {t(`area.settings-models-runtime-2.model-group-rules.steps.${stepClass}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {scopes.map((scope) => (
              <tr key={scope.key ?? "company"} className="border-t border-border">
                <th className="p-2 text-left font-medium">{scope.label}</th>
                {RUN_STEP_CLASSES.map((stepClass) => {
                  const selected = rules.find(
                    (rule) => rule.casteKey === scope.key && rule.stepClass === stepClass,
                  )?.modelGroup ?? "";
                  const cellGroups = selected && !selectableGroups.includes(selected)
                    ? [selected, ...selectableGroups]
                    : selectableGroups;
                  return (
                    <td key={stepClass} className="p-2">
                      <select
                        className="w-full min-w-32 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                        aria-label={`${scope.label}: ${t(`area.settings-models-runtime-2.model-group-rules.steps.${stepClass}`)}`}
                        value={selected}
                        onChange={(event) => update(scope.key, stepClass, event.target.value)}
                        data-testid={`myrmidon-model-group-rule-${scope.key ?? "company"}-${stepClass}`}
                      >
                        <option value="">{t("area.settings-models-runtime-2.model-group-rules.inherit")}</option>
                        {cellGroups.map((group) => (
                          <option key={group} value={group}>
                            {group.slice(0, MODEL_GROUP_RULE_MAX_GROUP_CHARS)}
                          </option>
                        ))}
                      </select>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert" data-testid="myrmidon-model-group-rules-error">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("area.settings-models-runtime-2.model-group-rules.saved")}
        </p>
      ) : null}
      <Button
        size="sm"
        onClick={() => void save()}
        disabled={
          query.isFetching ||
          castesQuery.isFetching ||
          (groups.length === 0 && initialGroups.length === 0)
        }
        data-testid="myrmidon-model-group-rules-save"
      >
        <Save className="mr-2 h-4 w-4" aria-hidden="true" />
        {t("area.settings-models-runtime-2.model-group-rules.save")}
      </Button>
    </section>
  );
}
