// Shared package cache of development bots (1.6.1-BOT-DISK-B): one host
// directory whose pnpm, Go and Gradle caches every bot on the default host
// mounts read-write. Saving applies on the next reconcile pass — bots are
// recreated with the new mounts — without restarting the server. Changing it
// is for instance admins; the server refuses anyone else.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { botDiskApi, botDiskQueryKey } from "./botDiskApi";

export function BotDiskSettingsPanel() {
  const queryClient = useQueryClient();
  const { data: view } = useQuery({ queryKey: botDiskQueryKey, queryFn: botDiskApi.get });
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed the draft once the stored value arrives (react-query v5 has no onSuccess).
  useEffect(() => {
    if (view && draft === null) setDraft(view.sharedPackageCachePath ?? "");
  }, [view, draft]);

  const save = useMutation({
    mutationFn: (path: string) => botDiskApi.update({ sharedPackageCachePath: path === "" ? null : path }),
    onSuccess: (saved) => {
      setError(null);
      setDraft(saved.sharedPackageCachePath ?? "");
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

  const unchanged = view !== undefined && (draft ?? "").trim() === (view.sharedPackageCachePath ?? "");

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
    </section>
  );
}
