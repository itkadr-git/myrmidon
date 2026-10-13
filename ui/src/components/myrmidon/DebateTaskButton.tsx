// myrmidon(1.7-DEBATE-ASYM-B): the «Discuss» button of a caste's task.
//
// The supervisor sees the queue of a role — the tasks waiting for the castes
// that do that work. The button starts one asymmetric debate about the task
// with the configuration of that caste (the row's role is the caste key), and
// the result is shown right under it: the judge's verdict, how the debate
// stopped, the rounds and tokens it used and what it cost. The full transcript
// lands as the task's result document (`debate-result`), written by the server
// on the same run.
//
// When the caste's debates are switched off, the server refuses with 422 and
// the reason; the refusal is shown here instead of a silent no-op, with a hint
// that the switch lives in the debate settings.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { debateApi, type DebateRunView } from "./debateApi";

/** The first line of the judge's verdict, trimmed to a caption. */
export function verdictCaption(verdict: string | null): string {
  if (!verdict) return "—";
  const line = verdict
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return "—";
  const withoutPrefix = line.replace(/^VERDICT:\s*/i, "");
  return withoutPrefix.length > 200 ? `${withoutPrefix.slice(0, 197)}...` : withoutPrefix;
}

/** The 422 the server answers when the caste's debates are switched off. */
export function isCasteDisabled(error: unknown): boolean {
  return error instanceof ApiError && (error.body as { code?: string } | null)?.code === "debate_caste_disabled";
}

export function DebateTaskResultView({ result }: { result: DebateRunView }) {
  const { t } = useTranslation();
  const outcome = result.outcome;
  return (
    <div
      className="mt-2 space-y-1 rounded-md border border-border bg-accent/20 px-2 py-1.5 text-xs"
      data-testid="debate-task-result"
    >
      <p>
        <span className="text-muted-foreground">{t("swarm.discussVerdict")}: </span>
        <span data-testid="debate-task-verdict">{verdictCaption(outcome.judgeVerdict)}</span>
      </p>
      <p className="text-muted-foreground">
        {t("swarm.discussStop")}: <span data-testid="debate-task-stop">{outcome.stopReason ?? "—"}</span> —{" "}
        {outcome.stopDetail}
      </p>
      <p className="text-muted-foreground">
        {t("swarm.discussRounds")}: {outcome.roundsRun}/{outcome.roundsPlanned} · {t("swarm.discussTokens")}:{" "}
        {outcome.tokensUsed}/{outcome.tokenCeiling} · {t("swarm.discussCost")}: $
        {(outcome.cost.totalCents / 100).toFixed(2)}
      </p>
      <p className="text-muted-foreground">
        {t("swarm.discussCaste")}: {result.casteKey ?? "—"}
        {outcome.customPrompts && outcome.customPrompts.length > 0
          ? ` (${t("swarm.discussCustomPrompts")}: ${outcome.customPrompts.join(", ")})`
          : ""}
      </p>
      <p className="text-muted-foreground">
        {t("swarm.discussDocument")}: <span className="font-mono">{result.documentKey}</span>
      </p>
    </div>
  );
}

export function DebateTaskButtonView({
  pending,
  result,
  error,
  disabledReason,
  disabled,
  onRun,
}: {
  pending: boolean;
  result: DebateRunView | null;
  error: string | null;
  /** Set when the caste's debates are switched off: the button is disabled. */
  disabledReason: string | null;
  /** No company selected — nothing to run against. */
  disabled?: boolean;
  onRun: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="debate-task-button"
        disabled={pending || disabled || disabledReason !== null}
        onClick={onRun}
      >
        <MessagesSquare className="mr-1 h-3.5 w-3.5" />
        {pending ? t("swarm.discussRunning") : t("swarm.discuss")}
      </Button>
      {disabledReason ? (
        <p className="text-xs text-muted-foreground" data-testid="debate-task-disabled">
          {t("swarm.discussDisabledHint")}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" data-testid="debate-task-error">
          {error}
        </p>
      ) : null}
      {result ? <DebateTaskResultView result={result} /> : null}
    </div>
  );
}

export function DebateTaskButton({
  issueId,
  casteKey,
  companyId,
}: {
  issueId: string;
  /** The caste of the row: its configuration drives the debate. */
  casteKey: string;
  /** The company of the page; empty disables the button (nothing to run against). */
  companyId: string;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<DebateRunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disabledReason, setDisabledReason] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => debateApi.run(companyId, issueId, { casteKey }),
    onMutate: () => {
      setError(null);
      setDisabledReason(null);
    },
    onSuccess: (data) => setResult(data),
    onError: (err) => {
      setResult(null);
      // The caste switch is the one refusal the operator can fix right here:
      // say where it lives instead of echoing the code.
      if (isCasteDisabled(err)) {
        setDisabledReason(err instanceof Error ? err.message : t("swarm.discussDisabled"));
        return;
      }
      setError(err instanceof Error ? err.message : t("swarm.discussFailed"));
    },
  });

  return (
    <DebateTaskButtonView
      pending={run.isPending}
      result={result}
      error={error}
      disabledReason={disabledReason}
      disabled={companyId.length === 0}
      onRun={() => run.mutate()}
    />
  );
}