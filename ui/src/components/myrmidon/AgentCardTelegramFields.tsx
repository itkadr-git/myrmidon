// myrmidon(1.6.5-TG-LOCALE-D): the "Telegram" section of an agent card —
// the aliases the bridge answers to and the group the /agents list puts the
// card in.
//
// Both live in `agents.metadata` (telegramAliases / telegramGroup), which the
// existing PATCH /api/agents/:id already accepts. The save is immediate, like
// the nests and egress sections: the bridge reads the card fresh on its next
// pass, so no restart or redeploy is needed.
//
// The patch is built from a FRESH GET of the agent and touches only the two
// keys, so every other metadata entry survives (see lib/telegram-card-fields).
// The view half is pure so the suite renders it without a query client.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { agentsApi } from "../../api/agents";
import { CollapsibleSection, Field } from "../agent-config-primitives";
import { useCompany } from "../../context/CompanyContext";
import { queryKeys } from "../../lib/queryKeys";
import {
  buildTelegramMetadataPatch,
  collectTelegramGroupOptions,
  defaultTelegramAliasFromName,
  isValidTelegramAlias,
  normalizeTelegramAlias,
  readStoredTelegramAliases,
  readStoredTelegramGroup,
} from "../../lib/telegram-card-fields";

export interface AgentCardTelegramFieldsViewProps {
  aliases: string[];
  defaultAlias: string;
  group: string;
  groupOptions: string[];
  draftAlias: string;
  aliasError: string | null;
  canAdd: boolean;
  saving: boolean;
  canSave: boolean;
  error: string | null;
  savedNote: string | null;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (alias: string) => void;
  onGroupChange: (value: string) => void;
  onSave: () => void;
}

const DATALIST_ID = "myrmidon-telegram-group-options";

export function AgentCardTelegramFieldsView({
  aliases,
  defaultAlias,
  group,
  groupOptions,
  draftAlias,
  aliasError,
  canAdd,
  saving,
  canSave,
  error,
  savedNote,
  onDraftChange,
  onAdd,
  onRemove,
  onGroupChange,
  onSave,
}: AgentCardTelegramFieldsViewProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  return (
    <CollapsibleSection title={t("telegramCard.title")} open={open} onToggle={() => setOpen((v) => !v)}>
      <div className="space-y-3" data-testid="myrmidon-agent-telegram">
        <p className="text-xs text-muted-foreground">{t("telegramCard.intro")}</p>

        <Field label={t("telegramCard.aliasesLabel")} hint={t("telegramCard.aliasesHint")}>
          <div className="space-y-1.5">
            {aliases.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="myrmidon-agent-telegram-default">
                {defaultAlias
                  ? t("telegramCard.defaultAliasNote", { alias: defaultAlias })
                  : t("telegramCard.noDefaultAliasNote")}
              </p>
            ) : (
              aliases.map((alias) => (
                <div
                  key={alias}
                  className="flex items-center gap-2"
                  data-testid={`myrmidon-agent-telegram-alias-${alias}`}
                >
                  <span className="flex-1 truncate font-mono text-xs">@{alias}</span>
                  <button
                    type="button"
                    aria-label={t("telegramCard.removeAlias")}
                    data-testid={`myrmidon-agent-telegram-alias-remove-${alias}`}
                    className="text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => onRemove(alias)}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={draftAlias}
                onChange={(event) => onDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (canAdd) onAdd();
                  }
                }}
                placeholder={t("telegramCard.addPlaceholder")}
                className="flex-1 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40"
                data-testid="myrmidon-agent-telegram-alias-input"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onAdd}
                disabled={!canAdd}
                data-testid="myrmidon-agent-telegram-alias-add"
              >
                {t("telegramCard.add")}
              </Button>
            </div>
            {aliasError && (
              <p className="text-xs text-destructive" data-testid="myrmidon-agent-telegram-alias-error">
                {aliasError}
              </p>
            )}
          </div>
        </Field>

        <Field label={t("telegramCard.groupLabel")} hint={t("telegramCard.groupHint")}>
          <input
            type="text"
            list={groupOptions.length > 0 ? DATALIST_ID : undefined}
            value={group}
            onChange={(event) => onGroupChange(event.target.value)}
            placeholder={t("telegramCard.groupPlaceholder")}
            className="w-full bg-transparent outline-none text-sm placeholder:text-muted-foreground/40"
            data-testid="myrmidon-agent-telegram-group-input"
          />
          {groupOptions.length > 0 && (
            <datalist id={DATALIST_ID}>
              {groupOptions.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          )}
        </Field>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onSave}
            disabled={saving || !canSave}
            data-testid="myrmidon-agent-telegram-save"
          >
            {saving ? t("telegramCard.saving") : t("telegramCard.save")}
          </Button>
          {savedNote && (
            <span className="text-xs text-muted-foreground" data-testid="myrmidon-agent-telegram-saved">
              {savedNote}
            </span>
          )}
        </div>
        {error && (
          <p className="text-xs text-destructive" data-testid="myrmidon-agent-telegram-error">
            {error}
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}

/** The connected section: reads the card metadata and saves through the PATCH. */
export function AgentCardTelegramFields({
  agentId,
  agentName,
  metadata,
}: {
  agentId: string;
  agentName: string;
  metadata: unknown;
}) {
  const { selectedCompanyId } = useCompany();
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const storedAliases = useMemo(() => readStoredTelegramAliases(metadata) ?? [], [metadata]);
  const storedGroup = useMemo(() => readStoredTelegramGroup(metadata) ?? "", [metadata]);

  const [aliases, setAliases] = useState<string[]>(storedAliases);
  const [group, setGroup] = useState<string>(storedGroup);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // A fresh card from the server clears the unsaved edit.
  const storedKey = JSON.stringify([storedAliases, storedGroup]);
  useEffect(() => {
    const [nextAliases, nextGroup] = JSON.parse(storedKey) as [string[], string];
    setAliases(nextAliases);
    setGroup(nextGroup);
  }, [storedKey]);

  const companyAgents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "none"),
    queryFn: () => agentsApi.list(selectedCompanyId as string),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });
  const groupOptions = useMemo(
    () => collectTelegramGroupOptions(companyAgents.data ?? []),
    [companyAgents.data],
  );

  const normalizedDraft = normalizeTelegramAlias(draft);
  const aliasError =
    normalizedDraft.length === 0 || isValidTelegramAlias(normalizedDraft)
      ? null
      : t("telegramCard.invalidAlias");
  const duplicate = normalizedDraft.length > 0 && aliases.includes(normalizedDraft);
  const canAdd = normalizedDraft.length > 0 && aliasError === null && !duplicate;

  const dirty =
    JSON.stringify(aliases) !== JSON.stringify(storedAliases) || group.trim() !== storedGroup.trim();

  const save = useMutation({
    // Merge from the FRESH read so metadata keys added since the card was
    // opened (or by another tab) survive the write.
    mutationFn: async (next: { aliases: string[]; group: string }) => {
      const fresh = await agentsApi.get(agentId, selectedCompanyId ?? undefined);
      const merged = buildTelegramMetadataPatch(fresh.metadata, {
        aliases: next.aliases,
        group: next.group.trim() || null,
      });
      return agentsApi.update(
        agentId,
        { metadata: merged },
        selectedCompanyId ?? undefined,
      );
    },
    onSuccess: () => {
      setError(null);
      setSavedNote(t("telegramCard.saved"));
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
      }
    },
    onError: (err) => {
      setSavedNote(null);
      setError(err instanceof Error ? err.message : t("telegramCard.saveFailed"));
    },
  });

  return (
    <AgentCardTelegramFieldsView
      aliases={aliases}
      defaultAlias={defaultTelegramAliasFromName(agentName)}
      group={group}
      groupOptions={groupOptions}
      draftAlias={draft}
      aliasError={duplicate ? t("telegramCard.duplicateAlias") : aliasError}
      canAdd={canAdd}
      saving={save.isPending}
      canSave={dirty}
      error={error}
      savedNote={savedNote}
      onDraftChange={(value) => {
        setSavedNote(null);
        setDraft(value);
      }}
      onAdd={() => {
        if (!canAdd) return;
        setSavedNote(null);
        setAliases((current) => [...current, normalizedDraft]);
        setDraft("");
      }}
      onRemove={(alias) => {
        setSavedNote(null);
        setAliases((current) => current.filter((entry) => entry !== alias));
      }}
      onGroupChange={(value) => {
        setSavedNote(null);
        setGroup(value);
      }}
      onSave={() => {
        setError(null);
        setSavedNote(null);
        save.mutate({ aliases, group });
      }}
    />
  );
}
