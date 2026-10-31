// server/src/myrmidon/guardrails/metrics.ts
//
// Process-local guardrail trigger counters. Labels are deliberately bounded to
// the closed rule/mode sets; detector subtypes and input values never become
// Prometheus labels.

export const GUARDRAIL_METRIC_RULES = ["secret", "pii", "injection"] as const;
export type GuardrailMetricRule = (typeof GUARDRAIL_METRIC_RULES)[number];

export const GUARDRAIL_METRIC_MODES = ["flag", "mask", "block"] as const;
export type GuardrailMetricMode = (typeof GUARDRAIL_METRIC_MODES)[number];

export type GuardrailTriggerCounts = Record<GuardrailMetricRule, Record<GuardrailMetricMode, number>>;

function emptyCounts(): GuardrailTriggerCounts {
  return {
    secret: { flag: 0, mask: 0, block: 0 },
    pii: { flag: 0, mask: 0, block: 0 },
    injection: { flag: 0, mask: 0, block: 0 },
  };
}

function validRule(value: unknown): value is GuardrailMetricRule {
  return typeof value === "string" && (GUARDRAIL_METRIC_RULES as readonly string[]).includes(value);
}

function validMode(value: unknown): value is GuardrailMetricMode {
  return typeof value === "string" && (GUARDRAIL_METRIC_MODES as readonly string[]).includes(value);
}

export interface GuardrailTriggerMetrics {
  record(rule: unknown, mode?: unknown, count?: unknown): void;
  read(): GuardrailTriggerCounts;
  reset(): void;
}

export function createGuardrailTriggerMetrics(): GuardrailTriggerMetrics {
  let counts = emptyCounts();
  return {
    record(rule, mode = "flag", count = 1): void {
      if (!validRule(rule)) throw new Error(`invalid guardrail metric rule: ${String(rule)}`);
      if (!validMode(mode)) throw new Error(`invalid guardrail metric mode: ${String(mode)}`);
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        throw new Error(`invalid guardrail metric count: ${String(count)}`);
      }
      counts[rule][mode] += count;
    },
    read(): GuardrailTriggerCounts {
      return {
        secret: { ...counts.secret },
        pii: { ...counts.pii },
        injection: { ...counts.injection },
      };
    },
    reset(): void {
      counts = emptyCounts();
    },
  };
}

export const guardrailTriggerMetrics = createGuardrailTriggerMetrics();
