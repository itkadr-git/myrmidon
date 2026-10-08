// myrmidon(1.6.3 PROMPT-BUDGET B): the prompt-budget badge shown on an agent
// card. Read-only: it renders one entry of the status endpoint (the last run's
// share of the model window, amber on warn, red on crit). The thresholds are
// edited on the "Prompt budget" settings panel; the badge just answers "how
// full was this agent's last prompt".
import {
  promptBudgetBadgeText,
  promptBudgetBadgeTitle,
} from "./prompt-budget/promptBudgetConfig";
import type { PromptBudgetStatusEntry } from "./prompt-budget/promptBudgetApi";

export function AgentPromptBudgetBadge({ entry }: { entry: PromptBudgetStatusEntry | undefined }) {
  const run = entry?.lastRun;
  if (!entry || !run) return null;
  const level = run.level;
  return (
    <span
      data-testid={`agent-prompt-budget-badge-${entry.agentId}`}
      data-level={level}
      title={promptBudgetBadgeTitle(run, entry.windowTokens)}
      className={
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-(length:--text-micro) font-medium whitespace-nowrap " +
        (level === "crit"
          ? "bg-destructive/10 text-destructive"
          : level === "warn"
            ? "bg-orange-500/15 text-orange-600"
            : "bg-muted text-muted-foreground")
      }
    >
      {level !== "ok" ? (
        <span
          className={
            "h-1.5 w-1.5 rounded-full " +
            (level === "crit" ? "bg-destructive" : "bg-orange-500")
          }
          aria-hidden
        />
      ) : null}
      <span className="font-mono">{promptBudgetBadgeText(run)}</span>
    </span>
  );
}
