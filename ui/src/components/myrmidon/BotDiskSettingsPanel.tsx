// Shared package cache of development bots (1.6.1-BOT-DISK-B): one host
// directory whose pnpm, Go and Gradle caches every bot on the default host
// mounts read-write. Saving applies on the next reconcile pass — bots are
// recreated with the new mounts — without restarting the server. Changing it
// is for instance admins; the server refuses anyone else.
//
// 1.6.2-BOT-DISK-C: the same panel lists the GitHub repositories the board
// keeps a shared bare git mirror of, so bot clones borrow objects instead of
// duplicating them.
//
// 1.6.5-BOT-DISK-H11: it also edits the shared bot runtime directory, whose
// bin, lazy-packages and lsp subdirectories every bot mounts read-only, so the
// runtime lives on the host once instead of once per bot.
//
// 1.6.5-BOT-DISK-H4d: the panel also shows the bot partition physically
// (dockergate, contract C5) and, per bot, quota/used, copies E/G/X, archives,
// the age of the botd report and the image generation, with the copies
// themselves (contract C4 reports).
//
// 1.6.6-SETTINGS-UI-B: the lifecycle fields themselves became editable — the
// draft-directory sweep (enabled + idle TTL), the five workspace-lifecycle
// numbers (closing grace, scratch TTL, the three partition thresholds) and the
// two layout knobs the panel did not expose yet (mirror refresh interval,
// shared-cache roles). Together with the fields part A/B/C/H11 already edited
// this is the full 14-field screen of the audit: 9 stored botDisk keys + the
// 5 workspace-lifecycle keys of the same `general.botDisk` object.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/i18n";
import type { BotDiskSettingsPatch } from "@paperclipai/shared";
import {
  BOT_DISK_DEFAULT_GIT_MIRROR_REFRESH_MS,
  BOT_DISK_DEFAULT_IDLE_TTL_MS,
  BOT_DISK_DEFAULT_SHARED_CACHE_ROLES,
  BOT_DISK_DEFAULT_UV_CACHE_DIR,
  BOT_DISK_DEFAULT_UV_LINK_MODE,
  BOT_DISK_UV_LINK_MODES,
  botDiskUvCacheDirProblem,
  BOT_DISK_MAX_GIT_MIRROR_REFRESH_MS,
  BOT_DISK_MAX_IDLE_TTL_MS,
  BOT_DISK_MIN_GIT_MIRROR_REFRESH_MS,
  BOT_DISK_MIN_IDLE_TTL_MS,
  WS_BOT_DISK_SETTING_DEFAULTS,
} from "@paperclipai/shared";
import { botDiskApi, botDiskQueryKey, type BotDiskView } from "./botDiskApi";
import {
  BOT_DISK_REPORT_STALE_MS,
  botDiskLifecycleApi,
  botDiskPhysicalQueryKey,
  botDiskReportsQueryKey,
  type BotDiskReportView,
} from "./botDiskLifecycleApi";
import { describeCopyState, formatBotDiskAge, formatBotDiskBytes } from "./BotDiskWorkspaceRow";

type Translate = (key: string, options?: Record<string, unknown>) => string;

function BotDiskLifecycleSection({ now, taskStatuses }: { now?: number; taskStatuses?: Record<string, string> }) {
  const { t } = useTranslation() as { t: Translate };
  const physical = useQuery({ queryKey: botDiskPhysicalQueryKey, queryFn: botDiskLifecycleApi.getPhysical, retry: false });
  const reportsQuery = useQuery({ queryKey: botDiskReportsQueryKey, queryFn: botDiskLifecycleApi.getReports, retry: false });
  const clock = now ?? Date.now();

  const partition = physical.data?.partition;
  const projects = Array.isArray(physical.data?.projects) ? physical.data.projects : [];
  const reports: BotDiskReportView[] = Array.isArray(reportsQuery.data?.reports) ? reportsQuery.data.reports : [];
  const loading = physical.isPending || reportsQuery.isPending;
  const botKeys = Array.from(new Set([...projects.map((p) => p.botKey), ...reports.map((r) => r.botKey)])).sort();

  return (
    <div className="space-y-3" data-testid="bot-disk-lifecycle">
      <h3 className="text-sm font-medium">{t("botDisk.title")}</h3>
      {loading ? (
        <p className="text-xs text-muted-foreground" data-testid="bot-disk-lifecycle-loading">
          {t("botDisk.loading")}
        </p>
      ) : !partition && botKeys.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="bot-disk-lifecycle-empty">
          {t("botDisk.noData")}
        </p>
      ) : (
        <>
          {partition && (
            <div className="space-y-1 text-xs" data-testid="bot-disk-partition">
              <p>
                <span className="font-medium">{t("botDisk.partition")}</span> {partition.mount}:{" "}
                {t("botDisk.partitionUsed", {
                  used: formatBotDiskBytes(partition.usedBytes),
                  total: formatBotDiskBytes(partition.totalBytes),
                  percent: partition.usedPercent,
                  free: formatBotDiskBytes(partition.freeBytes),
                })}
              </p>
              {physical.data?.other && (
                <p className="text-muted-foreground">
                  {t("botDisk.otherUsed", { size: formatBotDiskBytes(physical.data.other.usedBytes) })}
                </p>
              )}
              {physical.data?.quotaEnabled === false && (
                <p className="text-muted-foreground">{t("botDisk.quotaOff")}</p>
              )}
            </div>
          )}
          <table className="w-full text-left text-xs" data-testid="bot-disk-bots">
            <thead>
              <tr className="text-muted-foreground">
                <th className="pr-2 font-normal">{t("botDisk.colBot")}</th>
                <th className="pr-2 font-normal">{t("botDisk.colQuota")}</th>
                <th className="pr-2 font-normal">{t("botDisk.colCopies")}</th>
                <th className="pr-2 font-normal">{t("botDisk.colArchives")}</th>
                <th className="pr-2 font-normal">{t("botDisk.colReport")}</th>
                <th className="font-normal">{t("botDisk.colImage")}</th>
              </tr>
            </thead>
            <tbody>
              {botKeys.map((botKey) => {
                const project = projects.find((p) => p.botKey === botKey);
                const report = reports.find((r) => r.botKey === botKey);
                const copies = report?.copies ?? [];
                const count = (cls: "E" | "G" | "X") => copies.filter((c) => c.class === cls).length;
                const reportedAt = report ? Date.parse(report.at) : NaN;
                const ageMs = Number.isFinite(reportedAt) ? Math.max(0, clock - reportedAt) : null;
                const stale = ageMs !== null && ageMs > BOT_DISK_REPORT_STALE_MS;
                const percent = project && project.hardBytes > 0 ? Math.round((project.usedBytes / project.hardBytes) * 100) : null;
                const failed = Object.entries(report?.selfChecks ?? {})
                  .filter(([, value]) => value === false)
                  .map(([name]) => name);
                return (
                  <tr key={botKey} className="align-top" data-testid={`bot-disk-bot-${botKey}`}>
                    <td className="pr-2 font-medium">{botKey}</td>
                    <td className="pr-2" data-testid="bot-disk-quota-cell">
                      {project
                        ? `${formatBotDiskBytes(project.usedBytes)} / ${formatBotDiskBytes(project.hardBytes)}${percent === null ? "" : ` (${percent}%)`}`
                        : t("botDisk.noQuota")}
                    </td>
                    <td className="pr-2" data-testid="bot-disk-copies-cell">
                      {report?.copies ? `${count("E")}/${count("G")}/${count("X")}` : "—"}
                    </td>
                    <td className="pr-2">{report?.archives ? report.archives.length : "—"}</td>
                    <td className="pr-2" data-testid="bot-disk-report-cell" data-stale={stale ? "true" : "false"}>
                      {ageMs === null ? (
                        t("botDisk.noReport")
                      ) : (
                        <span className={stale ? "text-amber-600" : undefined}>
                          {t("botDisk.reportAge", { age: formatBotDiskAge(ageMs / 1000, t) })}
                          {stale ? ` — ${t("botDisk.reportStale", { minutes: BOT_DISK_REPORT_STALE_MS / 60000 })}` : ""}
                        </span>
                      )}
                      {failed.length > 0 && (
                        <span className="block text-red-600">{t("botDisk.selfChecksFailed", { checks: failed.join(", ") })}</span>
                      )}
                    </td>
                    <td>{report?.imageGeneration ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {reports
            .filter((report) => (report.copies ?? []).length > 0)
            .map((report) => (
              <div key={report.botKey} className="space-y-1" data-testid={`bot-disk-copies-${report.botKey}`}>
                <p className="text-xs font-medium">{t("botDisk.copiesHeading", { bot: report.botKey })}</p>
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="pr-2 font-normal">{t("botDisk.colKey")}</th>
                      <th className="pr-2 font-normal">{t("botDisk.colStatus")}</th>
                      <th className="pr-2 font-normal">{t("botDisk.colBranch")}</th>
                      <th className="pr-2 font-normal">{t("botDisk.colState")}</th>
                      <th className="font-normal">{t("botDisk.colAge")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.copies ?? []).map((copy) => (
                      <tr key={copy.path} data-testid="bot-disk-copy">
                        <td className="pr-2">
                          {copy.key ?? copy.path} <span className="text-muted-foreground">({t("botDisk.copyClass", { cls: copy.class })})</span>
                        </td>
                        <td className="pr-2">{(copy.key && taskStatuses?.[copy.key]) || "—"}</td>
                        <td className="pr-2">{copy.branch ?? "—"}</td>
                        <td className="pr-2">{describeCopyState(copy.clean, copy.pushed, t)}</td>
                        <td>{formatBotDiskAge(copy.ageSec, t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

/**
 * `taskStatuses` (task key -> status) fills the "task status" column of a copy;
 * the report itself carries no status (contract C4), so the caller that knows
 * the tasks supplies it, and an unknown key shows a dash.
 */
export function BotDiskSettingsPanel({ now, taskStatuses }: { now?: number; taskStatuses?: Record<string, string> } = {}) {
  const { t } = useTranslation() as { t: Translate };
  const queryClient = useQueryClient();
  const { data: view } = useQuery({ queryKey: botDiskQueryKey, queryFn: botDiskApi.get });
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reposDraft, setReposDraft] = useState<string | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [runtimeDraft, setRuntimeDraft] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  // Seed the draft once the stored value arrives (react-query v5 has no onSuccess).
  useEffect(() => {
    if (view && draft === null) setDraft(view.settings.sharedPackageCachePath ?? "");
  }, [view, draft]);
  useEffect(() => {
    if (view && reposDraft === null) setReposDraft((view.settings.gitMirrorRepos ?? []).join("\n"));
  }, [view, reposDraft]);
  useEffect(() => {
    if (view && runtimeDraft === null) setRuntimeDraft(view.settings.sharedBotRuntimePath ?? "");
  }, [view, runtimeDraft]);

  const saveRepos = useMutation({
    mutationFn: (repos: string[]) => botDiskApi.setGitMirrorRepos(repos.length === 0 ? null : repos),
    onSuccess: (saved) => {
      setReposError(null);
      setReposDraft((saved.settings.gitMirrorRepos ?? []).join("\n"));
      queryClient.invalidateQueries({ queryKey: botDiskQueryKey });
    },
    onError: (err) => setReposError(err instanceof Error ? err.message : t("area.settings-bots-host-1.bot-disk-settings-panel.errReposSave")),
  });

  const parseRepos = (text: string) =>
    text
      .split(/[\s,]+/)
      .map((name) => name.trim())
      .filter((name) => name !== "");

  const submitRepos = () => {
    const repos = parseRepos(reposDraft ?? "");
    const bad = repos.find((name) => !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(name) || name.toLowerCase().endsWith(".git"));
    if (bad) {
      setReposError(t("area.settings-bots-host-1.bot-disk-settings-panel.errRepos", { name: bad }));
      return;
    }
    saveRepos.mutate(repos);
  };

  // myrmidon(BOT-DISK-D): where pnpm keeps its store and how it imports packages.
  const [storeDraft, setStoreDraft] = useState<string | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  useEffect(() => {
    if (view && storeDraft === null) setStoreDraft(view.settings.pnpmStoreDir ?? "");
  }, [view, storeDraft]);
  const savePnpm = useMutation({
    mutationFn: botDiskApi.setPnpm,
    onSuccess: (saved) => {
      setStoreError(null);
      setStoreDraft(saved.settings.pnpmStoreDir ?? "");
      queryClient.invalidateQueries({ queryKey: botDiskQueryKey });
    },
    onError: (err) => setStoreError(err instanceof Error ? err.message : t("area.settings-bots-host-1.bot-disk-settings-panel.errPnpmSave")),
  });
  const submitStore = () => {
    const dir = (storeDraft ?? "").trim();
    if (dir !== "" && !["/workspace/", "/data/", "/scratch/", "/bot/"].some((root) => dir.startsWith(root))) {
      setStoreError(t("area.settings-bots-host-1.bot-disk-settings-panel.errStore"));
      return;
    }
    savePnpm.mutate({ pnpmStoreDir: dir === "" ? null : dir });
  };
  const storeUnchanged = view !== undefined && (storeDraft ?? "").trim() === (view.settings.pnpmStoreDir ?? "");

  const [uvCacheDirDraft, setUvCacheDirDraft] = useState<string | null>(null);
  const [uvError, setUvError] = useState<string | null>(null);
  useEffect(() => {
    if (view && uvCacheDirDraft === null) setUvCacheDirDraft(view.settings.uvCacheDir ?? "");
  }, [view, uvCacheDirDraft]);
  const saveUv = useMutation({
    mutationFn: botDiskApi.setUv,
    onSuccess: (saved) => {
      setUvError(null);
      setUvCacheDirDraft(saved.settings.uvCacheDir ?? "");
      queryClient.invalidateQueries({ queryKey: botDiskQueryKey });
    },
    onError: (err) => setUvError(err instanceof Error ? err.message : t("area.settings-bots-host-1.bot-disk-settings-panel.errUvSave")),
  });
  const submitUvCacheDir = () => {
    const dir = (uvCacheDirDraft ?? "").trim();
    if (dir !== "" && dir !== BOT_DISK_DEFAULT_UV_CACHE_DIR && dir.startsWith(`${BOT_DISK_DEFAULT_UV_CACHE_DIR}/`)) {
      setUvError(t("area.settings-bots-host-1.bot-disk-settings-panel.errUvDir", { dir: BOT_DISK_DEFAULT_UV_CACHE_DIR }));
      return;
    }
    const problem = botDiskUvCacheDirProblem(dir);
    if (dir !== "" && problem !== null) {
      setUvError(problem);
      return;
    }
    saveUv.mutate({ uvCacheDir: dir === "" ? null : dir });
  };
  const uvCacheUnchanged = view !== undefined && (uvCacheDirDraft ?? "").trim() === (view.settings.uvCacheDir ?? "");

  const reposUnchanged =
    view !== undefined && parseRepos(reposDraft ?? "").join("\n") === (view.settings.gitMirrorRepos ?? []).join("\n");

  // myrmidon(1.6.5-BOT-DISK-H11): the host directory whose bin, lazy-packages
  // and lsp subdirectories every bot mounts read-only over its own runtime.
  const saveRuntime = useMutation({
    mutationFn: (path: string) => botDiskApi.setSharedBotRuntimePath(path === "" ? null : path),
    onSuccess: (saved) => {
      setRuntimeError(null);
      setRuntimeDraft(saved.settings.sharedBotRuntimePath ?? "");
      queryClient.invalidateQueries({ queryKey: botDiskQueryKey });
    },
    onError: (err) => setRuntimeError(err instanceof Error ? err.message : t("area.settings-bots-host-1.bot-disk-settings-panel.errRuntimeSave")),
  });
  const submitRuntime = () => {
    const path = (runtimeDraft ?? "").trim();
    if (path !== "" && (!path.startsWith("/") || path.endsWith("/") || path.includes("//") || path.split("/").includes(".."))) {
      setRuntimeError(t("area.settings-bots-host-1.bot-disk-settings-panel.errAbsDir"));
      return;
    }
    saveRuntime.mutate(path);
  };
  const runtimeUnchanged = view !== undefined && (runtimeDraft ?? "").trim() === (view.settings.sharedBotRuntimePath ?? "");

  const save = useMutation({
    mutationFn: (path: string) => botDiskApi.setSharedPackageCachePath(path === "" ? null : path),
    onSuccess: (saved) => {
      setError(null);
      setDraft(saved.settings.sharedPackageCachePath ?? "");
      queryClient.invalidateQueries({ queryKey: botDiskQueryKey });
    },
    onError: (err) => setError(err instanceof Error ? err.message : t("area.settings-bots-host-1.bot-disk-settings-panel.errCacheSave")),
  });

  const submit = () => {
    const path = (draft ?? "").trim();
    if (path !== "" && (!path.startsWith("/") || path.endsWith("/") || path.split("/").includes(".."))) {
      setError(t("area.settings-bots-host-1.bot-disk-settings-panel.errAbsDir"));
      return;
    }
    save.mutate(path);
  };

  const unchanged = view !== undefined && (draft ?? "").trim() === (view.settings.sharedPackageCachePath ?? "");

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="bot-disk-panel">
      <div className="flex items-center gap-2">
        <Package className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t("area.settings-bots-host-1.bot-disk-settings-panel.cacheTitle")}</h3>
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-cache-path">{t("area.settings-bots-host-1.bot-disk-settings-panel.hostDir")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="bot-disk-cache-path"
            placeholder={t("area.settings-bots-host-1.bot-disk-settings-panel.cachePlaceholder")}
            value={draft ?? ""}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            data-testid="bot-disk-cache-path-input"
          />
          <Button size="sm" onClick={submit} disabled={save.isPending || draft === null || unchanged}>
            {save.isPending ? t("area.settings-bots-host-1.bot-disk-settings-panel.saving") : t("common.save")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("area.settings-bots-host-1.bot-disk-settings-panel.cacheHelp")}
        </p>
        {error && <p className="text-xs text-red-600">{error}</p>}
        {save.isSuccess && !error && <p className="text-xs text-green-600">{t("area.settings-bots-host-1.bot-disk-settings-panel.saved")}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-git-mirrors">{t("area.settings-bots-host-1.bot-disk-settings-panel.mirrorsLabel")}</Label>
        <Textarea
          id="bot-disk-git-mirrors"
          rows={3}
          placeholder={t("area.settings-bots-host-1.bot-disk-settings-panel.mirrorsPlaceholder")}
          value={reposDraft ?? ""}
          onChange={(event) => {
            setReposDraft(event.target.value);
            setReposError(null);
          }}
          disabled={!view?.settings.sharedPackageCachePath}
          data-testid="bot-disk-git-mirrors-input"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={submitRepos} disabled={saveRepos.isPending || reposDraft === null || reposUnchanged}>
            {saveRepos.isPending ? t("area.settings-bots-host-1.bot-disk-settings-panel.saving") : t("common.save")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("area.settings-bots-host-1.bot-disk-settings-panel.mirrorsHelp")}
        </p>
        {reposError && <p className="text-xs text-red-600">{reposError}</p>}
        {saveRepos.isSuccess && !reposError && <p className="text-xs text-green-600">{t("area.settings-bots-host-1.bot-disk-settings-panel.saved")}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-runtime-path">{t("area.settings-bots-host-1.bot-disk-settings-panel.runtimeLabel")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="bot-disk-runtime-path"
            placeholder={t("area.settings-bots-host-1.bot-disk-settings-panel.runtimePlaceholder")}
            value={runtimeDraft ?? ""}
            onChange={(event) => {
              setRuntimeDraft(event.target.value);
              setRuntimeError(null);
            }}
            data-testid="bot-disk-runtime-path-input"
          />
          <Button size="sm" onClick={submitRuntime} disabled={saveRuntime.isPending || runtimeDraft === null || runtimeUnchanged}>
            {saveRuntime.isPending ? t("area.settings-bots-host-1.bot-disk-settings-panel.saving") : t("common.save")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("area.settings-bots-host-1.bot-disk-settings-panel.runtimeHelp")}
        </p>
        {runtimeError && <p className="text-xs text-red-600">{runtimeError}</p>}
        {saveRuntime.isSuccess && !runtimeError && <p className="text-xs text-green-600">{t("area.settings-bots-host-1.bot-disk-settings-panel.saved")}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-pnpm-store">{t("area.settings-bots-host-1.bot-disk-settings-panel.pnpmStoreLabel")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="bot-disk-pnpm-store"
            placeholder={t("area.settings-bots-host-1.bot-disk-settings-panel.pnpmStorePlaceholder")}
            value={storeDraft ?? ""}
            onChange={(event) => {
              setStoreDraft(event.target.value);
              setStoreError(null);
            }}
            data-testid="bot-disk-pnpm-store-input"
          />
          <Button size="sm" onClick={submitStore} disabled={savePnpm.isPending || storeDraft === null || storeUnchanged}>
            {savePnpm.isPending ? t("area.settings-bots-host-1.bot-disk-settings-panel.saving") : t("common.save")}
          </Button>
        </div>
        <Label htmlFor="bot-disk-pnpm-import">{t("area.settings-bots-host-1.bot-disk-settings-panel.pnpmImportLabel")}</Label>
        <select
          id="bot-disk-pnpm-import"
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={view?.settings.pnpmImportMethod ?? "hardlink"}
          onChange={(event) =>
            savePnpm.mutate({
              pnpmImportMethod: event.target.value === "hardlink" ? null : (event.target.value as "clone-or-copy" | "copy"),
            })
          }
          disabled={savePnpm.isPending || !view}
          data-testid="bot-disk-pnpm-import-select"
        >
          <option value="hardlink">{t("area.settings-bots-host-1.bot-disk-settings-panel.pnpmHardlink")}</option>
          <option value="clone-or-copy">{t("area.settings-bots-host-1.bot-disk-settings-panel.pnpmCloneOrCopy")}</option>
          <option value="copy">{t("area.settings-bots-host-1.bot-disk-settings-panel.pnpmCopy")}</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {t("area.settings-bots-host-1.bot-disk-settings-panel.pnpmHelp")}
        </p>
        {storeError && <p className="text-xs text-red-600">{storeError}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-uv-cache">{t("area.settings-bots-host-1.bot-disk-settings-panel.uvCacheLabel")}</Label>
        <div className="flex items-center gap-2">
          <Input id="bot-disk-uv-cache" value={uvCacheDirDraft ?? ""} placeholder={BOT_DISK_DEFAULT_UV_CACHE_DIR}
            onChange={(event) => { setUvCacheDirDraft(event.target.value); setUvError(null); }}
            data-testid="bot-disk-uv-cache-input" />
          <Button size="sm" onClick={submitUvCacheDir} disabled={saveUv.isPending || uvCacheDirDraft === null || uvCacheUnchanged}>
            {saveUv.isPending ? t("area.settings-bots-host-1.bot-disk-settings-panel.saving") : t("common.save")}
          </Button>
        </div>
        <Label htmlFor="bot-disk-uv-link-mode">{t("area.settings-bots-host-1.bot-disk-settings-panel.uvLinkModeLabel")}</Label>
        <select id="bot-disk-uv-link-mode" className="h-8 rounded-md border bg-background px-2 text-sm"
          value={view?.settings.uvLinkMode ?? BOT_DISK_DEFAULT_UV_LINK_MODE}
          onChange={(event) => saveUv.mutate({ uvLinkMode: event.target.value as (typeof BOT_DISK_UV_LINK_MODES)[number] })}
          disabled={saveUv.isPending || !view} data-testid="bot-disk-uv-link-mode-select">
          {BOT_DISK_UV_LINK_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
        </select>
        <p className="text-xs text-muted-foreground">{t("area.settings-bots-host-1.bot-disk-settings-panel.uvHelp")}</p>
        {uvError && <p className="text-xs text-red-600">{uvError}</p>}
      </div>
      <BotDiskLifecycleEditSection view={view} queryClient={queryClient} />
      <BotDiskLifecycleSection now={now} taskStatuses={taskStatuses} />
    </section>
  );
}

/** Minutes <-> ms for the number inputs of the lifecycle section. */
const toMinutes = (ms: number) => Math.round(ms / 60000);
const toHours = (ms: number) => Math.round(ms / 3600000);

/**
 * myrmidon(1.6.6-SETTINGS-UI-B): the editable half of the lifecycle screen —
 * the nine `general.botDisk` keys the panels above did not expose: the sweep
 * switch, its idle TTL, the mirror refresh interval, the shared-cache roles
 * and the five workspace-lifecycle numbers. One Save button patches every
 * changed key in a single PATCH; a blank number returns its key to the
 * stored default (null), the same semantics the patch schema defines.
 */
function BotDiskLifecycleEditSection({
  view,
  queryClient,
}: {
  view: BotDiskView | undefined;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const { t } = useTranslation() as { t: Translate };
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [idleTtlMinutes, setIdleTtlMinutes] = useState<string | null>(null);
  const [refreshMinutes, setRefreshMinutes] = useState<string | null>(null);
  const [rolesDraft, setRolesDraft] = useState<string | null>(null);
  const [grace, setGrace] = useState<string | null>(null);
  const [scratch, setScratch] = useState<string | null>(null);
  const [threshold, setThreshold] = useState<string | null>(null);
  const [refuseOpen, setRefuseOpen] = useState<string | null>(null);
  const [critical, setCritical] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!view || enabled !== null) return;
    setEnabled(view.settings.enabled);
    setIdleTtlMinutes(String(toMinutes(view.settings.idleTtlMs)));
    setRefreshMinutes(String(toMinutes(view.settings.gitMirrorRefreshMs ?? BOT_DISK_DEFAULT_GIT_MIRROR_REFRESH_MS)));
    setRolesDraft((view.settings.sharedCacheRoles ?? BOT_DISK_DEFAULT_SHARED_CACHE_ROLES).join(", "));
    setGrace(view.settings.graceClosingMinutes === undefined ? "" : String(view.settings.graceClosingMinutes));
    setScratch(view.settings.scratchTtlHours === undefined ? "" : String(view.settings.scratchTtlHours));
    setThreshold(view.settings.partitionThresholdPercent === undefined ? "" : String(view.settings.partitionThresholdPercent));
    setRefuseOpen(view.settings.partitionRefuseOpenPercent === undefined ? "" : String(view.settings.partitionRefuseOpenPercent));
    setCritical(view.settings.partitionCriticalPercent === undefined ? "" : String(view.settings.partitionCriticalPercent));
  }, [view, enabled]);

  const save = useMutation({
    mutationFn: botDiskApi.setFields,
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: botDiskQueryKey });
    },
    onError: (err) => setError(err instanceof Error ? err.message : t("area.settings-bots-host-1.bot-disk-settings-panel.errLifecycleSave")),
  });

  if (!view) return null;

  const submit = () => {
    setError(null);
    const patch: BotDiskSettingsPatch = {};
    if (enabled !== view.settings.enabled) patch.enabled = enabled ?? view.settings.enabled;
    const idleMinutes = Number((idleTtlMinutes ?? "").trim() || toMinutes(BOT_DISK_DEFAULT_IDLE_TTL_MS));
    if (!Number.isInteger(idleMinutes) || idleMinutes * 60_000 < BOT_DISK_MIN_IDLE_TTL_MS || idleMinutes * 60_000 > BOT_DISK_MAX_IDLE_TTL_MS) {
      setError(t("area.settings-bots-host-1.bot-disk-settings-panel.errIdleTtl", { min: toMinutes(BOT_DISK_MIN_IDLE_TTL_MS), max: toHours(BOT_DISK_MAX_IDLE_TTL_MS) }));
      return;
    }
    if (idleMinutes * 60_000 !== view.settings.idleTtlMs) patch.idleTtlMs = idleMinutes * 60_000;
    const refresh = Number((refreshMinutes ?? "").trim() || toMinutes(BOT_DISK_DEFAULT_GIT_MIRROR_REFRESH_MS));
    if (!Number.isInteger(refresh) || refresh * 60_000 < BOT_DISK_MIN_GIT_MIRROR_REFRESH_MS || refresh * 60_000 > BOT_DISK_MAX_GIT_MIRROR_REFRESH_MS) {
      setError(t("area.settings-bots-host-1.bot-disk-settings-panel.errMirrorRefresh", { min: toMinutes(BOT_DISK_MIN_GIT_MIRROR_REFRESH_MS), max: toHours(BOT_DISK_MAX_GIT_MIRROR_REFRESH_MS) }));
      return;
    }
    if (refresh * 60_000 !== (view.settings.gitMirrorRefreshMs ?? BOT_DISK_DEFAULT_GIT_MIRROR_REFRESH_MS)) patch.gitMirrorRefreshMs = refresh * 60_000;
    const roles = (rolesDraft ?? "")
      .split(/[,\n]/)
      .map((role) => role.trim().toLowerCase())
      .filter(Boolean);
    if (roles.some((role) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(role))) {
      setError(t("area.settings-bots-host-1.bot-disk-settings-panel.errRoles"));
      return;
    }
    const currentRoles = view.settings.sharedCacheRoles ?? BOT_DISK_DEFAULT_SHARED_CACHE_ROLES;
    if (roles.join(",") !== currentRoles.join(",")) patch.sharedCacheRoles = roles;
    const numbers = [
      ["graceClosingMinutes", grace, WS_BOT_DISK_SETTING_DEFAULTS.graceClosingMinutes, 5, 24 * 60],
      ["scratchTtlHours", scratch, WS_BOT_DISK_SETTING_DEFAULTS.scratchTtlHours, 1, 24 * 30],
      ["partitionThresholdPercent", threshold, WS_BOT_DISK_SETTING_DEFAULTS.partitionThresholdPercent, 50, 100],
      ["partitionRefuseOpenPercent", refuseOpen, WS_BOT_DISK_SETTING_DEFAULTS.partitionRefuseOpenPercent, 50, 100],
      ["partitionCriticalPercent", critical, WS_BOT_DISK_SETTING_DEFAULTS.partitionCriticalPercent, 50, 100],
    ] as const;
    for (const [key, raw, fallback, min, max] of numbers) {
      const trimmed = (raw ?? "").trim();
      if (trimmed === "") {
        if (view.settings[key] !== undefined) patch[key] = null;
        continue;
      }
      const value = Number(trimmed);
      if (!Number.isInteger(value) || value < min || value > max) {
        setError(t("area.settings-bots-host-1.bot-disk-settings-panel.errNumber", { key, min, max, fallback }));
        return;
      }
      if (view.settings[key] !== value) patch[key] = value;
    }
    if (Object.keys(patch).length === 0) return;
    save.mutate(patch);
  };

  const changed =
    enabled !== view.settings.enabled ||
    (idleTtlMinutes ?? "") !== String(toMinutes(view.settings.idleTtlMs)) ||
    (refreshMinutes ?? "") !== String(toMinutes(view.settings.gitMirrorRefreshMs ?? BOT_DISK_DEFAULT_GIT_MIRROR_REFRESH_MS)) ||
    (rolesDraft ?? "") !== (view.settings.sharedCacheRoles ?? BOT_DISK_DEFAULT_SHARED_CACHE_ROLES).join(", ") ||
    (grace ?? "") !== (view.settings.graceClosingMinutes === undefined ? "" : String(view.settings.graceClosingMinutes)) ||
    (scratch ?? "") !== (view.settings.scratchTtlHours === undefined ? "" : String(view.settings.scratchTtlHours)) ||
    (threshold ?? "") !== (view.settings.partitionThresholdPercent === undefined ? "" : String(view.settings.partitionThresholdPercent)) ||
    (refuseOpen ?? "") !== (view.settings.partitionRefuseOpenPercent === undefined ? "" : String(view.settings.partitionRefuseOpenPercent)) ||
    (critical ?? "") !== (view.settings.partitionCriticalPercent === undefined ? "" : String(view.settings.partitionCriticalPercent));

  const numberField = (
    id: string,
    label: string,
    value: string,
    setValue: (v: string) => void,
    placeholder: string,
    hint: string,
  ) => (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        data-testid={`bot-disk-lifecycle-${id}`}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );

  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="bot-disk-lifecycle-edit">
      <h3 className="text-sm font-medium">{t("area.settings-bots-host-1.bot-disk-settings-panel.lifecycleTitle")}</h3>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled ?? view.settings.enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          data-testid="bot-disk-lifecycle-enabled"
        />
        {t("area.settings-bots-host-1.bot-disk-settings-panel.sweepEnabled")}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        {numberField(
          "bot-disk-idle-ttl",
          t("area.settings-bots-host-1.bot-disk-settings-panel.idleTtlLabel"),
          idleTtlMinutes ?? "",
          setIdleTtlMinutes,
          String(toMinutes(BOT_DISK_DEFAULT_IDLE_TTL_MS)),
          t("area.settings-bots-host-1.bot-disk-settings-panel.idleTtlHint"),
        )}
        {numberField(
          "bot-disk-mirror-refresh",
          t("area.settings-bots-host-1.bot-disk-settings-panel.mirrorRefreshLabel"),
          refreshMinutes ?? "",
          setRefreshMinutes,
          String(toMinutes(BOT_DISK_DEFAULT_GIT_MIRROR_REFRESH_MS)),
          t("area.settings-bots-host-1.bot-disk-settings-panel.mirrorRefreshHint"),
        )}
        {numberField(
          "graceClosingMinutes",
          t("area.settings-bots-host-1.bot-disk-settings-panel.graceLabel"),
          grace ?? "",
          setGrace,
          t("area.settings-bots-host-1.bot-disk-settings-panel.placeholderDefault", { value: WS_BOT_DISK_SETTING_DEFAULTS.graceClosingMinutes }),
          t("area.settings-bots-host-1.bot-disk-settings-panel.graceHint"),
        )}
        {numberField(
          "scratchTtlHours",
          t("area.settings-bots-host-1.bot-disk-settings-panel.scratchLabel"),
          scratch ?? "",
          setScratch,
          t("area.settings-bots-host-1.bot-disk-settings-panel.placeholderDefault", { value: WS_BOT_DISK_SETTING_DEFAULTS.scratchTtlHours }),
          t("area.settings-bots-host-1.bot-disk-settings-panel.scratchHint"),
        )}
        {numberField(
          "partitionThresholdPercent",
          t("area.settings-bots-host-1.bot-disk-settings-panel.thresholdLabel"),
          threshold ?? "",
          setThreshold,
          t("area.settings-bots-host-1.bot-disk-settings-panel.placeholderDefault", { value: WS_BOT_DISK_SETTING_DEFAULTS.partitionThresholdPercent }),
          t("area.settings-bots-host-1.bot-disk-settings-panel.thresholdHint"),
        )}
        {numberField(
          "partitionRefuseOpenPercent",
          t("area.settings-bots-host-1.bot-disk-settings-panel.refuseLabel"),
          refuseOpen ?? "",
          setRefuseOpen,
          t("area.settings-bots-host-1.bot-disk-settings-panel.placeholderDefault", { value: WS_BOT_DISK_SETTING_DEFAULTS.partitionRefuseOpenPercent }),
          t("area.settings-bots-host-1.bot-disk-settings-panel.refuseHint"),
        )}
        {numberField(
          "partitionCriticalPercent",
          t("area.settings-bots-host-1.bot-disk-settings-panel.criticalLabel"),
          critical ?? "",
          setCritical,
          t("area.settings-bots-host-1.bot-disk-settings-panel.placeholderDefault", { value: WS_BOT_DISK_SETTING_DEFAULTS.partitionCriticalPercent }),
          t("area.settings-bots-host-1.bot-disk-settings-panel.criticalHint"),
        )}
        <div className="space-y-1">
          <Label htmlFor="bot-disk-shared-cache-roles">{t("area.settings-bots-host-1.bot-disk-settings-panel.rolesLabel")}</Label>
          <Input
            id="bot-disk-shared-cache-roles"
            value={rolesDraft ?? ""}
            placeholder={BOT_DISK_DEFAULT_SHARED_CACHE_ROLES.join(", ")}
            onChange={(event) => setRolesDraft(event.target.value)}
            data-testid="bot-disk-lifecycle-roles"
          />
          <p className="text-xs text-muted-foreground">
            {t("area.settings-bots-host-1.bot-disk-settings-panel.rolesHint")}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={submit} disabled={save.isPending || !changed}>
          {save.isPending ? t("area.settings-bots-host-1.bot-disk-settings-panel.saving") : t("area.settings-bots-host-1.bot-disk-settings-panel.saveLifecycle")}
        </Button>
        {save.isSuccess && !error && <span className="text-xs text-green-600">{t("area.settings-bots-host-1.bot-disk-settings-panel.saved")}</span>}
      </div>
      {error && <p className="text-xs text-red-600" data-testid="bot-disk-lifecycle-error">{error}</p>}
      <p className="text-xs text-muted-foreground">
        {t("area.settings-bots-host-1.bot-disk-settings-panel.sources", {
          enabled: view.sources.enabled === "settings" ? t("area.settings-bots-host-1.bot-disk-settings-panel.sourceStored") : view.sources.enabled,
          ttl: view.sources.idleTtlMs === "settings" ? t("area.settings-bots-host-1.bot-disk-settings-panel.sourceStored") : view.sources.idleTtlMs,
        })}
      </p>
    </div>
  );
}
