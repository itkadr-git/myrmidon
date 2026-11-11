import type { GuardrailRuleRecord } from "@myrmidon/shared";

export const MOCK_GUARDRAIL_RULES: GuardrailRuleRecord[] = [
  {
    id: "rule-injection-01",
    name: "Prompt Injection Defense",
    description: "Detects prompt injection attempts in input wake payloads",
    type: "injection",
    status: "active",
    mode: "flag",
    surface: "input",
    pattern: null,
    config: { threshold: 0.8 },
    companyId: null,
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    updatedAt: new Date("2026-10-01T10:00:00.000Z"),
  },
  {
    id: "rule-secret-01",
    name: "Credential & Key Leak Prevention",
    description: "Blocks API keys and private tokens in output streams",
    type: "secret",
    status: "active",
    mode: "block",
    surface: "output",
    pattern: "pcp_[a-zA-Z0-9_-]+",
    config: null,
    companyId: null,
    createdAt: new Date("2026-10-02T11:00:00.000Z"),
    updatedAt: new Date("2026-10-02T11:00:00.000Z"),
  },
  {
    id: "rule-pii-01",
    name: "Personally Identifiable Info Filter",
    description: "Masks emails and phone numbers in model responses",
    type: "pii",
    status: "active",
    mode: "mask",
    surface: "output",
    pattern: null,
    config: { categories: ["email", "phone"] },
    companyId: null,
    createdAt: new Date("2026-10-03T12:00:00.000Z"),
    updatedAt: new Date("2026-10-03T12:00:00.000Z"),
  },
  {
    id: "rule-regex-01",
    name: "SSN Pattern Blocker",
    description: "Matches social security numbers and prevents publication",
    type: "regex",
    status: "disabled",
    mode: "block",
    surface: "output",
    pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
    config: null,
    companyId: null,
    createdAt: new Date("2026-10-04T13:00:00.000Z"),
    updatedAt: new Date("2026-10-04T13:00:00.000Z"),
  },
  {
    id: "rule-content-01",
    name: "Toxic Output Guard",
    description: "Warns when abusive language patterns are detected",
    type: "content",
    status: "draft",
    mode: "warn",
    surface: "all",
    pattern: null,
    config: { severity: "high" },
    companyId: null,
    createdAt: new Date("2026-10-05T14:00:00.000Z"),
    updatedAt: new Date("2026-10-05T14:00:00.000Z"),
  },
  {
    id: "rule-custom-01",
    name: "Deprecated Compliance Rule",
    description: "Legacy rule archived during safety upgrade",
    type: "custom",
    status: "archived",
    mode: "flag",
    surface: "all",
    pattern: null,
    config: null,
    companyId: null,
    createdAt: new Date("2026-09-01T08:00:00.000Z"),
    updatedAt: new Date("2026-10-06T15:00:00.000Z"),
  },
];

export function createMockGuardrailRule(overrides?: Partial<GuardrailRuleRecord>): GuardrailRuleRecord {
  const id = overrides?.id ?? `rule-${Math.random().toString(36).slice(2, 9)}`;
  return {
    id,
    name: overrides?.name ?? `Rule ${id}`,
    description: overrides?.description ?? "Mock guardrail rule",
    type: overrides?.type ?? "secret",
    status: overrides?.status ?? "active",
    mode: overrides?.mode ?? "flag",
    surface: overrides?.surface ?? "output",
    pattern: overrides?.pattern ?? null,
    config: overrides?.config ?? null,
    companyId: overrides?.companyId ?? null,
    createdAt: overrides?.createdAt ?? new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: overrides?.updatedAt ?? new Date("2026-10-01T00:00:00.000Z"),
  };
}

export function generateMockGuardrailRules(count: number, prefix = "rule"): GuardrailRuleRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const num = String(i + 1).padStart(3, "0");
    const types: GuardrailRuleRecord["type"][] = ["secret", "pii", "injection", "regex", "content", "custom"];
    const statuses: GuardrailRuleRecord["status"][] = ["active", "disabled", "draft", "archived"];
    const modes: NonNullable<GuardrailRuleRecord["mode"]>[] = ["block", "mask", "flag", "warn"];
    
    return {
      id: `${prefix}-${num}`,
      name: `Guardrail Rule ${num}`,
      description: `Description for rule ${num}`,
      type: types[i % types.length],
      status: statuses[i % statuses.length],
      mode: modes[i % modes.length],
      surface: i % 2 === 0 ? "input" : "output",
      pattern: i % 3 === 0 ? `pattern_${num}` : null,
      config: null,
      companyId: null,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, i, 0)),
      updatedAt: new Date(Date.UTC(2026, 9, 1, 0, i, 0)),
    };
  });
}
