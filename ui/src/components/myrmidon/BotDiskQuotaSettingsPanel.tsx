// Per-bot disk quota (1.6.1-BOT-DISK-C): a company default in MB, per-caste and
// per-agent overrides. Saving applies without a restart: the sweep re-reads the
// settings at the top of every tick, and the workspace admission check reads
// them per request. Changing the settings is for instance admins; the server
// refuses anyone else. An empty default means the quota is enforced only where
// a caste, agent or card override sets one.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { botDiskQuotaApi, botDiskQuotaQueryKey } from "./botDiskQuotaApi";

/** Parse `key=MB` lines; returns the entries and the first bad line. */
function parseEntries<K extends string>(
  text: string,
): { entries: Array<{ key: K; quotaMb: number }>; bad: string | null } {
  const entries: Array<{ key: K; quotaMb: number }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const eq = line.lastIndexOf("=");
    const key = eq === -1 ? "" : line.slice(0, eq).trim();
    const value = eq === -1 ? NaN : Number(line.slice(eq + 1).trim());
    if (!key || !Number.isInteger(value) || value <= 0) return { entries: [], bad: line };
    entries.push({ key: key as K, quotaMb: value });
  }
  return { entries, bad: null };
}

function formatEntries(entries: ReadonlyArray<{ key: string; quotaMb: number }>): string {
  return entries.map((entry) => `${entry.key}=${entry.quotaMb}`).join("\n");
}

export function BotDiskQuotaSettingsPanel() {
  const queryClient = useQueryClient();
  const { data: view } = useQuery({ queryKey: botDiskQuotaQueryKey, queryFn: botDiskQuotaApi.get });
  const [defaultDraft, setDefaultDraft] = useState<string | null>(null);
  const [casteDraft, setCasteDraft] = useState<string | null>(null);
  const [agentDraft, setAgentDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed the drafts once the stored values arrive (react-query v5 has no onSuccess).
  useEffect(() => {
    if (view && defaultDraft === null) setDefaultDraft(view.settings.defaultQuotaMb === null ? "" : String(view.settings.defaultQuotaMb));
  }, [view, defaultDraft]);
  useEffect(() => {
    if (view && casteDraft === null) setCasteDraft(formatEntries(view.settings.perCaste));
  }, [view, casteDraft]);
  useEffect(() => {
    if (view && agentDraft === null) setAgentDraft(formatEntries(view.settings.perAgent));
  }, [view, agentDraft]);

  const save = useMutation({
    mutationFn: () => {
      const def = (defaultDraft ?? "").trim();
      let defaultQuotaMb: number | null;
      if (def === "") {
        defaultQuotaMb = null;
      } else {
        const parsed = Number(def);
        if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`"${def}" is not a positive whole number of MB`);
        defaultQuotaMb = parsed;
      }
      const castes = parseEntries(casteDraft ?? "");
      if (castes.bad) throw new Error(`"${castes.bad}" is not a "caste=MB" line`);
      const agents = parseEntries(agentDraft ?? "");
      if (agents.bad) throw new Error(`"${agents.bad}" is not a "agentId=MB" line`);
      return botDiskQuotaApi.patch({
        defaultQuotaMb,
        perCaste: castes.entries.map((entry) => ({ casteKey: entry.key, quotaMb: entry.quotaMb })),
        perAgent: agents.entries.map((entry) => ({ agentKey: entry.key, quotaMb: entry.quotaMb })),
      });
    },
    onSuccess: (saved) => {
      setError(null);
      setDefaultDraft(saved.settings.defaultQuotaMb === null ? "" : String(saved.settings.defaultQuotaMb));
      setCasteDraft(formatEntries(saved.settings.perCaste));
      setAgentDraft(formatEntries(saved.settings.perAgent));
      queryClient.invalidateQueries({ queryKey: botDiskQuotaQueryKey });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not save the quotas. Try again."),
  });

  const unchanged =
    view !== undefined &&
    (defaultDraft ?? "") === (view.settings.defaultQuotaMb === null ? "" : String(view.settings.defaultQuotaMb)) &&
    (casteDraft ?? "") === formatEntries(view.settings.perCaste) &&
    (agentDraft ?? "") === formatEntries(view.settings.perAgent);

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="bot-disk-quota-panel">
      <div className="flex items-center gap-2">
        <HardDrive className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Per-bot disk quota</h3>
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-quota-default">Default quota, MB</Label>
        <div className="flex items-center gap-2">
          <Input
            id="bot-disk-quota-default"
            placeholder="Empty: no quota unless an override sets one"
            value={defaultDraft ?? ""}
            onChange={(event) => {
              setDefaultDraft(event.target.value);
              setError(null);
            }}
            data-testid="bot-disk-quota-default-input"
          />
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || defaultDraft === null || unchanged}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Each bot&apos;s host volume (workspaces, scratch, profile) may not grow past this. A bot over quota gets
          no new workspace clone and raises an attention card; a bot at 80% raises the card without blocking.
          Overrides below win over the default; a bot card&apos;s container.diskQuotaMb wins over everything.
          Applies without a restart: the next maintenance tick and the next workspace check already use the new values.
        </p>
        {error && <p className="text-xs text-red-600">{error}</p>}
        {save.isSuccess && !error && <p className="text-xs text-green-600">Saved</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-quota-caste">Per-caste overrides</Label>
        <Textarea
          id="bot-disk-quota-caste"
          rows={3}
          placeholder={"engineer=20480\nreviewer=5120"}
          value={casteDraft ?? ""}
          onChange={(event) => {
            setCasteDraft(event.target.value);
            setError(null);
          }}
          data-testid="bot-disk-quota-caste-input"
        />
        <p className="text-xs text-muted-foreground">One &quot;caste=MB&quot; per line (the agent role).</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-quota-agent">Per-bot overrides</Label>
        <Textarea
          id="bot-disk-quota-agent"
          rows={3}
          placeholder={"0f5d1c7e-…-uuid=1024"}
          value={agentDraft ?? ""}
          onChange={(event) => {
            setAgentDraft(event.target.value);
            setError(null);
          }}
          data-testid="bot-disk-quota-agent-input"
        />
        <p className="text-xs text-muted-foreground">One &quot;agentId=MB&quot; per line; wins over the caste entry.</p>
      </div>
      {view?.lastSweep && (
        <p className="text-xs text-muted-foreground" data-testid="bot-disk-quota-last-sweep">
          Last sweep: {view.lastSweep.measured} measured, {view.lastSweep.signalling} signalling, {view.lastSweep.failed} failed.
        </p>
      )}
    </section>
  );
}
