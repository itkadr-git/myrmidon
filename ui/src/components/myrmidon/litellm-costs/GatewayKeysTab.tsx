// myrmidon(M2-B): the "Gateway keys" tab — one gateway key per agent, held in
// the company secret store, plus the gateway's fallback topology with the loops
// the same walk the save path uses finds in it.
//
// Two cards. The keys card reads /api/myrmidon/companies/:id/litellm/keys and
// shows, per agent, whether a key of its own exists, the models allowlist,
// actions to issue/rotate/revoke keys and edit the allowlist — never the secret
// value (except once in a transient dialog upon issuing). When models list is
// empty, it displays an explicit warning «пусто = все модели».

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, ShieldAlert, TriangleAlert } from "lucide-react";
import { i18n, useTranslation } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import {
  countKeyedAgents,
  isKeysNotEnabledError,
  litellmFallbacksKey,
  litellmKeysApi,
  litellmKeysKey,
  type AgentGatewayKeyView,
  type GatewayFallbackReport,
} from "./litellmKeysApi";

/** One line per agent: the display name, the secret, present status, value hash, and allowlist. */
export interface GatewayKeyRow {
  agentId: string;
  agentName: string | null;
  secretName: string;
  present: boolean;
  valueHash: string | null;
  models: string[];
}

/** Joins the key views with the agent names the page already knows. */
export function keyRows(keys: AgentGatewayKeyView[], agentNames: Map<string, string>): GatewayKeyRow[] {
  return keys
    .map((entry) => ({
      agentId: entry.agentId,
      agentName: agentNames.get(entry.agentId) ?? null,
      secretName: entry.secretName,
      present: entry.present,
      valueHash: entry.valueHash ?? null,
      models: entry.models ?? [],
    }))
    .sort((a, b) => (a.agentName ?? a.agentId).localeCompare(b.agentName ?? b.agentId));
}

/** The loops of a report, as display strings; an unreadable gateway yields none. */
export function cycleLines(report: GatewayFallbackReport | undefined): string[] {
  if (!report || report.error) return [];
  return report.cycles.map((cycle) => cycle.described);
}

function GatewayKeysCard({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: litellmKeysKey(companyId),
    queryFn: () => litellmKeysApi.keys(companyId),
    staleTime: 60_000,
  });

  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents.data ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents.data]);

  const rows = useMemo(() => keyRows(data ?? [], names), [data, names]);
  const counts = countKeyedAgents(data ?? []);

  // State for created key modal
  const [createdKeyDialog, setCreatedKeyDialog] = useState<{ value: string; agentName: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // State for editing allowlist
  const [editAllowlistRow, setEditAllowlistRow] = useState<GatewayKeyRow | null>(null);
  const [modelsInput, setModelsInput] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: litellmKeysKey(companyId) });
  };

  const createMutation = useMutation({
    mutationFn: (agentId: string) => litellmKeysApi.create(companyId, agentId),
    onSuccess: (res, agentId) => {
      invalidate();
      setCreatedKeyDialog({
        value: res.value,
        agentName: names.get(agentId) ?? agentId.slice(0, 8),
      });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: (agentId: string) => litellmKeysApi.rotate(companyId, agentId),
    onSuccess: invalidate,
  });

  const revokeMutation = useMutation({
    mutationFn: (agentId: string) => litellmKeysApi.revoke(companyId, agentId),
    onSuccess: invalidate,
  });

  const updateAllowlistMutation = useMutation({
    mutationFn: ({ agentId, models }: { agentId: string; models: string[] }) =>
      litellmKeysApi.updateAllowlist(companyId, agentId, models),
    onSuccess: () => {
      invalidate();
      setEditAllowlistRow(null);
    },
  });

  const handleOpenAllowlist = (row: GatewayKeyRow) => {
    setEditAllowlistRow(row);
    setModelsInput(row.models.join(", "));
  };

  const handleSaveAllowlist = () => {
    if (!editAllowlistRow) return;
    const parsedModels = modelsInput
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    updateAllowlistMutation.mutate({
      agentId: editAllowlistRow.agentId,
      models: parsedModels,
    });
  };

  const handleCopyKey = () => {
    if (!createdKeyDialog) return;
    navigator.clipboard.writeText(createdKeyDialog.value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">{t("area.costs-budgets-2.gateway-keys-tab.keysCard.title")}</CardTitle>
        <CardDescription>
          {t("area.costs-budgets-2.gateway-keys-tab.keysCard.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-5 pb-5 pt-2">
        {error ? (
          <p className="text-sm text-destructive">
            {isKeysNotEnabledError(error)
              ? t("area.costs-budgets-2.gateway-keys-tab.notEnabled")
              : (error as Error).message}
          </p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">{t("area.costs-budgets-2.gateway-keys-tab.keysCard.loading")}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("area.costs-budgets-2.gateway-keys-tab.keysCard.empty")}</p>
        ) : (
          <>
            <div className="text-sm text-muted-foreground">
              {t("area.costs-budgets-2.gateway-keys-tab.keysCard.summary", {
                keyed: counts.keyed,
                total: counts.total,
              })}
            </div>
            {rows.map((row) => (
              <div
                key={row.agentId}
                className="flex flex-col gap-2 rounded border border-border p-3 transition-colors md:flex-row md:items-center"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/agents/${encodeURIComponent(row.agentId)}`}
                      className="text-sm font-medium hover:underline text-primary"
                    >
                      {row.agentName ?? row.agentId.slice(0, 8)}
                    </Link>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {row.secretName}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {row.present
                        ? t("area.costs-budgets-2.gateway-keys-tab.keysCard.keySet")
                        : t("area.costs-budgets-2.gateway-keys-tab.keysCard.noKey")}
                    </span>
                  </div>

                  {row.present && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <span className="text-xs text-muted-foreground">
                        {t("area.costs-budgets-2.gateway-keys-tab.keysCard.modelsLabel")}:
                      </span>
                      {row.models.length === 0 ? (
                        <div
                          data-testid="empty-models-warning"
                          className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400 border border-amber-500/20"
                        >
                          <TriangleAlert className="h-3 w-3 shrink-0" />
                          <span>{t("area.costs-budgets-2.gateway-keys-tab.keysCard.allModelsWarning")}</span>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {row.models.map((m) => (
                            <span
                              key={m}
                              className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
                            >
                              {m}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5 shrink-0 pt-2 md:pt-0">
                  {!row.present ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => createMutation.mutate(row.agentId)}
                      disabled={createMutation.isPending}
                    >
                      {t("area.costs-budgets-2.gateway-keys-tab.keysCard.issueKey")}
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleOpenAllowlist(row)}
                        disabled={updateAllowlistMutation.isPending}
                      >
                        {t("area.costs-budgets-2.gateway-keys-tab.keysCard.updateAllowlist")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => rotateMutation.mutate(row.agentId)}
                        disabled={rotateMutation.isPending}
                      >
                        {t("area.costs-budgets-2.gateway-keys-tab.keysCard.rotateKey")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          const agentDisplay = row.agentName ?? row.agentId.slice(0, 8);
                          if (
                            window.confirm(
                              t("area.costs-budgets-2.gateway-keys-tab.keysCard.confirmRevoke", {
                                name: agentDisplay,
                              }),
                            )
                          ) {
                            revokeMutation.mutate(row.agentId);
                          }
                        }}
                        disabled={revokeMutation.isPending}
                      >
                        {t("area.costs-budgets-2.gateway-keys-tab.keysCard.revokeKey")}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </CardContent>

      {/* Dialog for newly issued key */}
      <Dialog open={Boolean(createdKeyDialog)} onOpenChange={(open) => !open && setCreatedKeyDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-500" />
              {t("area.costs-budgets-2.gateway-keys-tab.keysCard.newKeyValueTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("area.costs-budgets-2.gateway-keys-tab.keysCard.newKeyValueWarning")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center space-x-2">
            <Input
              readOnly
              value={createdKeyDialog?.value ?? ""}
              className="font-mono text-xs"
            />
            <Button size="sm" onClick={handleCopyKey}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreatedKeyDialog(null)}>
              {t("area.costs-budgets-2.gateway-keys-tab.keysCard.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog for updating allowed models */}
      <Dialog open={Boolean(editAllowlistRow)} onOpenChange={(open) => !open && setEditAllowlistRow(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("area.costs-budgets-2.gateway-keys-tab.keysCard.updateAllowlist")}</DialogTitle>
            <DialogDescription>
              {t("area.costs-budgets-2.gateway-keys-tab.keysCard.modelsPlaceholder")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Input
              value={modelsInput}
              onChange={(e) => setModelsInput(e.target.value)}
              placeholder={t("area.costs-budgets-2.gateway-keys-tab.keysCard.modelsPlaceholder")}
              className="font-mono text-xs"
            />
            {modelsInput.trim() === "" && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t("area.costs-budgets-2.gateway-keys-tab.keysCard.allModelsWarning")}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditAllowlistRow(null)}>
              {t("area.costs-budgets-2.gateway-keys-tab.keysCard.cancel")}
            </Button>
            <Button onClick={handleSaveAllowlist} disabled={updateAllowlistMutation.isPending}>
              {t("area.costs-budgets-2.gateway-keys-tab.keysCard.saveModels")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function GatewayFallbacksCard({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useQuery({
    queryKey: litellmFallbacksKey(companyId),
    queryFn: () => litellmKeysApi.fallbacks(companyId),
    staleTime: 60_000,
  });
  const lines = cycleLines(data);

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">{t("area.costs-budgets-2.gateway-keys-tab.fallbacksCard.title")}</CardTitle>
        <CardDescription>
          {t("area.costs-budgets-2.gateway-keys-tab.fallbacksCard.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-5 pb-5 pt-2">
        {error ? (
          <p className="text-sm text-destructive">
            {isKeysNotEnabledError(error)
              ? t("area.costs-budgets-2.gateway-keys-tab.notEnabled")
              : (error as Error).message}
          </p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">{t("area.costs-budgets-2.gateway-keys-tab.fallbacksCard.loading")}</p>
        ) : data?.error ? (
          <p className="text-sm text-muted-foreground">{data.error}</p>
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("area.costs-budgets-2.gateway-keys-tab.fallbacksCard.empty")}</p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm text-destructive">
              <TriangleAlert className="h-4 w-4" />
              {t("area.costs-budgets-2.gateway-keys-tab.fallbacksCard.found", { count: lines.length })}
            </div>
            {lines.map((line) => (
              <div key={line} className="border border-border px-4 py-2 font-mono text-xs">
                {line}
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The whole "Gateway keys" tab. */
export function GatewayKeysTab({ companyId }: { companyId: string }) {
  return (
    <div className="grid gap-4 xl:grid-cols-(--gtc-31)">
      <GatewayKeysCard companyId={companyId} />
      <GatewayFallbacksCard companyId={companyId} />
    </div>
  );
}

/** Standalone empty state for a page opened with no company selected. */
export function GatewayKeysNoCompany() {
  return <EmptyState icon={KeyRound} message={i18n.t("area.costs-budgets-2.gateway-keys-tab.noCompany")} />;
}
