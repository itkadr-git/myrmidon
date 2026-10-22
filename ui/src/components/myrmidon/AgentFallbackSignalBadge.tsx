// myrmidon(BOT-RUNTIME-TUNING D2): the model-fallback signal on an agent card.
//
// The attention feed already carries the card "this bot was silently served a
// different model"; the goal of the parent ticket is to see it ON the agent's
// own card, next to the bot, the way the WIP badge shows load. The badge is
// read-only: it renders the above-threshold row of the last sweep and renders
// nothing at all for a healthy bot, a bot that was never evaluated, or a bot
// whose card decides its own models (those are never evaluated).
//
// Tokens only (DESIGN.md): the same utility set the WIP badge uses, no raw
// values.
import type { FallbackSignalStatusRow } from "./modelFallbackSignalApi";

export function AgentFallbackSignalBadge({ row }: { row: FallbackSignalStatusRow | undefined }) {
  if (!row || !row.aboveThreshold) return null;
  return (
    <span
      data-testid={`agent-fallback-signal-${row.agentId}`}
      data-share-pct={String(row.sharePct)}
      title={`${row.fallbacks} of ${row.total} gateway calls were served by a model outside this bot's card`}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-(length:--text-micro) font-medium whitespace-nowrap bg-destructive/10 text-destructive"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden />
      <span className="font-mono">{`fallback ${row.sharePct}%`}</span>
    </span>
  );
}