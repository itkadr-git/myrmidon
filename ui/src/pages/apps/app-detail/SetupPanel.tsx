import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolCatalogEntry, ToolConnection } from "@myrmidon/shared";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { appDefinitionSlug } from "../app-definition-display";
import type { AppDetailSectionProps } from "./types";
import { googleSheetsConfigWithAllowlist, parseGoogleSheetIds } from "../google-sheets";

export function SetupPanel({
  connection,
  galleryEntry,
  onUpdateConfig,
  configUpdateDisabled,
  identities,
  agentsSummary,
  permissionsSummary,
  permissionsLoading,
  onOpenPermissions,
}: Pick<
  AppDetailSectionProps,
  "connection" | "galleryEntry"
> & {
  onUpdateConfig: (config: Record<string, unknown>) => void;
  configUpdateDisabled: boolean;
  /**
   * The fixed Identity section. It replaces the old generic OAuth "workspace
   * authorization" block and shows the identity type chosen during setup.
   */
  identities?: ReactNode;
  agentsSummary: string;
  permissionsSummary: string | null;
  permissionsLoading: boolean;
  onOpenPermissions: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-10">
      {identities}
      <SetupLinkSection title={t("area.apps-detail.setup-panel.agents")} summary={agentsSummary} onClick={onOpenPermissions} />
      <SetupLinkSection
        title={t("area.apps-detail.setup-panel.actions")}
        summary={permissionsLoading ? t("area.apps-detail.setup-panel.loadingPermissions") : permissionsSummary ?? t("area.apps-detail.setup-panel.managePermissions")}
        onClick={onOpenPermissions}
      />
      {appDefinitionSlug(galleryEntry) === "google-sheets" && (
        <GoogleSheetsAllowlistSection
          connection={connection}
          disabled={configUpdateDisabled}
          onUpdateConfig={onUpdateConfig}
        />
      )}
      {appDefinitionSlug(galleryEntry) === "posthog" && (
        <PostHogConfigurationSection connection={connection} />
      )}
    </div>
  );
}

function SetupLinkSection({
  title,
  summary,
  onClick,
}: {
  title: string;
  summary: string;
  onClick: () => void;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center justify-between gap-4 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 text-sm text-muted-foreground">{summary}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
    </section>
  );
}

/**
 * Provider label used in identity and revoke copy. Falls back to the app's own
 * display name so a pasted server never reads as a generic "OAuth".
 */
export function connectionProviderName(
  galleryEntry: Parameters<typeof appDefinitionSlug>[0],
  fallback: string,
): string {
  switch (appDefinitionSlug(galleryEntry)) {
    case "notion":
      return "Notion";
    case "posthog":
      return "PostHog";
    case "gmail":
      return "Gmail";
    case "google-sheets":
      return "Google Sheets";
    default:
      return fallback;
  }
}

function PostHogConfigurationSection({ connection }: { connection: ToolConnection }) {
  const { t } = useTranslation();
  const raw = connection.config?.methodConfig;
  const config = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const method = connection.config?.connectionMethodKey === "mcp-oauth" ? t("area.apps-detail.setup-panel.posthogSignIn") : t("area.apps-detail.setup-panel.posthogApiKey");
  const features = typeof config.features === "string" ? config.features : t("area.apps-detail.setup-panel.none");
  const tools = typeof config.tools === "string" && config.tools ? config.tools : t("area.apps-detail.setup-panel.none");
  const rows = [
    [t("area.apps-detail.setup-panel.posthogConnectionMethod"), method],
    [t("area.apps-detail.setup-panel.posthogProjectPin"), typeof config.projectId === "string" ? config.projectId : t("area.apps-detail.setup-panel.posthogActiveProject")],
    [t("area.apps-detail.setup-panel.posthogReadOnly"), config.readOnly === true ? t("area.apps-detail.setup-panel.on") : t("area.apps-detail.setup-panel.off")],
    [t("area.apps-detail.setup-panel.posthogFeatureGroups"), features],
    [t("area.apps-detail.setup-panel.posthogIndividualTools"), tools],
    [t("area.apps-detail.setup-panel.posthogResponseMode"), typeof config.mode === "string" ? config.mode : "tools"],
  ];
  return (
    <section>
      <h2 className="text-sm font-bold text-foreground">{t("area.apps-detail.setup-panel.posthogTitle")}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        {t("area.apps-detail.setup-panel.posthogDescription")}
      </p>
      <dl className="mt-4 divide-y divide-border">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 py-2 sm:grid-cols-3 sm:gap-4">
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className="break-words text-sm text-foreground sm:col-span-2">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function currentSpreadsheetIds(connection: ToolConnection): string[] {
  const raw = connection.config?.allowedSpreadsheetIds;
  return Array.isArray(raw) ? raw.map((value) => String(value).trim()).filter(Boolean) : [];
}

function googleSheetsUrlForId(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
}

function GoogleSheetsAllowlistSection({
  connection,
  disabled,
  onUpdateConfig,
}: {
  connection: ToolConnection;
  disabled: boolean;
  onUpdateConfig: (config: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ids = currentSpreadsheetIds(connection);
  const saveIds = (nextIds: string[]) =>
    onUpdateConfig(googleSheetsConfigWithAllowlist(connection.config, nextIds));

  return (
    <section>
      <div>
        <h2 className="text-sm font-bold text-foreground">{t("area.apps-detail.setup-panel.sheetsTitle")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t("area.apps-detail.setup-panel.sheetsDescription")}
        </p>
      </div>

      <div className="mt-4 space-y-2">
        {ids.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t("area.apps-detail.setup-panel.sheetsEmpty")}</div>
        ) : (
          ids.map((id) => {
            const sheetUrl = googleSheetsUrlForId(id);
            return (
              <div key={id} className="flex items-center gap-3 border-t border-border py-2 first:border-t-0">
                <a
                  href={sheetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 text-sm font-medium text-foreground underline-offset-2 hover:underline"
                >
                  <span className="block truncate">{t("area.apps-detail.setup-panel.openSheet")}</span>
                  <span className="block truncate font-mono text-xs font-normal text-muted-foreground">
                    {sheetUrl}
                  </span>
                  <span className="block truncate font-mono text-(length:--text-micro) font-normal text-muted-foreground/80">
                    {t("area.apps-detail.setup-panel.sheetId", { id })}
                  </span>
                </a>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || ids.length <= 1}
                  title={ids.length <= 1 ? t("area.apps-detail.setup-panel.addBeforeRemoving") : undefined}
                  onClick={() => saveIds(ids.filter((current) => current !== id))}
                >
                  {t("common.remove")}
                </Button>
              </div>
            );
          })
        )}
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          placeholder="https://docs.google.com/spreadsheets/d/..."
          className="h-10"
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            const parsed = parseGoogleSheetIds(draft);
            if (parsed.ids.length === 0) {
              setError(t("area.apps-detail.setup-panel.pasteLink"));
              return;
            }
            if (parsed.invalidCount > 0) {
              setError(t("area.apps-detail.setup-panel.invalidLink"));
              return;
            }
            saveIds(Array.from(new Set([...ids, ...parsed.ids])));
            setDraft("");
          }}
        >
          {t("area.apps-detail.setup-panel.addSheet")}
        </Button>
      </div>
      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
    </section>
  );
}

export function QuarantinedActionsReview({
  entries,
  disabled,
  onSubmit,
}: {
  entries: ToolCatalogEntry[];
  disabled: boolean;
  onSubmit: (enabledIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const count = entries.length;
  const selectedIds = entries.filter((entry) => enabledIds.has(entry.id)).map((entry) => entry.id);
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            {t("area.apps-detail.setup-panel.reviewTitle", { count })}
          </div>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            {t("area.apps-detail.setup-panel.reviewHint")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-xs font-medium text-amber-800 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-50"
            disabled={disabled}
            onClick={() => setEnabledIds(new Set(entries.map((entry) => entry.id)))}
          >
            {t("area.apps-detail.setup-panel.turnAllOn")}
          </button>
          <button
            type="button"
            className="text-xs font-medium text-amber-800 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-50"
            disabled={disabled}
            onClick={() => setEnabledIds(new Set())}
          >
            {t("area.apps-detail.setup-panel.turnAllOff")}
          </button>
        </div>
      </div>
      <div className="divide-y divide-border">
        {entries.map((entry) => {
          const enabled = enabledIds.has(entry.id);
          const label = entry.title ?? entry.toolName;
          return (
            <div key={entry.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{label}</div>
                {entry.description && (
                  <div className="truncate text-xs text-muted-foreground">{entry.description}</div>
                )}
              </div>
              <ToggleSwitch
                aria-label={t("area.apps-detail.setup-panel.allowedAria", { label })}
                checked={enabled}
                disabled={disabled}
                onCheckedChange={(next) => {
                  setEnabledIds((current) => {
                    const updated = new Set(current);
                    if (next) updated.add(entry.id);
                    else updated.delete(entry.id);
                    return updated;
                  });
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-amber-700 dark:text-amber-300">
          {t("area.apps-detail.setup-panel.selectedCount", { selected: selectedIds.length, total: count })}
        </span>
        <Button size="sm" disabled={disabled} onClick={() => onSubmit(selectedIds)}>
          {disabled ? t("area.apps-detail.setup-panel.saving") : t("area.apps-detail.setup-panel.saveChoices")}
        </Button>
      </div>
    </section>
  );
}
