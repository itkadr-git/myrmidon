// myrmidon(1.7 TOKEN-BUDGET-SIGNAL, OPE-12232): the issue token-budget badge —
// the card view of the soft signal. Render-only: it reads the payload the
// server computed from the issue's token policy and cost events and never
// implies a stop. The signal by contract cannot pause or refuse a run
// (`enforcement: "signal"`), so the badge only ever informs: "warn" is an
// amber note that the issue is at/past its token budget, "info" a quieter
// note below the warn percent. Nothing renders for "none" or without a
// budget — the card shows nothing instead of a zero badge.
//
// Tokens only (DESIGN.md): text-micro sizing, status colors from the token
// layer — the same set the fallback/WIP badges use, no raw values.
import { useTranslation } from "@/i18n";
import { formatTokens } from "@/lib/utils";
import type { TokenBudgetSignal } from "@myrmidon/shared";

export function TokenBudgetSignalBadge({ signal }: { signal: TokenBudgetSignal | null | undefined }) {
  const { t } = useTranslation();
  if (!signal || signal.level === "none") return null;

  const warn = signal.level === "warn";
  const label = t(
    warn
      ? "area.issue-threads-runs-2.issue-detail.tokenBudgetWarn"
      : "area.issue-threads-runs-2.issue-detail.tokenBudgetInfo",
    {
      observed: formatTokens(signal.observedTokens),
      amount: formatTokens(signal.amountTokens),
      percent: Math.round(signal.utilizationPercent),
    },
  );
  const hint = t("area.issue-threads-runs-2.issue-detail.tokenBudgetHint", {
    percent: signal.warnPercent,
  });

  return (
    <span
      data-testid="issue-token-budget-signal"
      data-level={signal.level}
      title={hint}
      className={
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-(length:--text-micro) font-medium whitespace-nowrap " +
        (warn ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-muted text-muted-foreground")
      }
    >
      <span
        className={"h-1.5 w-1.5 rounded-full " + (warn ? "bg-amber-500" : "bg-muted-foreground")}
        aria-hidden
      />
      <span className="font-mono">{label}</span>
    </span>
  );
}
