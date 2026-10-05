// Shared package cache of development bots (1.6.1-BOT-DISK-B): one host
// directory whose pnpm, Go and Gradle caches every bot on the default host
// mounts read-write. Saving applies on the next reconcile pass — bots are
// recreated with the new mounts — without restarting the server. Changing it
// is for instance admins; the server refuses anyone else.
//
// 1.6.2-BOT-DISK-C: the same panel lists the GitHub repositories the board
// keeps a shared bare git mirror of, so bot clones borrow objects instead of
// duplicating them.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { botDiskApi, botDiskQueryKey } from "./botDiskApi";

export function BotDiskSettingsPanel() {
  const queryClient = useQueryClient();
  const { data: view } = useQuery({ queryKey: botDiskQueryKey, queryFn: botDiskApi.get });
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reposDraft, setReposDraft] = useState<string | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);

  // Seed the draft once the stored value arrives (react-query v5 has no onSuccess).
  useEffect(() => {
    if (view && draft === null) setDraft(view.settings.sharedPackageCachePath ?? "");
  }, [view, draft]);
  useEffect(() => {
    if (view && reposDraft === null) setReposDraft((view.settings.gitMirrorRepos ?? []).join("\n"));
  }, [view, reposDraft]);

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
    </section>
  );
}
