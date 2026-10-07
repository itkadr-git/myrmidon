// Session generations (myrmidon PERF-DIET-K): when a task's bot session rolls over to a
// fresh one. The values live in `instance_settings.general.sessions`; the run dispatch
// reads them on every wake, so saving applies without a restart. The switch is the
// operator's way off for the whole feature.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History } from "lucide-react";
import {
  SESSION_GENERATION_DEFAULT_MAX_DAYS,
  SESSION_GENERATION_DEFAULT_MAX_MESSAGES,
  normalizeSessionGenerationsSettings,
  type SessionGenerationsSettings,
} from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { queryKeys } from "@/lib/queryKeys";

export interface SessionGenerationsDraft {
  enabled: boolean;
  maxMessages: string;
  maxDays: string;
}

export function toSessionGenerationsDraft(stored: unknown): SessionGenerationsDraft {
  const settings = normalizeSessionGenerationsSettings(stored);
  return {
    enabled: settings.enabled,
    maxMessages: String(settings.maxMessages),
    maxDays: String(settings.maxDays),
  };
}

function parseThreshold(raw: string, label: string): { value: number | null; error: string | null } {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed === "" || !Number.isInteger(value) || value < 1 || value > 1_000_000) {
    return { value: null, error: `${label}: enter a whole number from 1 to 1000000` };
  }
  return { value, error: null };
}

/** The stored shape from the draft, or the first field error. The full object is sent: a PATCH replaces the key. */
export function buildSessionGenerationsPatch(draft: SessionGenerationsDraft): {
  patch: SessionGenerationsSettings | null;
  errors: { maxMessages: string | null; maxDays: string | null };
} {
  const messages = parseThreshold(draft.maxMessages, "Runs per session");
  const days = parseThreshold(draft.maxDays, "Days per session");
  if (messages.value === null || days.value === null) {
    return { patch: null, errors: { maxMessages: messages.error, maxDays: days.error } };
  }
  return {
    patch: { enabled: draft.enabled, maxMessages: messages.value, maxDays: days.value },
    errors: { maxMessages: null, maxDays: null },
  };
}

export function SessionGenerationsSettingsPanelView({
  stored,
  onSave,
  pending,
  error,
}: {
  stored: unknown;
  onSave: (patch: SessionGenerationsSettings) => void;
  pending: boolean;
  error: string | null;
}) {
  const [draft, setDraft] = useState<SessionGenerationsDraft | null>(null);
  const current = draft ?? toSessionGenerationsDraft(stored);
  const built = buildSessionGenerationsPatch(current);

  return (
    <section className="space-y-4" data-testid="myrmidon-session-generations">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Task session generations</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          A container bot keeps one session per task. Once a session passes either limit below, the next wake
          starts a fresh session and carries the task summary and a handoff note into it, so the bot&apos;s
          state stops growing with the task. Saving applies on the next wake, without a restart. Turning the
          switch off keeps every task on its current session.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="md:col-span-2 flex items-center gap-2">
          <input
            id="session-generations-enabled"
            type="checkbox"
            checked={current.enabled}
            onChange={(event) => setDraft({ ...current, enabled: event.target.checked })}
            data-testid="session-generations-enabled"
          />
          <Label htmlFor="session-generations-enabled">Start a fresh session when a limit is passed</Label>
        </div>
        <div className="space-y-1">
          <Label htmlFor="session-generations-max-messages">Runs per session</Label>
          <Input
            id="session-generations-max-messages"
            inputMode="numeric"
            value={current.maxMessages}
            onChange={(event) => setDraft({ ...current, maxMessages: event.target.value })}
            data-testid="session-generations-max-messages"
          />
          {built.errors.maxMessages ? (
            <div className="text-xs text-destructive" data-testid="session-generations-error-messages">
              {built.errors.maxMessages}
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            A session that recorded more runs than this rolls over. Default {SESSION_GENERATION_DEFAULT_MAX_MESSAGES}.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="session-generations-max-days">Days per session</Label>
          <Input
            id="session-generations-max-days"
            inputMode="numeric"
            value={current.maxDays}
            onChange={(event) => setDraft({ ...current, maxDays: event.target.value })}
            data-testid="session-generations-max-days"
          />
          {built.errors.maxDays ? (
            <div className="text-xs text-destructive" data-testid="session-generations-error-days">
              {built.errors.maxDays}
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            A session older than this many days rolls over. Default {SESSION_GENERATION_DEFAULT_MAX_DAYS}.
          </p>
        </div>
        <div className="md:col-span-2">
          <Button
            type="button"
            size="sm"
            disabled={pending || built.patch === null}
            onClick={() => {
              if (built.patch) onSave(built.patch);
            }}
            data-testid="session-generations-save"
          >
            {pending ? "Saving..." : "Save session generations"}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function SessionGenerationsSettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: (sessions: SessionGenerationsSettings) => instanceSettingsApi.updateGeneral({ sessions }),
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the session generation settings failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load the session generation settings."}
      </div>
    );
  }
  if (!query.data) {
    return <p className="text-sm text-muted-foreground">Loading session generation settings...</p>;
  }
  return (
    <SessionGenerationsSettingsPanelView
      // Re-seed the draft when the saved row changes.
      key={JSON.stringify(query.data.sessions ?? null)}
      stored={query.data.sessions}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}
