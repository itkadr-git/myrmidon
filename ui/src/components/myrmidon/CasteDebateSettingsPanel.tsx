// Asymmetric debates per caste (myrmidon 1.7 DEBATE-ASYM B): the caste level of
// the debate configuration — the switch, the role models, the custom guidance
// each role argues from, the rounds and the token ceiling.
//
// The values shown are the effective ones: a caste with no entry of its own
// inherits the instance configuration (the panel above), and every source is
// labelled. Saving writes `general.debate.castes.<key>` on the server and
// applies at the next run — no restart. A configuration that would break the
// asymmetry rule (debaters in one family, or the judge inside the dispute) is
// refused by the server with the exact reason, shown here.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { useOptionalCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  casteDebateQueryKey,
  debateApi,
  describeCasteDebateSource,
  describeCasteEnabledSource,
  type CasteDebateSettingsView,
  type DebateCastePatch,
} from "./debateApi";
import { useCasteOptionsForCompany, type CasteOption } from "./castes/useCasteOptions";

const ROLES: Array<{ key: "generator" | "critic" | "judge"; label: string; hint: string }> = [
  {
    key: "generator",
    label: "Generator model",
    hint: "The constructive pole. A different family than the critic.",
  },
  {
    key: "critic",
    label: "Critic model",
    hint: "The adversarial pole, penalized for a missed error. Must be a different family than the generator.",
  },
  {
    key: "judge",
    label: "Judge model",
    hint: "Outside the dispute. A third family — neither debater's.",
  },
];

interface Draft {
  enabled: boolean;
  generator: string;
  critic: string;
  judge: string;
  rounds: string;
  tokenCeiling: string;
  prompts: Record<"generator" | "critic" | "judge", string>;
}

function toDraft(view: CasteDebateSettingsView): Draft {
  const settings = view.settings;
  return {
    enabled: view.enabled,
    generator: settings?.generator.model ?? "",
    critic: settings?.critic.model ?? "",
    judge: settings?.judge.model ?? "",
    rounds: settings?.rounds != null ? String(settings.rounds) : "",
    tokenCeiling: settings?.tokenCeiling != null ? String(settings.tokenCeiling) : "",
    prompts: {
      generator: view.prompts.generator ?? "",
      critic: view.prompts.critic ?? "",
      judge: view.prompts.judge ?? "",
    },
  };
}

/** The PATCH body out of the draft; null when the models are incomplete. */
export function buildCasteDebatePatch(draft: Draft): DebateCastePatch | null {
  const generator = draft.generator.trim();
  const critic = draft.critic.trim();
  const judge = draft.judge.trim();
  if (!generator || !critic || !judge) return null;
  const rounds = draft.rounds.trim() ? Number(draft.rounds.trim()) : undefined;
  const tokenCeiling = draft.tokenCeiling.trim() ? Number(draft.tokenCeiling.trim()) : undefined;
  if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 1 || rounds > 3)) return null;
  if (tokenCeiling !== undefined && (!Number.isInteger(tokenCeiling) || tokenCeiling < 1000)) return null;
  const prompts: DebateCastePatch["prompts"] = {};
  for (const role of ["generator", "critic", "judge"] as const) {
    const text = draft.prompts[role].trim();
    if (text) prompts[role] = text;
  }
  return {
    enabled: draft.enabled,
    generator: { model: generator },
    critic: { model: critic },
    judge: { model: judge },
    ...(rounds !== undefined ? { rounds } : {}),
    ...(tokenCeiling !== undefined ? { tokenCeiling } : {}),
    ...(Object.keys(prompts).length > 0 ? { prompts } : {}),
  };
}

/** Mounted with `key={casteKey}` so the draft resets when the caste changes. */
export function CasteDebateForm({
  view,
  onSave,
  onClear,
  pending,
}: {
  view: CasteDebateSettingsView;
  onSave: (patch: DebateCastePatch) => void;
  onClear: () => void;
  pending: boolean;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(view));
  const patch = buildCasteDebatePatch(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(view));

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft({ ...draft, [key]: value });
  }

  return (
    <div className="space-y-3" data-testid={`caste-debate-form-${view.casteKey}`}>
      {view.problem ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          data-testid="caste-debate-problem"
        >
          {view.problem}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <ToggleSwitch
          checked={draft.enabled}
          onCheckedChange={(checked) => set("enabled", checked)}
          aria-label="Debates for this caste"
          data-testid="caste-debate-enabled"
        />
        <div className="space-y-0.5">
          <Label>Debates for this caste</Label>
          <p className="text-xs text-muted-foreground" data-testid="caste-debate-enabled-source">
            {describeCasteEnabledSource(view.enabledSource)}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {ROLES.map((role) => (
          <div key={role.key} className="space-y-1.5">
            <Label htmlFor={`caste-debate-model-${role.key}`}>{role.label}</Label>
            <Input
              id={`caste-debate-model-${role.key}`}
              data-testid={`caste-debate-model-${role.key}`}
              value={draft[role.key]}
              onChange={(event) => set(role.key, event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{role.hint}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="caste-debate-rounds">Rounds (max 3)</Label>
          <Input
            id="caste-debate-rounds"
            data-testid="caste-debate-rounds"
            value={draft.rounds}
            onChange={(event) => set("rounds", event.target.value)}
            inputMode="numeric"
            placeholder="3"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="caste-debate-ceiling">Token ceiling</Label>
          <Input
            id="caste-debate-ceiling"
            data-testid="caste-debate-ceiling"
            value={draft.tokenCeiling}
            onChange={(event) => set("tokenCeiling", event.target.value)}
            inputMode="numeric"
            placeholder="50000"
          />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Extra guidance per role. It is added to the built-in pole prompt — the critic keeps its missed-error penalty —
          so a caste narrows where a role looks, it does not change the dispute.
        </p>
        {ROLES.map((role) => (
          <div key={role.key} className="space-y-1">
            <Label htmlFor={`caste-debate-prompt-${role.key}`}>{`${role.label} guidance (optional)`}</Label>
            <textarea
              id={`caste-debate-prompt-${role.key}`}
              data-testid={`caste-debate-prompt-${role.key}`}
              className="min-h-[64px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={draft.prompts[role.key]}
              onChange={(event) => set("prompts", { ...draft.prompts, [role.key]: event.target.value })}
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          size="sm"
          data-testid="caste-debate-save"
          disabled={pending || !dirty || patch === null}
          onClick={() => {
            if (patch) onSave(patch);
          }}
        >
          {pending ? "Saving..." : "Save caste configuration"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="caste-debate-clear"
          disabled={pending || view.stored === null}
          onClick={onClear}
        >
          Inherit instance configuration
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="caste-debate-source">
          {describeCasteDebateSource(view.source, view.instanceSource)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="caste-debate-summary">
        {view.summary}
      </p>
    </div>
  );
}

export function CasteDebateSettingsPanelView({
  castes,
  selectedKey,
  onSelect,
  view,
  loading,
  onSave,
  onClear,
  pending,
  error,
}: {
  castes: CasteOption[];
  selectedKey: string | null;
  onSelect: (casteKey: string) => void;
  view: CasteDebateSettingsView | null;
  loading: boolean;
  onSave: (patch: DebateCastePatch) => void;
  onClear: () => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <section className="space-y-4" data-testid="myrmidon-caste-debate-settings">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Debates per caste</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Debates are on for every caste unless a caste is switched off here. A caste without its own entry inherits
          the instance configuration above; saving an entry pins this caste's models, guidance, rounds and ceiling.
          Changes apply at the next run — no restart.
        </p>
      </div>

      {error ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          data-testid="caste-debate-save-error"
        >
          {error}
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="caste-debate-caste">Caste</Label>
        <select
          id="caste-debate-caste"
          data-testid="caste-debate-select"
          className="w-full max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={selectedKey ?? ""}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">Select a caste...</option>
          {castes.map((caste) => (
            <option key={caste.key} value={caste.key}>
              {caste.label}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="caste-debate-loading">
          Loading the caste configuration...
        </p>
      ) : view ? (
        <CasteDebateForm key={view.casteKey} view={view} onSave={onSave} onClear={onClear} pending={pending} />
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="caste-debate-empty">
          Pick a caste to see whether debates run for it and what it inherits.
        </p>
      )}
    </section>
  );
}

export function CasteDebateSettingsPanel() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useOptionalCompany() ?? { selectedCompanyId: null };
  const companyId = selectedCompanyId ?? "";
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { options } = useCasteOptionsForCompany(companyId || undefined);

  const query = useQuery({
    queryKey: casteDebateQueryKey(companyId, selectedKey ?? ""),
    queryFn: () => debateApi.casteGet(companyId, selectedKey as string),
    enabled: companyId.length > 0 && (selectedKey ?? "").length > 0,
    retry: false,
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: casteDebateQueryKey(companyId, selectedKey ?? "") });
  };

  const save = useMutation({
    mutationFn: (patch: DebateCastePatch) => debateApi.casteUpdate(companyId, selectedKey as string, patch),
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the caste configuration failed."),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
  });
  const clear = useMutation({
    mutationFn: () => debateApi.casteUpdate(companyId, selectedKey as string, null),
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Clearing the caste configuration failed."),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
  });

  return (
    <CasteDebateSettingsPanelView
      castes={options}
      selectedKey={selectedKey}
      onSelect={(casteKey) => {
        setError(null);
        setSelectedKey(casteKey || null);
      }}
      view={query.data ?? null}
      loading={query.isFetching}
      onSave={(patch) => save.mutate(patch)}
      onClear={() => clear.mutate()}
      pending={save.isPending || clear.isPending}
      // The server refuses a symmetric result or a malformed entry with the
      // exact reason; show it instead of keeping a stale value on screen.
      error={error ?? query.data?.problem ?? null}
    />
  );
}