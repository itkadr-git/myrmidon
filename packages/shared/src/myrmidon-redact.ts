import { z } from "zod";

export const redactRuleNames = ["counterparties", "signers", "contracts", "invoices"] as const;
export type RedactRuleName = (typeof redactRuleNames)[number];
export type RedactMode = "redact" | "disabled";

export interface NestRedactConfig {
  mode: RedactMode;
  rules: Record<RedactRuleName, boolean>;
  counterparties: Record<string, string>;
  signers: Record<string, string>;
  contractNumbers: string[];
  invoiceNumbers: string[];
}

export interface RedactMatch {
  kind: RedactRuleName;
  source: string;
  replacement: string;
}

export const nestRedactConfigSchema = z.object({
  mode: z.enum(["redact", "disabled"]).optional(),
  rules: z.object({
    counterparties: z.boolean().optional(),
    signers: z.boolean().optional(),
    contracts: z.boolean().optional(),
    invoices: z.boolean().optional(),
  }).strict().optional(),
  counterparties: z.record(z.string(), z.string()).optional(),
  signers: z.record(z.string(), z.string()).optional(),
  contractNumbers: z.array(z.string().min(1)).optional(),
  invoiceNumbers: z.array(z.string().min(1)).optional(),
}).strict();

export type NestRedactConfigPatch = z.infer<typeof nestRedactConfigSchema>;

export const defaultNestRedactConfig = (): NestRedactConfig => ({
  mode: "redact",
  rules: { counterparties: true, signers: true, contracts: true, invoices: true },
  counterparties: {},
  signers: {},
  contractNumbers: [],
  invoiceNumbers: [],
});

export function mergeNestRedactConfig(
  current: NestRedactConfig | undefined,
  patch: NestRedactConfigPatch,
): NestRedactConfig {
  const base = current ?? defaultNestRedactConfig();
  return {
    mode: patch.mode ?? base.mode,
    rules: { ...base.rules, ...(patch.rules ?? {}) },
    counterparties: { ...base.counterparties, ...(patch.counterparties ?? {}) },
    signers: { ...base.signers, ...(patch.signers ?? {}) },
    contractNumbers: patch.contractNumbers ?? base.contractNumbers,
    invoiceNumbers: patch.invoiceNumbers ?? base.invoiceNumbers,
  };
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

function dictionaryMatches(text: string, dictionary: Record<string, string>, kind: RedactRuleName): RedactMatch[] {
  return Object.entries(dictionary)
    .filter(([source]) => source.length > 0 && new RegExp(escaped(source), "iu").test(text))
    .map(([source, replacement]) => ({ kind, source, replacement }));
}

function numberMatches(text: string, numbers: string[], kind: RedactRuleName): RedactMatch[] {
  return numbers.filter((source) => source.length > 0 && text.toLocaleLowerCase().includes(source.toLocaleLowerCase()))
    .map((source) => ({ kind, source, replacement: "[REDACTED]" }));
}

export function redactText(text: string, config: NestRedactConfig): { text: string; matches: RedactMatch[] } {
  if (config.mode === "disabled") return { text, matches: [] };
  const matches = [
    ...(config.rules.counterparties ? dictionaryMatches(text, config.counterparties, "counterparties") : []),
    ...(config.rules.signers ? dictionaryMatches(text, config.signers, "signers") : []),
    ...(config.rules.contracts ? numberMatches(text, config.contractNumbers, "contracts") : []),
    ...(config.rules.invoices ? numberMatches(text, config.invoiceNumbers, "invoices") : []),
  ];
  return { text: matches.reduce((result, match) => result.replace(new RegExp(escaped(match.source), "giu"), match.replacement), text), matches };
}
