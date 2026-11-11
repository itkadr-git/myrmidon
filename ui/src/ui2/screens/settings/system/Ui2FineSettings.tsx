// ui/src/ui2/screens/settings/system/Ui2FineSettings.tsx
//
// myrmidon(OPE-12046): Settings → System → "Fine settings" (SWEEP-2).
// myrmidon(OPE-12611): SWEEP-2 write — instance admins can edit values inline:
// boolean -> checkbox, number -> numeric input, string -> text input.
// JSON values stay read-only. Save sends a PATCH with only the changed key.
// Non-admins see the table in read-only mode without inputs or buttons.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  behaviorSettingsApi,
  behaviorSettingsQueryKey,
  getBehaviorSettings,
  getBehaviorSettingsDefinitions,
  type BehaviorSettingDefinition,
  type BehaviorSettingValue,
} from "@/api/myrmidonBehaviorSettings";
import { useIsInstanceAdmin } from "@/components/myrmidon/licensingApi";
import { useUi2I18n } from "../../../i18n/Ui2I18n";
import {
  Ui2DeniedState,
  Ui2ErrorState,
  Ui2SkeletonRows,
} from "../../../components/ui2StateViews";
import { Ui2Section } from "../../../components/ui2Primitives";

/** The first wave (SWEEP-2): the obvious env-driven behavior variables. */
export const FINE_SETTINGS_KEYS = [
  "debug_mode",
  "max_concurrent_agents",
  "default_timeout_seconds",
  "autonomy_level",
  "bot_egress_mode",
  "tool_breaker_failures",
  "tool_breaker_cooldown_ms",
  "tool_breaker_window_ms",
  "tool_timeout_max_ms",
  "tool_timeout_slow_ms",
  "bot_reconcile_interval_sec",
  "input_limit_precheck",
] as const;

type FineValueType = BehaviorSettingDefinition["valueType"];

export type FineSettingRow = {
  key: string;
  value: string;
  source: "ui" | "env" | "default";
  envName: string;
};

/** Format one resolved value for display in the table. */
export function formatFineSettingValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.join(", ");
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length === 0 ? "—" : entries.map(([k, v]) => `${k}=${String(v)}`).join(", ");
  }
  const text = String(value);
  return text.length === 0 ? "—" : text;
}

interface FineSettingsDefs {
  settings: Record<string, unknown>;
  sources: Record<string, string>;
  definitions?: Array<{ key: string; envName: string }>;
}

/** Build the visible rows: only keys the API actually resolved. */
export function buildFineSettingsRows(view: FineSettingsDefs): FineSettingRow[] {
  return FINE_SETTINGS_KEYS.filter((key) => key in (view.settings ?? {})).map((key) => {
    const definition = view.definitions?.find((candidate) => candidate.key === key);
    const source = view.sources?.[key];
    return {
      key,
      value: formatFineSettingValue(view.settings[key]),
      source: source === "ui" || source === "env" ? source : "default",
      envName: definition?.envName ?? key,
    };
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function Ui2FineSettings() {
  const { t } = useUi2I18n();
  const isInstanceAdmin = useIsInstanceAdmin();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, BehaviorSettingValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const viewQuery = useQuery({
    queryKey: behaviorSettingsQueryKey,
    queryFn: getBehaviorSettings,
    staleTime: 30_000,
  });

  const defsQuery = useQuery({
    queryKey: [...behaviorSettingsQueryKey, "definitions"],
    queryFn: getBehaviorSettingsDefinitions,
    staleTime: 300_000,
  });

  const updateMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: BehaviorSettingValue }) =>
      behaviorSettingsApi.update({ [key]: value }),
    onMutate: ({ key }) => {
      setSavingKey(key);
      setErrors((current) => ({ ...current, [key]: "" }));
    },
    onSuccess: (data, { key }) => {
      queryClient.setQueryData(behaviorSettingsQueryKey, data);
      setDraft((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setSavingKey(null);
    },
    onError: (error, { key }) => {
      setDraft((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setErrors((current) => ({ ...current, [key]: errorText(error) }));
      setSavingKey(null);
    },
  });

  if (viewQuery.isLoading || isInstanceAdmin === null) {
    return (
      <Ui2Section title={t("ui2.settings.system.fine.title")}>
        <Ui2SkeletonRows rows={4} dense />
      </Ui2Section>
    );
  }

  const denied =
    viewQuery.isError && (viewQuery.error as { status?: number } | null)?.status === 403;

  if (viewQuery.isError) {
    return (
      <Ui2Section title={t("ui2.settings.system.fine.title")}>
        {denied ? (
          <Ui2DeniedState
            message={t("ui2.settings.system.fine.denied")}
            hint={t("ui2.settings.system.fine.deniedHint")}
          />
        ) : (
          <Ui2ErrorState
            message={t("ui2.common.error")}
            detail={viewQuery.error instanceof Error ? viewQuery.error.message : null}
            retryLabel={t("ui2.common.retry")}
            onRetry={() => void viewQuery.refetch()}
          />
        )}
      </Ui2Section>
    );
  }

  const definitions = defsQuery.data ?? [];
  const rows = buildFineSettingsRows({
    settings: viewQuery.data?.settings ?? {},
    sources: viewQuery.data?.sources ?? {},
    definitions,
  });
  const definitionByKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const settings = viewQuery.data?.settings ?? {};

  return (
    <Ui2Section
      title={t("ui2.settings.system.fine.title")}
      footer={t("ui2.settings.system.fine.footer")}
    >
      {rows.length === 0 ? (
        <p className="ui2-fine-empty text-sm text-muted-foreground">
          {t("ui2.settings.system.fine.empty")}
        </p>
      ) : (
        <table className="ui2-fine w-full text-sm">
          <thead>
            <tr className="ui2-fine-head text-left text-xs text-muted-foreground">
              <th className="ui2-fine-name py-1 font-medium">{t("ui2.settings.system.fine.name")}</th>
              <th className="ui2-fine-value py-1 font-medium">{t("ui2.settings.system.fine.value")}</th>
              <th className="ui2-fine-source py-1 font-medium">{t("ui2.settings.system.fine.source")}</th>
              <th className="ui2-fine-env py-1 font-medium">{t("ui2.settings.system.fine.env")}</th>
              {isInstanceAdmin && (
                <th className="ui2-fine-action py-1 font-medium">
                  {t("ui2.settings.system.fine.action")}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const definition = definitionByKey.get(row.key);
              const valueType: FineValueType | undefined = definition?.valueType;
              const editable = isInstanceAdmin && valueType !== "json" && valueType !== undefined;
              const value = draft[row.key] ?? settings[row.key];
              return (
                <tr
                  key={row.key}
                  data-testid={`ui2-fine-row-${row.key}`}
                  className="ui2-fine-row border-t border-border"
                >
                  <td className="ui2-fine-key py-1.5 font-mono text-xs">{row.key}</td>
                  <td className="ui2-fine-val py-1.5 font-mono text-xs">
                    {editable ? (
                      valueType === "boolean" ? (
                        <input
                          aria-label={row.key}
                          type="checkbox"
                          checked={Boolean(value)}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              [row.key]: event.target.checked,
                            }))
                          }
                        />
                      ) : (
                        <input
                          aria-label={row.key}
                          type={valueType === "number" ? "number" : "text"}
                          value={value == null ? "" : String(value)}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              [row.key]:
                                valueType === "number"
                                  ? event.target.value === ""
                                    ? ""
                                    : Number(event.target.value)
                                  : event.target.value,
                            }))
                          }
                        />
                      )
                    ) : (
                      row.value
                    )}
                  </td>
                  <td className="ui2-fine-src py-1.5 text-xs text-muted-foreground">
                    {row.source === "ui"
                      ? t("ui2.settings.system.fine.sourceUi")
                      : row.source === "env"
                        ? t("ui2.settings.system.fine.sourceEnv")
                        : t("ui2.settings.system.fine.sourceDefault")}
                  </td>
                  <td className="ui2-fine-envname py-1.5 font-mono text-xs text-muted-foreground">
                    {row.envName}
                  </td>
                  {isInstanceAdmin && (
                    <td className="ui2-fine-action py-1.5">
                      {editable && (row.key in draft || savingKey === row.key) && (
                        <button
                          type="button"
                          disabled={savingKey === row.key}
                          onClick={() => {
                            const next = draft[row.key];
                            if (next !== undefined) {
                              updateMutation.mutate({ key: row.key, value: next });
                            }
                          }}
                        >
                          {savingKey === row.key
                            ? t("ui2.settings.system.fine.saving")
                            : t("ui2.settings.system.fine.save")}
                        </button>
                      )}
                      {errors[row.key] && (
                        <div role="alert" className="ui2-fine-error text-xs text-destructive">
                          {errors[row.key]}
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Ui2Section>
  );
}
