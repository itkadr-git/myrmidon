// Discussion rooms on issue cards (myrmidon 1.7 AGENT-EXCHANGE-A): the master
// switch and the room rules. Saving applies at the next room open — no
// restart, no room in flight is touched. Every value shows its source (saved
// here / forced by the server environment / default).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import type { AgentExchangeSettings, AgentExchangeSettingsPatch } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  agentExchangeApi,
  agentExchangeQueryKey,
  describeAgentExchangeSource,
  type AgentExchangeSettingsView,
} from "./agentExchangeApi";

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
  testId,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  testId: string;
}) {
  return (
    <label className="block space-y-1" data-testid={testId}>
      <span className="text-sm font-medium">{label}</span>
      <Input
        type="number"
        className="max-w-[10rem]"
        value={value}
        min={min}
        max={max}
        onChange={(event) => {
          const next = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      <span className="block text-xs text-muted-foreground">{hint}</span>
    </label>
  );
}

export function AgentExchangeSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: AgentExchangeSettingsView | null | undefined;
  onSave: (patch: AgentExchangeSettingsPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const [draft, setDraft] = useState<AgentExchangeSettings | null>(null);
  const current = draft ?? view?.settings ?? null;
  const dirty = draft !== null && view != null;

  const patch = (part: AgentExchangeSettingsPatch) => {
    if (!current) return;
    setDraft({ ...current, ...part });
  };

  return (
    <section className="space-y-4" data-testid="myrmidon-agent-exchange">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <MessagesSquare className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Discussion rooms (agent exchange)</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          A room on an issue card: 2–4 agents on different models answer independently, a finisher writes the
          summary as an issue document with the cost, and the owner can stop the room at any point. Saving takes
          effect at the next room open — no server restart.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view && current ? (
        <div className="space-y-4">
          <label className="flex items-center gap-3" data-testid="agent-exchange-enabled">
            <ToggleSwitch
              checked={current.enabled}
              onCheckedChange={(checked) => patch({ enabled: checked })}
              aria-label="Discussion rooms enabled"
            />
            <span className="text-sm">
              Rooms enabled
              <span className="block text-xs text-muted-foreground">
                Source: {describeAgentExchangeSource(view.sources.enabled)}
              </span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              label="Max participants"
              hint={`2–4 agents per room. Source: ${describeAgentExchangeSource(view.sources.maxParticipants)}`}
              value={current.maxParticipants}
              min={2}
              max={4}
              onChange={(maxParticipants) => patch({ maxParticipants })}
              testId="agent-exchange-max-participants"
            />
            <NumberField
              label="Max rounds"
              hint={`Rounds after the independent first answers. Source: ${describeAgentExchangeSource(view.sources.maxRounds)}`}
              value={current.maxRounds}
              min={0}
              max={8}
              onChange={(maxRounds) => patch({ maxRounds })}
              testId="agent-exchange-max-rounds"
            />
            <NumberField
              label="Token budget per room"
              hint={`The room stops when the budget is spent. Source: ${describeAgentExchangeSource(view.sources.tokenBudget)}`}
              value={current.tokenBudget}
              min={1000}
              max={1000000}
              onChange={(tokenBudget) => patch({ tokenBudget })}
              testId="agent-exchange-token-budget"
            />
            <NumberField
              label="Response timeout (ms)"
              hint={`A participant that misses the timeout is marked as an error and the room goes on. Source: ${describeAgentExchangeSource(view.sources.responseTimeoutMs)}`}
              value={current.responseTimeoutMs}
              min={5000}
              max={600000}
              onChange={(responseTimeoutMs) => patch({ responseTimeoutMs })}
              testId="agent-exchange-response-timeout"
            />
          </div>

          <div className="flex items-center gap-3">
            <Button
              type="button"
              size="sm"
              disabled={pending || !dirty}
              onClick={() => {
                if (draft) onSave(draft);
              }}
            >
              {pending ? "Saving..." : "Save room rules"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading the room rules...</p>
      )}
    </section>
  );
}

export function AgentExchangeSettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: agentExchangeQueryKey,
    queryFn: () => agentExchangeApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: agentExchangeApi.update,
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the room rules failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: agentExchangeQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load the room rules."}
      </div>
    );
  }

  return (
    <AgentExchangeSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}
