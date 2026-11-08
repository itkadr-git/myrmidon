/**
 * @fileoverview Plugin Manager page — admin UI for discovering,
 * installing, enabling/disabling, and uninstalling plugins.
 *
 * @see PLUGIN_SPEC.md §9 — Plugin Marketplace / Manager
 */
import { useEffect, useMemo, useState } from "react";
import { Trans } from "react-i18next";
import { i18n, useTranslation } from "@/i18n";
import { pluginLabel } from "@/i18n/plugin-labels"; // myrmidon(OPE-9352)
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { PluginRecord } from "@myrmidon/shared";
import { Link } from "@/lib/router";
import { AlertTriangle, FlaskConical, Plus, Power, Puzzle, Settings, Trash } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToastActions } from "@/context/ToastContext";
import { cn } from "@/lib/utils";

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ?? null;
}

function getPluginErrorSummary(plugin: PluginRecord): string {
  return firstNonEmptyLine(plugin.lastError) ?? i18n.t("area.adapters-plugins-2.plugin-manager.errorSummaryFallback");
}

function isExperimentalPluginIdentity(input: {
  packageName?: string | null;
  packagePath?: string | null;
  manifestJson?: PluginRecord["manifestJson"] | null;
  bundledExperimental?: boolean;
}) {
  if (input.bundledExperimental) return true;

  const packageName = input.packageName ?? "";
  const packagePath = input.packagePath ?? "";
  if (packageName.includes("sandbox") || packagePath.includes("sandbox")) return true;
  return input.manifestJson?.environmentDrivers?.some((driver) => driver.kind === "sandbox_provider") === true;
}

function ExperimentalBadge() {
  const { t } = useTranslation();
  return (
    <Badge
      variant="outline"
      className="border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/10 dark:text-amber-200"
    >
      {t("area.adapters-plugins-2.plugin-manager.experimental")}
    </Badge>
  );
}

/**
 * PluginManager page component.
 *
 * Provides a management UI for the Paperclip plugin system:
 * - Lists all installed plugins with their status, version, and category badges.
 * - Allows installing new plugins by npm package name.
 * - Provides per-plugin actions: enable, disable, navigate to settings.
 * - Uninstall with a two-step confirmation dialog to prevent accidental removal.
 *
 * Data flow:
 * - Reads from `GET /api/plugins` via `pluginsApi.list()`.
 * - Mutations (install / uninstall / enable / disable) invalidate
 *   `queryKeys.plugins.all` so the list refreshes automatically.
 *
 * @see PluginSettings — linked from the Settings icon on each plugin row.
 * @see doc/plugins/PLUGIN_SPEC.md §3 — Plugin Lifecycle for status semantics.
 */
export function PluginManager() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { t } = useTranslation();

  const [installPackage, setInstallPackage] = useState("");
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [upgradePrompt, setUpgradePrompt] = useState<{ plugin: PluginRecord; capabilities: string[] } | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [uninstallPluginId, setUninstallPluginId] = useState<string | null>(null);
  const [uninstallPluginName, setUninstallPluginName] = useState<string>("");
  const [errorDetailsPlugin, setErrorDetailsPlugin] = useState<PluginRecord | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("area.adapters-plugins-2.plugin-manager.breadcrumbOrganization"), href: "/dashboard" },
      { label: t("area.adapters-plugins-2.plugin-manager.breadcrumbSettings"), href: "/company/settings" },
      { label: t("area.adapters-plugins-2.plugin-manager.breadcrumbPlugins") },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs, t]);

  const { data: plugins, isLoading, error } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });

  const bundledQuery = useQuery({
    queryKey: queryKeys.plugins.examples,
    queryFn: () => pluginsApi.listBundled(),
  });

  const invalidatePluginQueries = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all });
    queryClient.invalidateQueries({ queryKey: queryKeys.plugins.examples });
    queryClient.invalidateQueries({ queryKey: queryKeys.plugins.uiContributions });
  };

  const installMutation = useMutation({
    mutationFn: (params: { packageName: string; version?: string; isLocalPath?: boolean }) =>
      pluginsApi.install(params),
    onSuccess: () => {
      invalidatePluginQueries();
      setInstallDialogOpen(false);
      setInstallPackage("");
      pushToast({ title: t("area.adapters-plugins-2.plugin-manager.toast.installed"), tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: t("area.adapters-plugins-2.plugin-manager.toast.installFailed"), body: err.message, tone: "error" });
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.uninstall(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({ title: t("area.adapters-plugins-2.plugin-manager.toast.uninstalled"), tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: t("area.adapters-plugins-2.plugin-manager.toast.uninstallFailed"), body: err.message, tone: "error" });
    },
  });

  const upgradeMutation = useMutation<PluginRecord, Error, { pluginId: string; approvedCapabilities?: string[] }>({
    mutationFn: (input) =>
      pluginsApi.upgrade(input.pluginId, { approvedCapabilities: input.approvedCapabilities }),
    onSuccess: () => {
      invalidatePluginQueries();
      setUpgradePrompt(null);
      setUpgradeError(null);
      pushToast({ title: t("area.adapters-plugins-2.plugin-manager.toast.upgraded"), tone: "success" });
    },
    onError: (err: Error, input: { pluginId: string; approvedCapabilities?: string[] }) => {
      const match = err.message.match(/introduces new capabilities that require approval:\s*(.+?)\. The previous version declared/i);
      if (match) {
        const plugin = installedPlugins.find((candidate) => candidate.id === input.pluginId);
        if (plugin) {
          setUpgradePrompt({ plugin, capabilities: match[1].split(", ").map((cap) => cap.trim()) });
        }
        setUpgradeError(null);
      } else {
        setUpgradeError(err.message);
      }
    },
  });

  const enableMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.enable(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({ title: t("area.adapters-plugins-2.plugin-manager.toast.enabled"), tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: t("area.adapters-plugins-2.plugin-manager.toast.enableFailed"), body: err.message, tone: "error" });
    },
  });

  const disableMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.disable(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({ title: t("area.adapters-plugins-2.plugin-manager.toast.disabled"), tone: "info" });
    },
    onError: (err: Error) => {
      pushToast({ title: t("area.adapters-plugins-2.plugin-manager.toast.disableFailed"), body: err.message, tone: "error" });
    },
  });

  const installedPlugins = plugins ?? [];
  const bundledPlugins = bundledQuery.data ?? [];
  const installedByPackageName = new Map(installedPlugins.map((plugin) => [plugin.packageName, plugin]));
  const bundledByPackageName = new Map(bundledPlugins.map((plugin) => [plugin.packageName, plugin]));
  // Scope the in-section banner to bundled (local-path) installs so an npm-dialog
  // install failure does not surface its error in the bundled-plugins section.
  const installErrorMessage = installMutation.variables?.isLocalPath
    ? installMutation.error?.message ?? null
    : null;
  const errorSummaryByPluginId = useMemo(
    () =>
      new Map(
        installedPlugins.map((plugin) => [plugin.id, getPluginErrorSummary(plugin)])
      ),
    [installedPlugins, t]
  );

  if (isLoading && !plugins) return <div className="p-4 text-sm text-muted-foreground">{t("area.adapters-plugins-2.plugin-manager.loading")}</div>;
  if (error && !plugins) return <div className="p-4 text-sm text-destructive">{t("area.adapters-plugins-2.plugin-manager.loadFailed")}</div>;

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Puzzle className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{t("area.adapters-plugins-2.plugin-manager.title")}</h1>
        </div>
        
        <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              {t("area.adapters-plugins-2.plugin-manager.install.button")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("area.adapters-plugins-2.plugin-manager.install.title")}</DialogTitle>
              <DialogDescription>
                {t("area.adapters-plugins-2.plugin-manager.install.description")}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="packageName">{t("area.adapters-plugins-2.plugin-manager.install.packageNameLabel")}</Label>
                <Input
                  id="packageName"
                  placeholder={t("area.adapters-plugins-2.plugin-manager.install.packageNamePlaceholder")}
                  value={installPackage}
                  onChange={(e) => setInstallPackage(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInstallDialogOpen(false)}>{t("common.cancel")}</Button>
              <Button
                onClick={() => installMutation.mutate({ packageName: installPackage })}
                disabled={!installPackage || installMutation.isPending}
              >
                {installMutation.isPending ? t("area.adapters-plugins-2.plugin-manager.install.installing") : t("area.adapters-plugins-2.plugin-manager.install.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">{t("area.adapters-plugins-2.plugin-manager.alphaNotice.title")}</p>
            <p className="text-muted-foreground">
              {t("area.adapters-plugins-2.plugin-manager.alphaNotice.body")}
            </p>
          </div>
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">{t("area.adapters-plugins-2.plugin-manager.available.heading")}</h2>
          <Badge variant="outline">{t("area.adapters-plugins-2.plugin-manager.available.bundled")}</Badge>
        </div>

        {installErrorMessage && (
          <div className="rounded-md border border-destructive/25 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive whitespace-pre-wrap break-words">
            {installErrorMessage}
          </div>
        )}

        {bundledQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">{t("area.adapters-plugins-2.plugin-manager.available.loading")}</div>
        ) : bundledQuery.error ? (
          <div className="text-sm text-destructive">{t("area.adapters-plugins-2.plugin-manager.available.loadFailed")}</div>
        ) : bundledPlugins.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
            {t("area.adapters-plugins-2.plugin-manager.available.empty")}
          </div>
        ) : (
          <Card className="block py-0">
          <ul className="divide-y">
            {bundledPlugins.map((bundledPlugin) => {
              const installedPlugin = installedByPackageName.get(bundledPlugin.packageName);
              const installPending =
                installMutation.isPending &&
                installMutation.variables?.isLocalPath &&
                installMutation.variables.packageName === bundledPlugin.localPath;

              return (
                <li key={bundledPlugin.packageName}>
                  <div className="flex items-center gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{bundledPlugin.displayName}</span>
                        <Badge variant="outline">
                          {bundledPlugin.tag === "first-party" ? t("area.adapters-plugins-2.plugin-manager.tagFirstParty") : t("area.adapters-plugins-2.plugin-manager.tagExample")}
                        </Badge>
                        {isExperimentalPluginIdentity({
                          packageName: bundledPlugin.packageName,
                          packagePath: bundledPlugin.localPath,
                          bundledExperimental: bundledPlugin.experimental,
                        }) && <ExperimentalBadge />}
                        {installedPlugin ? (
                          <Badge
                            variant={installedPlugin.status === "ready" ? "default" : "secondary"}
                            className={installedPlugin.status === "ready" ? "bg-green-600 hover:bg-green-700" : ""}
                          >
                            {installedPlugin.status}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">{t("area.adapters-plugins-2.plugin-manager.available.notInstalled")}</Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{bundledPlugin.description}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{bundledPlugin.packageName}</p>
                      {installPending && !bundledPlugin.hasBuiltEntrypoints && (
                        <p className="mt-2 text-xs text-muted-foreground">{t("area.adapters-plugins-2.plugin-manager.available.building")}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {installedPlugin ? (
                        <>
                          {installedPlugin.status !== "ready" && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={enableMutation.isPending}
                              onClick={() => enableMutation.mutate(installedPlugin.id)}
                            >
                              {t("area.adapters-plugins-2.plugin-manager.enable")}
                            </Button>
                          )}
                          <Button variant="outline" size="sm" asChild>
                            <Link to={`/company/settings/instance/plugins/${installedPlugin.id}`}>
                              {installedPlugin.status === "ready" ? t("area.adapters-plugins-2.plugin-manager.available.openSettings") : t("area.adapters-plugins-2.plugin-manager.available.review")}
                            </Link>
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          disabled={installPending || installMutation.isPending}
                          onClick={() =>
                            installMutation.mutate({
                              packageName: bundledPlugin.localPath,
                              isLocalPath: true,
                            })
                          }
                        >
                          {installPending ? t("area.adapters-plugins-2.plugin-manager.install.installing") : t("area.adapters-plugins-2.plugin-manager.install.confirm")}
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          </Card>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Puzzle className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">{t("area.adapters-plugins-2.plugin-manager.installed.heading")}</h2>
        </div>

        {!installedPlugins.length ? (
          <Card className="bg-muted/30">
            <CardContent className="flex flex-col items-center justify-center py-10">
              <Puzzle className="h-10 w-10 text-muted-foreground mb-4" />
              <p className="text-sm font-medium">{t("area.adapters-plugins-2.plugin-manager.installed.emptyTitle")}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t("area.adapters-plugins-2.plugin-manager.installed.emptyHint")}
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="block py-0">
          <ul className="divide-y">
            {installedPlugins.map((plugin) => (
              <li key={plugin.id}>
                <div className="flex items-start gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/company/settings/instance/plugins/${plugin.id}`}
                        className="font-medium hover:underline truncate block"
                        title={pluginLabel(t, plugin.pluginKey, null, plugin.manifestJson.displayName ?? plugin.packageName)} // myrmidon(OPE-9352)
                      >
                        {pluginLabel(t, plugin.pluginKey, null, plugin.manifestJson.displayName ?? plugin.packageName) /* myrmidon(OPE-9352) */}
                      </Link>
                      {bundledByPackageName.has(plugin.packageName) && (
                        <Badge variant="outline">
                          {bundledByPackageName.get(plugin.packageName)?.tag === "first-party"
                            ? t("area.adapters-plugins-2.plugin-manager.tagFirstParty")
                            : t("area.adapters-plugins-2.plugin-manager.tagExample")}
                        </Badge>
                      )}
                      {isExperimentalPluginIdentity({
                        packageName: plugin.packageName,
                        packagePath: plugin.packagePath,
                        manifestJson: plugin.manifestJson,
                        bundledExperimental: bundledByPackageName.get(plugin.packageName)?.experimental,
                      }) && <ExperimentalBadge />}
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate" title={plugin.packageName}>
                        {plugin.packageName} · v{plugin.manifestJson.version ?? plugin.version}
                      </p>
                    </div>
                    <p className="text-sm text-muted-foreground truncate mt-0.5" title={plugin.manifestJson.description}>
                      {plugin.manifestJson.description || t("area.adapters-plugins-2.plugin-manager.installed.noDescription")}
                    </p>
                    {plugin.status === "error" && (
                      <div className="mt-3 rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2">
                        <div className="flex flex-wrap items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-300">
                              <AlertTriangle className="h-4 w-4 shrink-0" />
                              <span>{t("area.adapters-plugins-2.plugin-manager.installed.pluginError")}</span>
                            </div>
                            <p
                              className="mt-1 text-sm text-red-700/90 dark:text-red-200/90 break-words"
                              title={plugin.lastError ?? undefined}
                            >
                              {errorSummaryByPluginId.get(plugin.id)}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-red-500/30 bg-background/60 text-red-700 hover:bg-red-500/10 hover:text-red-800 dark:text-red-200 dark:hover:text-red-100"
                            onClick={() => setErrorDetailsPlugin(plugin)}
                          >
                            {t("area.adapters-plugins-2.plugin-manager.installed.viewFullError")}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 self-center">
                    <div className="flex flex-col items-end gap-2">
                      <div className="flex items-center gap-2">
                        {plugin.status === "ready" ? (
                          <Badge variant="default" className="shrink-0 bg-green-600 hover:bg-green-700">{plugin.status}</Badge>
                        ) : plugin.status === "error" ? (
                          <Badge variant="destructive" className="shrink-0">{plugin.status}</Badge>
                        ) : plugin.status === "disabled" ? (
                          <Badge variant="secondary" className="shrink-0">{plugin.status}</Badge>
                        ) : plugin.status === "upgrade_pending" ? (
                          <Badge variant="secondary" className="shrink-0">{plugin.status}</Badge>
                        ) : (
                          <Badge variant="secondary" className="shrink-0" role="status" aria-live="polite">
                            {t("area.adapters-plugins-2.plugin-manager.loading")}
                          </Badge>
                        )}
                        <Button
                          variant="outline"
                          size="icon-sm"
                          className="h-8 w-8"
                          title={plugin.status === "ready" ? t("area.adapters-plugins-2.plugin-manager.disable") : t("area.adapters-plugins-2.plugin-manager.enable")}
                          onClick={() => {
                            if (plugin.status === "ready") {
                              disableMutation.mutate(plugin.id);
                            } else if (plugin.status === "disabled" || plugin.status === "error") {
                              enableMutation.mutate(plugin.id);
                            }
                          }}
                          disabled={plugin.status !== "ready" && plugin.status !== "disabled" && plugin.status !== "error" || enableMutation.isPending || disableMutation.isPending}
                        >
                          <Power className={cn("h-4 w-4", plugin.status === "ready" ? "text-green-600" : "")} />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          title={t("area.adapters-plugins-2.plugin-manager.uninstall.confirm")}
                          onClick={() => {
                            setUninstallPluginId(plugin.id);
                            setUninstallPluginName(plugin.manifestJson.displayName ?? plugin.packageName);
                          }}
                          disabled={uninstallMutation.isPending}
                        >
                          <Trash className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="mt-2 flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={upgradeMutation.isPending}
                          onClick={() => {
                            setUpgradeError(null);
                            upgradeMutation.mutate({ pluginId: plugin.id });
                          }}
                        >
                          {t("area.adapters-plugins-2.plugin-manager.installed.upgrade")}
                        </Button>
                        <Button variant="outline" size="sm" className="h-8" asChild>
                          <Link to={`/company/settings/instance/plugins/${plugin.id}`}>
                            <Settings className="h-4 w-4" />
                            {t("area.adapters-plugins-2.plugin-manager.installed.configure")}
                          </Link>
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          </Card>
        )}
      </section>

      <Dialog
        open={upgradePrompt !== null}
        onOpenChange={(open: boolean) => { if (!open) setUpgradePrompt(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("area.adapters-plugins-2.plugin-manager.upgradeDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("area.adapters-plugins-2.plugin-manager.upgradeDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {upgradePrompt?.capabilities.map((capability) => <li key={capability}>{capability}</li>)}
          </ul>
          {upgradeError && <p className="text-sm text-destructive">{upgradeError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpgradePrompt(null)}>{t("common.cancel")}</Button>
            <Button
              disabled={!upgradePrompt || upgradeMutation.isPending}
              onClick={() => upgradePrompt && upgradeMutation.mutate({
                pluginId: upgradePrompt.plugin.id,
                approvedCapabilities: upgradePrompt.capabilities,
              })}
            >
              {upgradeMutation.isPending ? t("area.adapters-plugins-2.plugin-manager.upgradeDialog.upgrading") : t("area.adapters-plugins-2.plugin-manager.upgradeDialog.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={uninstallPluginId !== null}
        onOpenChange={(open: boolean) => { if (!open) setUninstallPluginId(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("area.adapters-plugins-2.plugin-manager.uninstall.title")}</DialogTitle>
            <DialogDescription>
              <Trans
                i18nKey="area.adapters-plugins-2.plugin-manager.uninstall.description"
                values={{ name: uninstallPluginName }}
                components={{ strong: <strong /> }}
              />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallPluginId(null)}>{t("common.cancel")}</Button>
            <Button
              variant="destructive"
              disabled={uninstallMutation.isPending}
              onClick={() => {
                if (uninstallPluginId) {
                  uninstallMutation.mutate(uninstallPluginId, {
                    onSettled: () => setUninstallPluginId(null),
                  });
                }
              }}
            >
              {uninstallMutation.isPending ? t("area.adapters-plugins-2.plugin-manager.uninstall.uninstalling") : t("area.adapters-plugins-2.plugin-manager.uninstall.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={errorDetailsPlugin !== null}
        onOpenChange={(open: boolean) => { if (!open) setErrorDetailsPlugin(null); }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("area.adapters-plugins-2.plugin-manager.errorDialog.title")}</DialogTitle>
            <DialogDescription>
{t("area.adapters-plugins-2.plugin-manager.errorDialog.description", {
                name:
                  errorDetailsPlugin?.manifestJson.displayName ??
                  errorDetailsPlugin?.packageName ??
                  t("area.adapters-plugins-2.plugin-manager.errorDialog.pluginFallback"),
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border border-red-500/25 bg-red-500/[0.06] px-4 py-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-red-700 dark:text-red-300">
                    {t("area.adapters-plugins-2.plugin-manager.errorDialog.whatErrored")}
                  </p>
                  <p className="text-red-700/90 dark:text-red-200/90 break-words">
                    {errorDetailsPlugin ? getPluginErrorSummary(errorDetailsPlugin) : t("area.adapters-plugins-2.plugin-manager.errorDialog.noSummary")}
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">{t("area.adapters-plugins-2.plugin-manager.errorDialog.fullOutput")}</p>
              <pre className="max-h-(--sz-50vh) overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-5 whitespace-pre-wrap break-words">
                {errorDetailsPlugin?.lastError ?? t("area.adapters-plugins-2.plugin-manager.errorDialog.noStoredMessage")}
              </pre>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setErrorDetailsPlugin(null)}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
