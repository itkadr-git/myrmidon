import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { queryKeys } from "@/lib/queryKeys";
import { useTranslation } from "@/i18n";
import type { SharedMountSettings } from "@myrmidon/shared";

export type SharedMountDraft = {
  enabled: boolean;
  writable: boolean;
  allowedBots: string;
};

export function toSharedMountDraft(stored?: SharedMountSettings): SharedMountDraft {
  return {
    enabled: stored?.enabled ?? false,
    writable: stored?.writable ?? false,
    allowedBots: stored?.allowedBots?.join(", ") ?? "",
  };
}

export function buildSharedMountPatch(draft: SharedMountDraft): SharedMountSettings | null {
  const bots = draft.allowedBots.split(",").map((id) => id.trim());
  if (bots.some((id) => id && !/^[a-zA-Z0-9_-]+$/.test(id))) return null;
  const allowedBots = bots.filter(Boolean);
  if (new Set(allowedBots).size !== allowedBots.length) return null;
  return { enabled: draft.enabled, writable: draft.writable, allowedBots };
}

export function SharedMountSettingsPanel() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.instance.generalSettings, queryFn: instanceSettingsApi.getGeneral });
  const [draft, setDraft] = useState<SharedMountDraft | null>(null);
  const current = draft ?? toSharedMountDraft(query.data?.sharedMount);
  const patch = buildSharedMountPatch(current);
  const save = useMutation({
    mutationFn: (value: SharedMountSettings) => instanceSettingsApi.updateGeneral({ sharedMount: value }),
    onSuccess: () => { setDraft(null); client.invalidateQueries({ queryKey: queryKeys.instance.generalSettings }); },
  });
  const key = "area.settings-bots-host-2.shared-mount-settings-panel";
  return (
    <section className="space-y-4 rounded-lg border border-border p-4" data-testid="shared-mount-settings">
      <h2 className="text-sm font-semibold">{t(`${key}.title`)}</h2>
      <p className="text-sm text-destructive">{t(`${key}.warning`)}</p>
      <p className="text-sm text-muted-foreground">{t(`${key}.path`, { path: query.data?.sharedMount?.hostPath || "MYRMIDON_BOT_VOLUME_ROOT/shared" })}</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={current.enabled} onChange={(event) => setDraft({ ...current, enabled: event.target.checked })} />{t(`${key}.enabled`)}</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={current.writable} onChange={(event) => setDraft({ ...current, writable: event.target.checked })} />{t(`${key}.writable`)}</label>
      <div className="space-y-1">
        <Label htmlFor="shared-mount-bots">{t(`${key}.allowedBots`)}</Label>
        <Input id="shared-mount-bots" value={current.allowedBots} onChange={(event) => setDraft({ ...current, allowedBots: event.target.value })} placeholder="bot-id-1, bot-id-2" />
        <p className="text-xs text-muted-foreground">{t(`${key}.emptyBots`)}</p>
        {!patch && <p className="text-xs text-destructive">{t(`${key}.invalidBots`)}</p>}
      </div>
      {save.error && <p role="alert" className="text-sm text-destructive">{t(`${key}.saveFailed`)}</p>}
      <Button disabled={!patch || !draft || query.isLoading || save.isPending} onClick={() => patch && save.mutate(patch)}>{t(`${key}.save`)}</Button>
    </section>
  );
}
