// ui/src/ui2/screens/settings/system/Ui2FineSettings.tsx
//
// myrmidon(OPE-12046): Settings → System → "Fine settings" (SWEEP-2, read-only).
// Shows the first-wave behavior settings ("тонкие настройки": env-driven
// behavior variables of the 1.7 SETTINGS-TO-UI registry) exactly as the
// server resolves them — value plus its source (ui / env / default) — via
// GET /api/myrmidon/behavior-settings. Nothing on this screen writes: the
// editable surface is the next slice; here every row is read-only.
//
// The registry metadata (env name, section) comes from the same registry the
// server serves (GET /myrmidon/behavior-settings/definitions), so the screen
// cannot drift from the server. Unknown keys in the view are ignored; keys
// the server has not resolved are skipped (the acceptance contract: every
// displayed row is read from the API).

import { useQuery } from "@tanstack/react-query";
import { behaviorSettingsQueryKey, getBehaviorSettings, getBehaviorSettingsDefinitions } from "@/api/myrmidonBehaviorSettings";
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

export type FineSettingRow = {
  key: string;
  value: string;
  source: "ui" | "env" | "default";
  envName: string;
};

/** Format one resolved value for the read-only table. */
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

export function Ui2FineSettings() {
  const { t } = useUi2I18n();

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

  if (viewQuery.isLoading) {
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
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-testid={`ui2-fine-row-${row.key}`} className="ui2-fine-row border-t border-border">
                <td className="ui2-fine-key py-1.5 font-mono text-xs">{row.key}</td>
                <td className="ui2-fine-val py-1.5 font-mono text-xs">{row.value}</td>
                <td className="ui2-fine-src py-1.5 text-xs text-muted-foreground">
                  {row.source === "ui"
                    ? t("ui2.settings.system.fine.sourceUi")
                    : row.source === "env"
                      ? t("ui2.settings.system.fine.sourceEnv")
                      : t("ui2.settings.system.fine.sourceDefault")}
                </td>
                <td className="ui2-fine-envname py-1.5 font-mono text-xs text-muted-foreground">{row.envName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Ui2Section>
  );
}
