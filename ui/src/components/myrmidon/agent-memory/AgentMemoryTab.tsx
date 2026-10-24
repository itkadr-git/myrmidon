// myrmidon(MEMORY-UI): the Memory tab of the agent card.
// Lists the agent's memory bank entries, exports the whole bank as JSON and
// removes entries (soft invalidation), with a destructive clear-bank action
// behind a typed confirmation. Server side: server/src/myrmidon/agent-memory.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Download, Loader2, Trash2 } from "lucide-react";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { i18n, useTranslation } from "@/i18n";
import {
  downloadMemoryExport,
  formatMemoryDate,
  memoriesKey,
  memoryApi,
  memoryStatusKey,
  type MemoryCardStatus,
  type MemoryPageView,
} from "./memoryApi";

const PAGE_SIZE = 50;

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || i18n.t("area.settings-agent-card.agent-memory-tab.requestFailed", { status: error.status });
  if (error instanceof Error) return error.message;
  return i18n.t("area.settings-agent-card.agent-memory-tab.unexpectedError");
}

function statusLine(status: MemoryCardStatus | undefined, error: unknown): string {
  if (error) return readable(error);
  if (!status) return i18n.t("area.settings-agent-card.agent-memory-tab.statusLoading");
  if (!status.enabled) return i18n.t("area.settings-agent-card.agent-memory-tab.statusDisabled");
  if (!status.bank) return i18n.t("area.settings-agent-card.agent-memory-tab.statusNoBank");
  return status.bank.source === "agent-card"
    ? i18n.t("area.settings-agent-card.agent-memory-tab.statusBankCard", { bankId: status.bank.bankId })
    : i18n.t("area.settings-agent-card.agent-memory-tab.statusBankPlugin", { bankId: status.bank.bankId });
}

export function AgentMemoryTabView({
  agentId,
  status,
  page,
  pageError,
  pending,
  actionError,
  actionNotice,
  onDelete,
  onClear,
  onExport,
  exportPending,
  offset,
  onOffsetChange,
}: {
  agentId: string;
  status: MemoryCardStatus | undefined;
  page: MemoryPageView | undefined;
  pageError: unknown;
  pending: boolean;
  actionError: string | null;
  actionNotice: string | null;
  onDelete: (memoryId: string, reason: string) => void;
  onClear: (confirmation: string | null) => void;
  onExport: () => void;
  exportPending: boolean;
  offset: number;
  onOffsetChange: (next: number) => void;
}) {
  const { t } = useTranslation();
  const [reasonDraft, setReasonDraft] = useState<Record<string, string>>({});
  const [clearDraft, setClearDraft] = useState("");

  const usable = Boolean(status?.enabled && status?.bank);

  return (
    <section className="max-w-3xl space-y-5" data-testid="myrmidon-agent-memory">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{t("area.settings-agent-card.agent-memory-tab.title")}</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="myrmidon-agent-memory-status">
            {statusLine(status, undefined)}
          </p>
        </div>
        {usable ? (
          <Button size="sm" variant="outline" disabled={exportPending} onClick={onExport} data-testid="myrmidon-agent-memory-export">
            {exportPending ? <Loader2 className="animate-spin" /> : <Download />}
            {t("area.settings-agent-card.agent-memory-tab.exportBank")}
          </Button>
        ) : null}
      </div>

      {actionError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="myrmidon-agent-memory-error">
          {actionError}
        </div>
      ) : null}
      {actionNotice ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground" data-testid="myrmidon-agent-memory-notice">
          {actionNotice}
        </div>
      ) : null}

      {usable ? (
        <>
          <div className="space-y-3">
            {pageError ? (
              <p className="text-sm text-destructive" data-testid="myrmidon-agent-memory-page-error">
                {readable(pageError)}
              </p>
            ) : pending ? (
              <p className="text-sm text-muted-foreground">{t("area.settings-agent-card.agent-memory-tab.loadingMemories")}</p>
            ) : !page || page.items.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-5">
                <p className="text-sm font-medium">{t("area.settings-agent-card.agent-memory-tab.emptyTitle")}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("area.settings-agent-card.agent-memory-tab.emptyDescription")}
                </p>
              </div>
            ) : (
              <ul className="space-y-3">
                {page.items.map((item) => (
                  <li key={item.id} className="rounded-lg border border-border p-3" data-testid={`myrmidon-agent-memory-item-${item.id}`}>
                    <div className="flex items-start justify-between gap-3">
                      <p className="whitespace-pre-wrap break-words text-sm">{item.text || <span className="text-muted-foreground">{t("area.settings-agent-card.agent-memory-tab.noText")}</span>}</p>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {item.factType ?? "—"}
                        {item.state && item.state !== "valid" ? ` · ${item.state}` : ""}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{formatMemoryDate(item.createdAt || item.occurredAt)}</span>
                      {item.tags.length > 0 ? <span>{item.tags.join(", ")}</span> : null}
                    </div>
                    {item.state !== "invalidated" ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Input
                          className="h-7 max-w-xs text-xs"
                          placeholder={t("area.settings-agent-card.agent-memory-tab.removeReasonPlaceholder")}
                          aria-label={t("area.settings-agent-card.agent-memory-tab.removeReasonAria", { id: item.id })}
                          value={reasonDraft[item.id] ?? ""}
                          onChange={(event) => setReasonDraft({ ...reasonDraft, [item.id]: event.target.value })}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending || (reasonDraft[item.id] ?? "").trim().length === 0}
                          onClick={() => onDelete(item.id, (reasonDraft[item.id] ?? "").trim())}
                        >
                          <Trash2 />
                          {t("common.remove")}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {page && page.total > PAGE_SIZE ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => onOffsetChange(Math.max(0, offset - PAGE_SIZE))}>
                {t("area.settings-agent-card.agent-memory-tab.newer")}
              </Button>
              <span data-testid="myrmidon-agent-memory-range">
                {t("area.settings-agent-card.agent-memory-tab.range", {
                  from: offset + 1,
                  to: Math.min(offset + page.items.length, page.total),
                  total: page.total,
                })}
              </span>
              <Button size="sm" variant="outline" disabled={offset + page.items.length >= page.total} onClick={() => onOffsetChange(offset + PAGE_SIZE)}>
                {t("area.settings-agent-card.agent-memory-tab.older")}
              </Button>
            </div>
          ) : null}

          <div className="rounded-lg border border-destructive/40 p-4">
            <p className="text-sm font-medium">{t("area.settings-agent-card.agent-memory-tab.clearTitle")}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("area.settings-agent-card.agent-memory-tab.clearDescription")}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                className="max-w-xs"
                placeholder={agentId}
                aria-label={t("area.settings-agent-card.agent-memory-tab.clearInputAria")}
                value={clearDraft}
                onChange={(event) => setClearDraft(event.target.value)}
                data-testid="myrmidon-agent-memory-clear-input"
              />
              <Button
                size="sm"
                variant="destructive"
                disabled={pending || clearDraft.trim() !== agentId}
                onClick={() => onClear(clearDraft.trim() === agentId ? agentId : null)}
                data-testid="myrmidon-agent-memory-clear-button"
              >
                {t("area.settings-agent-card.agent-memory-tab.clearButton")}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

export function AgentMemoryTab({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: memoryStatusKey(agentId),
    queryFn: () => memoryApi.status(agentId),
    retry: false,
  });
  const pageQuery = useQuery({
    queryKey: memoriesKey(agentId, offset, null),
    queryFn: () => memoryApi.list(agentId, { limit: PAGE_SIZE, offset }),
    enabled: Boolean(statusQuery.data?.enabled && statusQuery.data?.bank),
    retry: false,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["myrmidon", "agent-memory", agentId] });
  };

  const remove = useMutation({
    mutationFn: ({ memoryId, reason }: { memoryId: string; reason: string }) =>
      memoryApi.remove(agentId, memoryId, reason),
    onMutate: () => {
      setActionError(null);
      setActionNotice(null);
    },
    onSuccess: async () => {
      setActionNotice(t("area.settings-agent-card.agent-memory-tab.removedNotice"));
      await refresh();
    },
    onError: (err) => setActionError(readable(err)),
  });

  const clear = useMutation({
    mutationFn: () => memoryApi.clear(agentId),
    onMutate: () => {
      setActionError(null);
      setActionNotice(null);
    },
    onSuccess: async (result) => {
      setActionNotice(
        t("area.settings-agent-card.agent-memory-tab.clearedNotice", { number: result.deletedCount ?? t("area.settings-agent-card.agent-memory-tab.unknownNumber") }),
      );
      setOffset(0);
      await refresh();
    },
    onError: (err) => setActionError(readable(err)),
  });

  const exportMutation = useMutation({
    mutationFn: () => downloadMemoryExport(agentId),
    onMutate: () => {
      setActionError(null);
      setActionNotice(null);
    },
    onSuccess: (payload) => {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `agent-${agentId}-memory.json`;
      link.click();
      URL.revokeObjectURL(url);
      setActionNotice(
        payload.truncated
          ? t("area.settings-agent-card.agent-memory-tab.exportedTruncated", { shown: payload.items.length, total: payload.total })
          : t("area.settings-agent-card.agent-memory-tab.exported", { shown: payload.items.length }),
      );
    },
    onError: (err) => setActionError(readable(err)),
  });

  if (statusQuery.isError) {
    return (
      <section className="max-w-3xl space-y-3" data-testid="myrmidon-agent-memory">
        <h2 className="text-lg font-semibold">{t("area.settings-agent-card.agent-memory-tab.title")}</h2>
        <p className="text-sm text-destructive" data-testid="myrmidon-agent-memory-status-error">
          {readable(statusQuery.error)}
        </p>
      </section>
    );
  }

  return (
    <AgentMemoryTabView
      agentId={agentId}
      status={statusQuery.data}
      page={pageQuery.data}
      pageError={pageQuery.isError ? pageQuery.error : null}
      pending={pageQuery.isLoading || remove.isPending || clear.isPending}
      actionError={actionError}
      actionNotice={actionNotice}
      onDelete={(memoryId, reason) => remove.mutate({ memoryId, reason })}
      onClear={(confirmation) => {
        if (confirmation === agentId) clear.mutate();
      }}
      onExport={() => exportMutation.mutate()}
      exportPending={exportMutation.isPending}
      offset={offset}
      onOffsetChange={setOffset}
    />
  );
}
