// myrmidon(1.6.3 PROMPT-BUDGET B): the prompt-budget section of an agent
// card — the last run's share of the model window, its level against the live
// thresholds and the breakdown by prompt part. The data comes from the status
// endpoint of the same release; the thresholds are edited on the "Prompt
// budget" settings panel.
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import {
  promptBudgetApi,
  promptBudgetStatusQueryKey,
} from "./prompt-budget/promptBudgetApi";
import { topParts } from "./prompt-budget/promptBudgetConfig";

const LEVEL_STYLES: Record<string, string> = {
  ok: "bg-muted text-muted-foreground",
  warn: "bg-orange-500/15 text-orange-600",
  crit: "bg-destructive/10 text-destructive",
};

const LEVEL_LABELS: Record<string, string> = {
  ok: "Within budget",
  warn: "Warn threshold crossed",
  crit: "Crit threshold crossed",
};

export function PromptBudgetStatusSection({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId: string;
}) {
  const { data } = useQuery({
    queryKey: promptBudgetStatusQueryKey(companyId),
    queryFn: () => promptBudgetApi.getStatus(companyId),
    enabled: companyId.length > 0,
  });
  const entry = data?.agents.find((row) => row.agentId === agentId);
  if (!entry) return null;
  const run = entry.lastRun;
  return (
    <section
      className="space-y-3 rounded-lg border p-4"
      data-testid="prompt-budget-status-section"
    >
      <div className="flex items-center gap-2">
        <Gauge className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Prompt budget</h3>
        {run ? (
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${LEVEL_STYLES[run.level] ?? LEVEL_STYLES.ok}`}
            data-testid="prompt-budget-level"
          >
            {LEVEL_LABELS[run.level] ?? run.level}
          </span>
        ) : null}
      </div>
      {run ? (
        <div className="space-y-1 text-sm">
          <p>
            Last run used <span className="font-medium">{run.pct}%</span> of the window —{" "}
            <span className="font-mono">
              {run.total} / {entry.windowTokens}
            </span>{" "}
            tokens
            {entry.windowIsFallback ? " (fallback window)" : ""}
          </p>
          {Object.keys(run.parts).length > 0 ? (
            <ul className="list-disc pl-4 text-muted-foreground" data-testid="prompt-budget-parts">
              {topParts(run.parts, 3).map((part) => (
                <li key={part.name}>
                  {part.name} — {part.tokens} tokens
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">No per-part breakdown recorded for this run.</p>
          )}
          <p className="text-xs text-muted-foreground">
            Thresholds: warn {entry.settings.warnPct}%, crit {entry.settings.critPct}%
            {entry.settings.enabled ? "" : " — signalling off"}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No run with a recorded prompt size yet.</p>
      )}
    </section>
  );
}
