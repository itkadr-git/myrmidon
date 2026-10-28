import { evaluateDevflowThresholds, type DevflowMetric } from "./thresholds.js";

export interface DevflowSample {
  companyId: string;
  subjectId: string;
  subjectKind: "agent" | "issue";
  title: string;
  metric: DevflowMetric;
  since: string;
}
export interface DevflowSignal extends DevflowSample {
  durationMs: number;
  dedupKey: string;
}

export function buildDevflowSignals(samples: DevflowSample[], settings: unknown, now: Date): DevflowSignal[] {
  return samples.flatMap((sample) => {
    const since = Date.parse(sample.since);
    if (!Number.isFinite(since) || since > now.getTime()) return [];
    const durationMs = now.getTime() - since;
    return evaluateDevflowThresholds({ [sample.metric]: durationMs }, settings)
      .map(() => ({ ...sample, durationMs, dedupKey: `devflow:${sample.companyId}:${sample.metric}:${sample.subjectId}` }));
  });
}

/** Red means an actual failed completion, not a cancelled/skipped/pending run. */
export function redCiSince(events: { conclusion: string | null; at: string }[]): string | null {
  let since: string | null = null;
  const sorted = events.filter((e) => Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const event of sorted) {
    if (event.conclusion === "success") since = null;
    else if (["failure", "timed_out", "action_required", "startup_failure"].includes(event.conclusion ?? "")) since ??= event.at;
  }
  return since;
}
