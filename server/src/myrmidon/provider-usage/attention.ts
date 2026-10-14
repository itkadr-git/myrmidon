export interface ProviderUsageAttentionCard {
  dedupKey: string;
  title: string;
  whyNow: string;
  severity: "medium" | "high";
  summaryExcerpt: string;
  metadata: Record<string, unknown>;
}

type Warning = {
  key: string; provider: string; credentialRef: string; window: string;
  observedAt: string; resetsAt: string; thresholdPercent: number;
  metric: string; used: number; limit: number; remaining: number; remainingPercent: number;
};

export function buildProviderUsageAttentionCard(warning: Warning): ProviderUsageAttentionCard {
  const whyNow = `${warning.provider} usage is at ${warning.thresholdPercent}% for ${warning.metric}; ${warning.remaining} remains before window reset at ${warning.resetsAt}.`;
  return {
    dedupKey: `provider-usage:${warning.key}`,
    title: `${warning.provider} usage approaching limit`,
    whyNow,
    severity: warning.remainingPercent <= 5 ? "high" : "medium",
    summaryExcerpt: whyNow,
    metadata: {
      provider: warning.provider,
      credentialRef: warning.credentialRef,
      window: warning.window,
      metric: warning.metric,
      used: warning.used,
      limit: warning.limit,
      remaining: warning.remaining,
      remainingPercent: warning.remainingPercent,
      thresholdPercent: warning.thresholdPercent,
      observedAt: warning.observedAt,
      resetsAt: warning.resetsAt,
    },
  };
}
