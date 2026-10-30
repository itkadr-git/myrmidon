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
import { useTranslation } from "@/i18n";
import { botDiskQuotaApi, botDiskQuotaQueryKey } from "./botDiskQuotaApi";

const CASTE_EXAMPLE = "engineer=20480\nreviewer=5120";
const AGENT_EXAMPLE = "0f5d1c7e-…-uuid=1024";

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

function formatEntries(entries: ReadonlyArray<Record<string, string | number>>, keyField: string): string {
  return entries.map((entry) => `${entry[keyField]}=${entry.quotaMb}`).join("\n");
}

export function BotDiskQuotaSettingsPanel() {
  const { t } = useTranslation();
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
    if (view && casteDraft === null) setCasteDraft(formatEntries(view.settings.perCaste, "casteKey"));
  }, [view, casteDraft]);
  useEffect(() => {
    if (view && agentDraft === null) setAgentDraft(formatEntries(view.settings.perAgent, "agentKey"));
  }, [view, agentDraft]);

  const save = useMutation({
    mutationFn: () => {
      const def = (defaultDraft ?? "").trim();
      let defaultQuotaMb: number | null;
      if (def === "") {
        defaultQuotaMb = null;
      } else {
        const parsed = Number(def);
        if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(t("area.settings-bots-host-1.bot-disk-quota-settings-panel.errDefault", { value: def }));
        defaultQuotaMb = parsed;
      }
      const castes = parseEntries(casteDraft ?? "");
      if (castes.bad) throw new Error(t("area.settings-bots-host-1.bot-disk-quota-settings-panel.errCaste", { line: castes.bad }));
      const agents = parseEntries(agentDraft ?? "");
      if (agents.bad) throw new Error(t("area.settings-bots-host-1.bot-disk-quota-settings-panel.errAgent", { line: agents.bad }));
      return botDiskQuotaApi.patch({
        defaultQuotaMb,
        perCaste: castes.entries.map((entry) => ({ casteKey: entry.key, quotaMb: entry.quotaMb })),
        perAgent: agents.entries.map((entry) => ({ agentKey: entry.key, quotaMb: entry.quotaMb })),
      });
    },
    onSuccess: (saved) => {
      setError(null);
      setDefaultDraft(saved.settings.defaultQuotaMb === null ? "" : String(saved.settings.defaultQuotaMb));
      setCasteDraft(formatEntries(saved.settings.perCaste, "casteKey"));
      setAgentDraft(formatEntries(saved.settings.perAgent, "agentKey"));
      queryClient.invalidateQueries({ queryKey: botDiskQuotaQueryKey });
    },
    onError: (err) => setError(err instanceof Error ? err.message : t("area.settings-bots-host-1.bot-disk-quota-settings-panel.saveFailed")),
  });

  const unchanged =
    view !== undefined &&
    (defaultDraft ?? "") === (view.settings.defaultQuotaMb === null ? "" : String(view.settings.defaultQuotaMb)) &&
    (casteDraft ?? "") === formatEntries(view.settings.perCaste, "casteKey") &&
    (agentDraft ?? "") === formatEntries(view.settings.perAgent, "agentKey");

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="bot-disk-quota-panel">
      <div className="flex items-center gap-2">
        <HardDrive className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t("area.settings-bots-host-1.bot-disk-quota-settings-panel.title")}</h3>
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-quota-default">{t("area.settings-bots-host-1.bot-disk-quota-settings-panel.defaultLabel")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="bot-disk-quota-default"
            placeholder={t("area.settings-bots-host-1.bot-disk-quota-settings-panel.defaultPlaceholder")}
            value={defaultDraft ?? ""}
            onChange={(event) => {
              setDefaultDraft(event.target.value);
              setError(null);
            }}
            data-testid="bot-disk-quota-default-input"
          />
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || defaultDraft === null || unchanged}>
            {save.isPending ? t("area.settings-bots-host-1.bot-disk-quota-settings-panel.saving") : t("common.save")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("area.settings-bots-host-1.bot-disk-quota-settings-panel.defaultHelp")}
        </p>
        {error && <p className="text-xs text-red-600">{error}</p>}
        {save.isSuccess && !error && <p className="text-xs text-green-600">{t("area.settings-bots-host-1.bot-disk-quota-settings-panel.saved")}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-quota-caste">{t("area.settings-bots-host-1.bot-disk-quota-settings-panel.casteLabel")}</Label>
        <Textarea
          id="bot-disk-quota-caste"
          rows={3}
          placeholder={CASTE_EXAMPLE}
          value={casteDraft ?? ""}
          onChange={(event) => {
            setCasteDraft(event.target.value);
            setError(null);
          }}
          data-testid="bot-disk-quota-caste-input"
        />
        <p className="text-xs text-muted-foreground">{t("area.settings-bots-host-1.bot-disk-quota-settings-panel.casteHelp")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-disk-quota-agent">{t("area.settings-bots-host-1.bot-disk-quota-settings-panel.agentLabel")}</Label>
        <Textarea
          id="bot-disk-quota-agent"
          rows={3}
          placeholder={AGENT_EXAMPLE}
          value={agentDraft ?? ""}
          onChange={(event) => {
            setAgentDraft(event.target.value);
            setError(null);
          }}
          data-testid="bot-disk-quota-agent-input"
        />
        <p className="text-xs text-muted-foreground">{t("area.settings-bots-host-1.bot-disk-quota-settings-panel.agentHelp")}</p>
      </div>
      {view?.lastSweep && (
        <p className="text-xs text-muted-foreground" data-testid="bot-disk-quota-last-sweep">
          {t("area.settings-bots-host-1.bot-disk-quota-settings-panel.lastSweep", { measured: view.lastSweep.measured, signalling: view.lastSweep.signalling, failed: view.lastSweep.failed })}
        </p>
      )}
    </section>
  );
}
