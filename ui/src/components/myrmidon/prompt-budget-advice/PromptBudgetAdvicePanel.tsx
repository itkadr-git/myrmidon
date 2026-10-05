// myrmidon(1.6.3 PROMPT-BUDGET C): the optimization-advice block of the agent card.
//
// It sits next to the prompt-budget signal of the sibling part and does not
// depend on it: the panel reads the advice endpoints only, so it mounts on its
// own. It answers two questions — which part of the last prompt is bloated and
// what to do about it (the static recommendations), and "analyse it deeply"
// (the button, which files a task for the configured optimizer agent and links
// to it).
//
// The view is a pure function of its props so it can be unit-tested without a
// router or a network; the container owns the queries.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  adviceSeverityLabel,
  deepTaskHref,
  formatSharePct,
  formatTokensShort,
} from "./promptBudgetAdviceConfig";
import {
  promptBudgetAdviceApi,
  promptBudgetAdviceQueryKey,
  type PromptBudgetAdvice,
  type PromptBudgetDeepTask,
} from "./promptBudgetAdviceApi";

export function PromptBudgetAdviceView({
  advice,
  onDeep,
  deepPending,
  deepTask,
  error,
}: {
  advice: PromptBudgetAdvice | null | undefined;
  onDeep: () => void;
  deepPending: boolean;
  deepTask: PromptBudgetDeepTask | null;
  error: string | null;
}) {
  const canAnalyse = Boolean(advice?.hasRun);

  return (
    <section
      className="space-y-3 rounded-lg border border-border p-4"
      data-testid="myrmidon-prompt-budget-advice"
      aria-labelledby="prompt-budget-advice-heading"
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <h3 id="prompt-budget-advice-heading" className="text-sm font-medium">
            Prompt budget advice
          </h3>
        </div>
        <p className="max-w-2xl text-xs text-muted-foreground">
          What the last run's prompt was made of, which part is bloated, and what to do about it.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {!advice ? (
        <p className="text-sm text-muted-foreground">Loading the prompt breakdown...</p>
      ) : !advice.hasRun ? (
        <p className="text-sm text-muted-foreground" data-testid="prompt-budget-advice-no-run">
          No run of this agent has a recorded prompt breakdown yet.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Last run {advice.runId ? <span className="font-mono">{advice.runId}</span> : "unknown"} ·{" "}
            <span className="font-mono">{formatTokensShort(advice.total)}</span> tokens in the prompt
          </p>

          {advice.parts.length > 0 ? (
            <ul className="space-y-1" data-testid="prompt-budget-advice-parts">
              {advice.parts.map((part) => (
                <li key={part.part} className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-mono truncate">{part.part}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {formatTokensShort(part.tokens)} · {formatSharePct(part.sharePct)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {advice.recommendations.length > 0 ? (
            <ul className="space-y-2" data-testid="prompt-budget-advice-list">
              {advice.recommendations.map((item) => (
                <li
                  key={item.part}
                  className="space-y-1 rounded-md border border-border p-3"
                  data-severity={item.severity}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={
                        "inline-flex items-center rounded-full px-2 py-0.5 text-(length:--text-micro) font-medium " +
                        (item.severity === "crit"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-muted text-muted-foreground")
                      }
                    >
                      {adviceSeverityLabel(item.severity)}
                    </span>
                    <span className="text-sm font-medium">{item.title}</span>
                    <span className="text-xs text-muted-foreground font-mono truncate">
                      {item.part} · {formatSharePct(item.sharePct)} ·{" "}
                      {formatTokensShort(item.tokens)} tokens
                    </span>
                  </div>
                  <p className="text-sm">{item.action}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="prompt-budget-advice-healthy">
              No part of the last prompt crosses the warning threshold.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={deepPending || !canAnalyse}
          onClick={onDeep}
          data-testid="prompt-budget-advice-deep"
        >
          {deepPending ? "Filing the task..." : "Deep analysis"}
        </Button>
        <span className="text-xs text-muted-foreground">
          A cheap-model agent drafts instruction edits as a comment; nothing is changed for you.
        </span>
      </div>

      {deepTask ? (
        <p className="text-sm" data-testid="prompt-budget-advice-deep-task">
          Deep analysis task:{" "}
          {deepTask.identifier ? (
            <a className="font-medium underline" href={deepTaskHref(deepTask.identifier)}>
              {deepTask.identifier}
            </a>
          ) : (
            <span className="font-mono">{deepTask.issueId}</span>
          )}
        </p>
      ) : null}
    </section>
  );
}

export function PromptBudgetAdvicePanel({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId: string;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [deepTask, setDeepTask] = useState<PromptBudgetDeepTask | null>(null);

  const query = useQuery({
    queryKey: promptBudgetAdviceQueryKey(companyId, agentId),
    queryFn: () => promptBudgetAdviceApi.getAdvice(companyId, agentId),
    retry: false,
  });

  const deep = useMutation({
    mutationFn: () => promptBudgetAdviceApi.startDeepAnalysis(companyId, agentId),
    onMutate: () => setError(null),
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Filing the deep analysis task failed."),
    onSuccess: async (task) => {
      setError(null);
      setDeepTask(task);
      await queryClient.invalidateQueries({
        queryKey: promptBudgetAdviceQueryKey(companyId, agentId),
      });
    },
  });

  return (
    <PromptBudgetAdviceView
      advice={query.data}
      onDeep={() => deep.mutate()}
      deepPending={deep.isPending}
      deepTask={deepTask}
      error={error}
    />
  );
}