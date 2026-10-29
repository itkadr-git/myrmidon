// Agent memory (myrmidon MEMORY-UI): the memory service behind the agent card
// Memory tab. Saving applies on the next request, without a restart. The API key
// is optional: a service without authentication needs none.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Brain, Database, RefreshCw, Users } from "lucide-react";
import type {
  AgentMemoryAccessMode,
  HindsightBankSummary,
  HindsightRecallProbeResult,
  PatchAgentMemorySettings,
} from "@myrmidon/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { i18n, useTranslation } from "@/i18n";
import {
  agentMemoryApi,
  agentMemoryBanksKey,
  agentMemoryQueryKey,
  agentMemoryWorkloadKey,
  type AgentMemorySettingsView,
} from "./agentMemoryApi";

const DEFAULT_ROLES = ["engineer", "lead", "architect", "reviewer", "qa", "operator", "general"];

export interface Draft {
  enabled: boolean;
  apiUrl: string;
  keySecretName: string;
  accessMode: AgentMemoryAccessMode;
  enabledRoles: string[];
  enabledAgentIds: string[];
}

// Lazy: the language must be read at render time, not frozen at import.
const sourceLabel = (source: "setting" | "env" | "bot-env"): string => {
  switch (source) {
    case "setting":
      return i18n.t("area.settings-agent-card.agent-memory-settings-panel.sourceSetting");
    case "env":
      return i18n.t("area.settings-agent-card.agent-memory-settings-panel.sourceEnv");
    default:
      return i18n.t("area.settings-agent-card.agent-memory-settings-panel.sourceBotEnv");
  }
};

function toDraft(view: AgentMemorySettingsView): Draft {
  return {
    enabled: view.settings.enabled !== false,
    apiUrl: view.settings.apiUrl ?? "",
    keySecretName: view.settings.keySecretName ?? "",
    accessMode: view.settings.accessMode ?? "all",
    enabledRoles: view.settings.enabledRoles ?? ["engineer", "lead"],
    enabledAgentIds: view.settings.enabledAgentIds ?? [],
  };
}

/** An empty field clears the value (the environment applies again); an address must be http(s). */
export function buildAgentMemoryPatch(draft: Draft): { patch: PatchAgentMemorySettings | null; urlError: string | null } {
  const apiUrl = draft.apiUrl.trim();
  if (apiUrl) {
    try {
      const parsed = new URL(apiUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
    } catch {
      return { patch: null, urlError: i18n.t("area.settings-agent-card.agent-memory-settings-panel.urlError") };
    }
  }
  return {
    patch: {
      // `true` is the default, so it is stored as "not set".
      enabled: draft.enabled ? null : false,
      apiUrl: apiUrl || null,
      keySecretName: draft.keySecretName.trim() || null,
      accessMode: draft.accessMode,
      enabledRoles: draft.accessMode === "roles" ? draft.enabledRoles : null,
      enabledAgentIds: draft.accessMode === "selected" ? draft.enabledAgentIds : null,
    },
    urlError: null,
  };
}

export function AgentMemorySettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: AgentMemorySettingsView | null | undefined;
  onSave: (patch: PatchAgentMemorySettings) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [customRoleInput, setCustomRoleInput] = useState("");
  const [selectedBankId, setSelectedBankId] = useState<string | null>(null);
  const [bankConfigDraft, setBankConfigDraft] = useState<string>("");
  const [probeQuery, setProbeQuery] = useState("");
  const [probeResult, setProbeResult] = useState<HindsightRecallProbeResult | null>(null);

  const current = draft ?? (view ? toDraft(view) : null);
  const built = current ? buildAgentMemoryPatch(current) : { patch: null, urlError: null };

  const isConfigured = Boolean(view?.effective.apiUrl);

  // Banks query
  const banksQuery = useQuery({
    queryKey: agentMemoryBanksKey,
    queryFn: () => agentMemoryApi.listBanks(),
    enabled: isConfigured,
    retry: false,
  });

  // Workload query
  const workloadQuery = useQuery({
    queryKey: agentMemoryWorkloadKey,
    queryFn: () => agentMemoryApi.getWorkload(selectedBankId ?? undefined),
    enabled: isConfigured,
    refetchInterval: 10000,
  });

  // Bank config mutation
  const updateBankConfigMutation = useMutation({
    mutationFn: async ({ bankId, patch }: { bankId: string; patch: Record<string, unknown> }) => {
      return agentMemoryApi.updateBankConfig(bankId, patch);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: agentMemoryBanksKey });
    },
  });

  // Retry operation mutation
  const retryMutation = useMutation({
    mutationFn: async ({ bankId, operationId }: { bankId: string; operationId: string }) => {
      return agentMemoryApi.retryOperation(bankId, operationId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: agentMemoryWorkloadKey });
    },
  });

  // Probe recall mutation
  const probeMutation = useMutation({
    mutationFn: async () => {
      return agentMemoryApi.probeRecall(probeQuery || "test query", selectedBankId ?? undefined);
    },
    onSuccess: (res) => {
      setProbeResult(res);
      void queryClient.invalidateQueries({ queryKey: agentMemoryWorkloadKey });
    },
  });

  const toggleRole = (role: string) => {
    if (!current) return;
    const exists = current.enabledRoles.includes(role);
    const updated = exists ? current.enabledRoles.filter((r) => r !== role) : [...current.enabledRoles, role];
    setDraft({ ...current, enabledRoles: updated });
  };

  const addCustomRole = () => {
    const trimmed = customRoleInput.trim();
    if (!trimmed || !current) return;
    if (!current.enabledRoles.includes(trimmed)) {
      setDraft({ ...current, enabledRoles: [...current.enabledRoles, trimmed] });
    }
    setCustomRoleInput("");
  };

  return (
    <section className="space-y-6" data-testid="myrmidon-agent-memory">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-agent-card.agent-memory-settings-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.settings-agent-card.agent-memory-settings-panel.description")}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view && current ? (
        <div className="space-y-6">
          {/* Connection settings */}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="md:col-span-2 flex items-center gap-2">
              <input
                id="agent-memory-enabled"
                type="checkbox"
                checked={current.enabled}
                onChange={(event) => setDraft({ ...current, enabled: event.target.checked })}
              />
              <Label htmlFor="agent-memory-enabled">
                {t("area.settings-agent-card.agent-memory-settings-panel.enabledLabel")}
              </Label>
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-memory-url">{t("area.settings-agent-card.agent-memory-settings-panel.urlLabel")}</Label>
              <Input
                id="agent-memory-url"
                placeholder={t("area.settings-agent-card.agent-memory-settings-panel.urlPlaceholder")}
                value={current.apiUrl}
                onChange={(event) => setDraft({ ...current, apiUrl: event.target.value })}
              />
              {built.urlError ? (
                <div className="text-xs text-destructive" data-testid="agent-memory-error-url">
                  {built.urlError}
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {t("area.settings-agent-card.agent-memory-settings-panel.urlHint")}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-memory-key">{t("area.settings-agent-card.agent-memory-settings-panel.keyLabel")}</Label>
              <Input
                id="agent-memory-key"
                placeholder={t("area.settings-agent-card.agent-memory-settings-panel.keyPlaceholder")}
                value={current.keySecretName}
                onChange={(event) => setDraft({ ...current, keySecretName: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                {t("area.settings-agent-card.agent-memory-settings-panel.keyHint")}
              </p>
            </div>
            <div className="md:col-span-2 text-xs text-muted-foreground" data-testid="agent-memory-effective">
              {view.effective.enabled && view.effective.apiUrl
                ? t(
                    view.effective.keySecretName
                      ? "area.settings-agent-card.agent-memory-settings-panel.inForceWithKey"
                      : "area.settings-agent-card.agent-memory-settings-panel.inForceNoKey",
                    {
                      source: view.effective.urlSource
                        ? sourceLabel(view.effective.urlSource)
                        : t("area.settings-agent-card.agent-memory-settings-panel.unknownSource"),
                    },
                  )
                : t("area.settings-agent-card.agent-memory-settings-panel.inForceOff")}
            </div>
          </div>

          {/* Agent access section */}
          <div className="space-y-3 rounded-lg border p-4 bg-card/30" data-testid="agent-memory-access-section">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">
                {t("area.settings-agent-card.agent-memory-settings-panel.accessSectionTitle")}
              </h3>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="accessMode"
                  value="all"
                  checked={current.accessMode === "all"}
                  onChange={() => setDraft({ ...current, accessMode: "all" })}
                />
                {t("area.settings-agent-card.agent-memory-settings-panel.accessModeAll")}
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="accessMode"
                  value="roles"
                  checked={current.accessMode === "roles"}
                  onChange={() => setDraft({ ...current, accessMode: "roles" })}
                />
                {t("area.settings-agent-card.agent-memory-settings-panel.accessModeRoles")}
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="accessMode"
                  value="selected"
                  checked={current.accessMode === "selected"}
                  onChange={() => setDraft({ ...current, accessMode: "selected" })}
                />
                {t("area.settings-agent-card.agent-memory-settings-panel.accessModeSelected")}
              </label>
            </div>

            {current.accessMode === "roles" ? (
              <div className="space-y-2 pt-2 border-t text-sm">
                <p className="text-xs text-muted-foreground">
                  {t("area.settings-agent-card.agent-memory-settings-panel.rolesHint")}
                </p>
                <div className="flex flex-wrap gap-2">
                  {Array.from(new Set([...DEFAULT_ROLES, ...current.enabledRoles])).map((role) => {
                    const active = current.enabledRoles.includes(role);
                    return (
                      <button
                        key={role}
                        type="button"
                        onClick={() => toggleRole(role)}
                        className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                          active
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-muted text-muted-foreground border-border"
                        }`}
                      >
                        {role} {active ? "✓" : "+"}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2 max-w-xs pt-1">
                  <Input
                    size={28}
                    className="h-8 text-xs"
                    placeholder="Custom role..."
                    value={customRoleInput}
                    onChange={(e) => setCustomRoleInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustomRole();
                      }
                    }}
                  />
                  <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={addCustomRole}>
                    Add
                  </Button>
                </div>
              </div>
            ) : null}

            {current.accessMode === "selected" ? (
              <div className="space-y-1 pt-2 border-t">
                <Label htmlFor="agent-memory-ids" className="text-xs">
                  Agent IDs (comma or line separated)
                </Label>
                <textarea
                  id="agent-memory-ids"
                  className="w-full text-xs font-mono rounded-md border p-2 bg-background"
                  rows={3}
                  value={current.enabledAgentIds.join("\n")}
                  onChange={(e) =>
                    setDraft({
                      ...current,
                      enabledAgentIds: e.target.value
                        .split(/[\n,]/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={pending || built.patch === null}
              onClick={() => {
                if (built.patch) onSave(built.patch);
              }}
            >
              {pending
                ? t("area.settings-agent-card.agent-memory-settings-panel.saving")
                : t("area.settings-agent-card.agent-memory-settings-panel.save")}
            </Button>
          </div>

          {/* Banks & Workload sections (shown when memory service is configured) */}
          {isConfigured ? (
            <div className="space-y-6 pt-4 border-t">
              {/* Banks List */}
              <div className="space-y-3" data-testid="agent-memory-banks-section">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-medium">
                    {t("area.settings-agent-card.agent-memory-settings-panel.banksTitle")}
                  </h3>
                </div>
                {banksQuery.isLoading ? (
                  <p className="text-xs text-muted-foreground">
                    {t("area.settings-agent-card.agent-memory-settings-panel.banksLoading")}
                  </p>
                ) : banksQuery.data && banksQuery.data.length > 0 ? (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {banksQuery.data.map((bank: HindsightBankSummary) => (
                      <div
                        key={bank.id}
                        onClick={() => setSelectedBankId(bank.id)}
                        className={`cursor-pointer rounded-md border p-3 text-xs transition-colors ${
                          selectedBankId === bank.id ? "border-primary bg-primary/5" : "border-border bg-card"
                        }`}
                      >
                        <div className="font-semibold text-sm">{bank.name || bank.id}</div>
                        <div className="text-muted-foreground mt-1">
                          Memories: {bank.memoriesCount ?? 0}
                          {typeof bank.pendingConsolidations === "number" && bank.pendingConsolidations > 0 ? (
                            <span className="ml-2 text-amber-500">Queue: {bank.pendingConsolidations}</span>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("area.settings-agent-card.agent-memory-settings-panel.banksEmpty")}
                  </p>
                )}
              </div>

              {/* Workload & Queue */}
              <div className="space-y-3 rounded-lg border p-4 bg-card/30" data-testid="agent-memory-workload-section">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-medium">
                      {t("area.settings-agent-card.agent-memory-settings-panel.workloadTitle")}
                    </h3>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => void workloadQuery.refetch()}
                  >
                    <RefreshCw className="h-3 w-3 mr-1" /> Refresh
                  </Button>
                </div>
                {workloadQuery.data ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="rounded border bg-background p-3 space-y-1">
                      <div className="text-xs text-muted-foreground">
                        {t("area.settings-agent-card.agent-memory-settings-panel.recallLatency")}
                      </div>
                      <div className="text-lg font-semibold">
                        {workloadQuery.data.avgRecallDurationMs !== null
                          ? `${workloadQuery.data.avgRecallDurationMs} ms`
                          : workloadQuery.data.lastRecallDurationMs !== null
                          ? `${workloadQuery.data.lastRecallDurationMs} ms`
                          : "No probes recorded"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Last recall: {workloadQuery.data.lastRecallDurationMs ? `${workloadQuery.data.lastRecallDurationMs} ms` : "—"}
                      </div>
                    </div>
                    <div className="rounded border bg-background p-3 space-y-1">
                      <div className="text-xs text-muted-foreground">
                        {t("area.settings-agent-card.agent-memory-settings-panel.consolidationQueue")} (async_operations)
                      </div>
                      <div className="text-lg font-semibold flex items-center gap-3">
                        <span>Pending: {workloadQuery.data.consolidationQueue.pending}</span>
                        {workloadQuery.data.consolidationQueue.failed > 0 ? (
                          <span className="text-destructive">Failed: {workloadQuery.data.consolidationQueue.failed}</span>
                        ) : null}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Processing: {workloadQuery.data.consolidationQueue.processing} | Total: {workloadQuery.data.consolidationQueue.total}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Loading workload metrics...</p>
                )}

                {/* Operations list with retry */}
                {workloadQuery.data?.consolidationQueue.recentOperations &&
                workloadQuery.data.consolidationQueue.recentOperations.length > 0 ? (
                  <div className="mt-3 space-y-2 border-t pt-2">
                    <div className="text-xs font-medium text-muted-foreground">Recent Async Operations:</div>
                    <div className="max-h-40 overflow-y-auto space-y-1 font-mono text-xs">
                      {workloadQuery.data.consolidationQueue.recentOperations.map((op) => (
                        <div
                          key={op.id}
                          className="flex items-center justify-between p-1.5 rounded bg-background border"
                        >
                          <div className="truncate mr-2">
                            <span className="font-semibold">{op.operation_type}</span>: {op.id} (status: {op.status})
                          </div>
                          {op.status === "failed" ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              className="h-6 text-xs px-2"
                              disabled={retryMutation.isPending}
                              onClick={() =>
                                retryMutation.mutate({
                                  bankId: selectedBankId || "default",
                                  operationId: op.id,
                                })
                              }
                            >
                              {t("area.settings-agent-card.agent-memory-settings-panel.retryOperation")}
                            </Button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Live recall probe */}
              <div className="space-y-3 rounded-lg border p-4 bg-card/30" data-testid="agent-memory-probe-section">
                <div className="flex items-center gap-2">
                  <Brain className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-medium">
                    {t("area.settings-agent-card.agent-memory-settings-panel.probeTitle")}
                  </h3>
                </div>
                <div className="flex gap-2">
                  <Input
                    className="text-xs"
                    placeholder={t("area.settings-agent-card.agent-memory-settings-panel.probeQueryPlaceholder")}
                    value={probeQuery}
                    onChange={(e) => setProbeQuery(e.target.value)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={probeMutation.isPending}
                    onClick={() => probeMutation.mutate()}
                  >
                    {probeMutation.isPending
                      ? "Testing..."
                      : t("area.settings-agent-card.agent-memory-settings-panel.probeRun")}
                  </Button>
                </div>
                {probeResult ? (
                  <div
                    className={`p-3 rounded text-xs space-y-1 ${
                      probeResult.success ? "bg-primary/5 border border-primary/20" : "bg-destructive/10 text-destructive border border-destructive/20"
                    }`}
                  >
                    {probeResult.success ? (
                      <>
                        <div className="font-semibold text-primary">
                          {t("area.settings-agent-card.agent-memory-settings-panel.probeSuccess", {
                            durationMs: probeResult.durationMs,
                            count: probeResult.resultsCount,
                          })}
                        </div>
                        {probeResult.results.length > 0 ? (
                          <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                            {probeResult.results.map((res, i) => (
                              <div key={i} className="p-1 rounded bg-background/50 border text-muted-foreground">
                                {res.text} {res.score ? `(score: ${res.score})` : ""}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <div>Probe failed: {probeResult.error}</div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("area.settings-agent-card.agent-memory-settings-panel.loading")}
        </p>
      )}
    </section>
  );
}

export function AgentMemorySettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: agentMemoryQueryKey,
    queryFn: () => agentMemoryApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: agentMemoryApi.update,
    onMutate: () => setError(null),
    onError: (err) =>
      setError(
        err instanceof Error ? err.message : i18n.t("area.settings-agent-card.agent-memory-settings-panel.saveFailed"),
      ),
    onSuccess: async () => {
      setError(null);
      // Prefix key: also refreshes every agent card's Memory tab status.
      await queryClient.invalidateQueries({ queryKey: agentMemoryQueryKey });
      await queryClient.invalidateQueries({ queryKey: agentMemoryBanksKey });
      await queryClient.invalidateQueries({ queryKey: agentMemoryWorkloadKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error
          ? query.error.message
          : i18n.t("area.settings-agent-card.agent-memory-settings-panel.loadFailed")}
      </div>
    );
  }

  return (
    <AgentMemorySettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}