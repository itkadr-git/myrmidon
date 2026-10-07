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
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/i18n";
import { botDiskApi, botDiskQueryKey } from "./botDiskApi";
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
    onError: (err) => setReposError(err instanceof Error ? err.message : "Could not save the repositories. Try again."),
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
      setReposError(`"${bad}" is not an owner/repo name`);
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
    onError: (err) => setStoreError(err instanceof Error ? err.message : "Could not save the pnpm settings. Try again."),
  });
  const submitStore = () => {
    const dir = (storeDraft ?? "").trim();
    if (dir !== "" && !["/workspace/", "/data/", "/scratch/", "/bot/"].some((root) => dir.startsWith(root))) {
      setStoreError("The store must be inside the bot's single mount: under /workspace, /data, /scratch or /bot");
      return;
    }
    savePnpm.mutate({ pnpmStoreDir: dir === "" ? null : dir });
  };
  const storeUnchanged = view !== undefined && (storeDraft ?? "").trim() === (view.settings.pnpmStoreDir ?? "");

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
    onError: (err) => setRuntimeError(err instanceof Error ? err.message : "Could not save the runtime path. Try again."),
  });
  const submitRuntime = () => {
    const path = (runtimeDraft ?? "").trim();
    if (path !== "" && (!path.startsWith("/") || path.endsWith("/") || path.includes("//") || path.split("/").includes(".."))) {
      setRuntimeError("Enter an absolute directory without a trailing slash or \"..\", or leave it empty");
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
    onError: (err) => setError(err instanceof Error ? err.message : "Could not save the cache path. Try again."),
  });

  const submit = () => {
    const path = (draft ?? "").trim();
    if (path !== "" && (!path.startsWith("/") || path.endsWith("/") || path.split("/").includes(".."))) {
      setError("Enter an absolute directory without a trailing slash or \"..\", or leave it empty");
      return;
    }
    save.mutate(path);
  };

  const unchanged = view !== undefined && (draft ?? "").trim() === (view.settings.sharedPackageCachePath ?? "");

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="bot-disk-panel">
      <div className="flex items-center gap-2">
        <Package className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Shared package cache for bots</h3>
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-cache-path">Host directory</Label>
        <div className="flex items-center gap-2">
          <Input
            id="bot-disk-cache-path"
            placeholder="Empty: every bot keeps its own cache"
            value={draft ?? ""}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            data-testid="bot-disk-cache-path-input"
          />
          <Button size="sm" onClick={submit} disabled={save.isPending || draft === null || unchanged}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Bots on this server mount its pnpm, go-mod, go-build and gradle
          subdirectories and share the downloads. The same path must be set as
          packageCacheRoot in the dockergate configuration, and the
          subdirectories must exist and belong to the bot user. Applies on the
          next reconcile pass: bots are recreated with the new mounts. Bots on
          a fleet host are not affected.
        </p>
        {error && <p className="text-xs text-red-600">{error}</p>}
        {save.isSuccess && !error && <p className="text-xs text-green-600">Saved</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-git-mirrors">Mirrored GitHub repositories</Label>
        <Textarea
          id="bot-disk-git-mirrors"
          rows={3}
          placeholder="owner/repo, one per line. Empty: bots clone with a full object store each"
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
            {saveRepos.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Needs the shared cache above. The board keeps one bare mirror of each
          repository under its git subdirectory and refreshes it by fetch; bots
          mount it read-only and a clone of that repository borrows its
          objects. The subdirectory must exist and belong to the server user.
          Applies on the next reconcile pass.
        </p>
        {reposError && <p className="text-xs text-red-600">{reposError}</p>}
        {saveRepos.isSuccess && !reposError && <p className="text-xs text-green-600">Saved</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-runtime-path">Shared bot runtime directory</Label>
        <div className="flex items-center gap-2">
          <Input
            id="bot-disk-runtime-path"
            placeholder="Empty: every bot keeps its own bin, lazy-packages and lsp"
            value={runtimeDraft ?? ""}
            onChange={(event) => {
              setRuntimeDraft(event.target.value);
              setRuntimeError(null);
            }}
            data-testid="bot-disk-runtime-path-input"
          />
          <Button size="sm" onClick={submitRuntime} disabled={saveRuntime.isPending || runtimeDraft === null || runtimeUnchanged}>
            {saveRuntime.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Bots on this server mount its bin, lazy-packages and lsp
          subdirectories read-only over their own runtime paths, so the runtime
          lives on the host once instead of once per bot. The same path must be
          set as botRuntimeRoot in the dockergate configuration, and the
          subdirectories must exist and belong to the bot user. Applies on the
          next reconcile pass: bots are recreated with the new mounts. Bots on
          a fleet host are not affected.
        </p>
        {runtimeError && <p className="text-xs text-red-600">{runtimeError}</p>}
        {saveRuntime.isSuccess && !runtimeError && <p className="text-xs text-green-600">Saved</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-pnpm-store">pnpm store directory</Label>
        <div className="flex items-center gap-2">
          <Input
            id="bot-disk-pnpm-store"
            placeholder="Empty: /workspace/.pnpm-store"
            value={storeDraft ?? ""}
            onChange={(event) => {
              setStoreDraft(event.target.value);
              setStoreError(null);
            }}
            data-testid="bot-disk-pnpm-store-input"
          />
          <Button size="sm" onClick={submitStore} disabled={savePnpm.isPending || storeDraft === null || storeUnchanged}>
            {savePnpm.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        <Label htmlFor="bot-disk-pnpm-import">pnpm import method</Label>
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
          <option value="hardlink">hardlink (default)</option>
          <option value="clone-or-copy">clone-or-copy</option>
          <option value="copy">copy (every clone holds a full copy)</option>
        </select>
        <p className="text-xs text-muted-foreground">
          A bot container has ONE mount for its whole tree, so a hard link works
          between its store and any clone. The store must be inside that mount;
          /cache/pnpm stays a download cache. Applies on the next reconcile
          pass without restarting the server. Each bot checks hard links into
          /data/hermes, /workspace and /scratch at start and reports a failure
          here as an attention card.
        </p>
        {storeError && <p className="text-xs text-red-600">{storeError}</p>}
      </div>
      <BotDiskLifecycleSection now={now} taskStatuses={taskStatuses} />
    </section>
  );
}
