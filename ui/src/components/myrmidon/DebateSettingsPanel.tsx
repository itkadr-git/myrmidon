// Asymmetric debates (myrmidon 1.7 DEBATE-ASYM A): the role configuration of
// the debate engine — generator/critic/judge models, rounds (max 3), the
// token ceiling. Saving applies at the next debate run, without a server
// restart; the source of the effective value is shown. A symmetric
// configuration (one family for both debaters, or the judge sharing a
// family) is refused by the server with the exact reason, shown here.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import type { DebateSettings } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  debateApi,
  debateSettingsQueryKey,
  describeDebateSource,
  type DebateSettingsView,
} from "./debateApi";

const ROLES: Array<{ key: "generator" | "critic" | "judge"; label: string; hint: string }> = [
  {
    key: "generator",
    label: "Generator model",
    hint: "The constructive pole: proposes and defends the answer. Free models by default.",
  },
  {
    key: "critic",
    label: "Critic model",
    hint: "The adversarial pole: hunts errors, penalized for a miss. Must be a different family than the generator.",
  },
  {
    key: "judge",
    label: "Judge model",
    hint: "Outside the dispute: rules on the transcript. Must be a third family — neither debater's.",
  },
];

function toDraft(settings: DebateSettings | null): Record<string, string> {
  if (!settings) return { generator: "", critic: "", judge: "", rounds: "", tokenCeiling: "" };
  return {
    generator: settings.generator.model,
    critic: settings.critic.model,
    judge: settings.judge.model,
    rounds: settings.rounds != null ? String(settings.rounds) : "",
    tokenCeiling: settings.tokenCeiling != null ? String(settings.tokenCeiling) : "",
  };
}

export function DebateSettingsPanelView({
  view,
  onSave,
  onClear,
  pending,
  error,
}: {
  view: DebateSettingsView | null | undefined;
  onSave: (settings: DebateSettings) => void;
  onClear: () => void;
  pending: boolean;
  error: string | null;
}) {
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const current = draft ?? toDraft(view?.settings ?? null);
  const dirty = draft !== null && view != null && JSON.stringify(draft) !== JSON.stringify(toDraft(view.settings ?? null));

  function set(key: string, value: string) {
    setDraft({ ...current, [key]: value });
  }

  function buildSettings(): DebateSettings | null {
    const generator = current.generator.trim();
    const critic = current.critic.trim();
    const judge = current.judge.trim();
    if (!generator || !critic || !judge) return null;
    const rounds = current.rounds.trim() ? Number(current.rounds.trim()) : undefined;
    const tokenCeiling = current.tokenCeiling.trim() ? Number(current.tokenCeiling.trim()) : undefined;
    if (rounds !== undefined && !Number.isInteger(rounds)) return null;
    if (tokenCeiling !== undefined && !Number.isInteger(tokenCeiling)) return null;
    return {
      generator: { model: generator },
      critic: { model: critic },
      judge: { model: judge },
      ...(rounds !== undefined ? { rounds } : {}),
      ...(tokenCeiling !== undefined ? { tokenCeiling } : {}),
    } as DebateSettings;
  }

  const built = buildSettings();

  return (
    <section className="space-y-4" data-testid="myrmidon-debate-settings">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <MessagesSquare className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Asymmetric debates</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          The role models of the debate engine. The generator and the critic must sit in different model families
          and the judge in a third one — a symmetric configuration is refused by the server. A debate runs at most
          three rounds, stops on critic agreement or on the token ceiling, and its cost lands on the task. Saving
          applies at the next run — no server restart.
        </p>
      </div>

      {view && !view.gateway.configured ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="debate-gateway-problem">
          {view.gateway.problem ?? "the debate gateway is not configured"}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="debate-save-error">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {ROLES.map((role) => (
              <div key={role.key} className="space-y-1.5">
                <Label htmlFor={`debate-${role.key}`}>{role.label}</Label>
                <Input
                  id={`debate-${role.key}`}
                  value={current[role.key]}
                  onChange={(event) => set(role.key, event.target.value)}
                  placeholder={role.key === "generator" ? "qwen-plus-free" : role.key === "critic" ? "glm-4-flash-free" : "deepseek-chat-free"}
                />
                <p className="text-xs text-muted-foreground">{role.hint}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="debate-rounds">Rounds (max 3)</Label>
              <Input id="debate-rounds" value={current.rounds} onChange={(event) => set("rounds", event.target.value)} inputMode="numeric" placeholder="3" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="debate-ceiling">Token ceiling</Label>
              <Input id="debate-ceiling" value={current.tokenCeiling} onChange={(event) => set("tokenCeiling", event.target.value)} inputMode="numeric" placeholder="50000" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              size="sm"
              disabled={pending || !dirty || built === null}
              onClick={() => {
                if (built) onSave(built);
              }}
            >
              {pending ? "Saving..." : "Save debate configuration"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={pending || view.settings === null} onClick={onClear}>
              Clear to default
            </Button>
            <span className="text-xs text-muted-foreground" data-testid="debate-source">
              {describeDebateSource(view.source)}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading the debate configuration...</p>
      )}
    </section>
  );
}

export function DebateSettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: debateSettingsQueryKey,
    queryFn: () => debateApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: (settings: DebateSettings) => debateApi.update(settings),
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the debate configuration failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: debateSettingsQueryKey });
    },
  });
  const clear = useMutation({
    mutationFn: () => debateApi.update(null),
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Clearing the debate configuration failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: debateSettingsQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load the debate configuration."}
      </div>
    );
  }

  return (
    <DebateSettingsPanelView
      view={query.data}
      onSave={(settings) => save.mutate(settings)}
      onClear={() => clear.mutate()}
      pending={save.isPending || clear.isPending}
      // The server refuses a symmetric config with 422 + the exact reason;
      // show it under the form instead of silently keeping the old value.
      error={error ?? query.data?.problem ?? null}
    />
  );
}
