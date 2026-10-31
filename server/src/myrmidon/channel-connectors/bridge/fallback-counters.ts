// server/src/myrmidon/channel-connectors/bridge/fallback-counters.ts
//
// myrmidon(1.6.6 CH-CONNECTOR-G): the counters behind the fallback chain of the
// bridge seam. Design OPE-6985: when the channel adapter does not answer, the
// traffic returns to the direct path — and the board must be able to see how
// often that happens and why.
//
// One in-process counter per reason, read on the fly by the metrics endpoint
// (family `myrmidon_adapter_fallback_total{reason}`). No store, no timer, no
// migration: a restart zeroes the series, the same shape the other in-process
// registries of the board have (swarm signals, load lanes).

/** Why the adapter call ended on the direct path. */
export type ChannelBridgeFallbackReason = "error" | "timeout";

/**
 * The reasons in exposition order. Both render even at zero — "the adapter
 * never fell back" is information, and a missing series would be
 * indistinguishable from an unwired counter.
 */
export const CHANNEL_BRIDGE_FALLBACK_REASONS: readonly ChannelBridgeFallbackReason[] = [
  "error",
  "timeout",
];

/** One family sample: how often one reason took the traffic back. */
export interface ChannelBridgeFallbackSample {
  reason: ChannelBridgeFallbackReason;
  count: number;
}

/**
 * Source seam of the metrics collector: a test (or a future out-of-process
 * reader) can substitute the counters without touching the process registry.
 */
export type ChannelBridgeFallbackSource =
  | (() => ChannelBridgeFallbackSample[])
  | { read(): ChannelBridgeFallbackSample[] };

const counters = new Map<ChannelBridgeFallbackReason, number>();

/** Records one fallback: an adapter call ended on the direct path. */
export function recordChannelBridgeFallback(reason: ChannelBridgeFallbackReason): void {
  counters.set(reason, (counters.get(reason) ?? 0) + 1);
}

/** Every reason's total, always all of {@link CHANNEL_BRIDGE_FALLBACK_REASONS}. */
export function readChannelBridgeFallbackSample(): ChannelBridgeFallbackSample[] {
  return CHANNEL_BRIDGE_FALLBACK_REASONS.map((reason) => ({
    reason,
    count: counters.get(reason) ?? 0,
  }));
}

/** Resolves the fallback source of a scrape, defaulting to the process registry. */
export function resolveChannelBridgeFallbackSource(
  source?: ChannelBridgeFallbackSource | null,
): () => ChannelBridgeFallbackSample[] {
  if (!source) return readChannelBridgeFallbackSample;
  return typeof source === "function" ? source : () => source.read();
}

/** Drops every counter. Test-only: the process never resets them. */
export function resetChannelBridgeFallbackCounters(): void {
  counters.clear();
}