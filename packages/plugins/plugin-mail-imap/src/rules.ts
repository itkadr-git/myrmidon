/**
 * Pure rule-matching engine for the mail plugin.
 *
 * A message is tested against the rules in declaration order; the first rule
 * whose conditions all hold wins. A rule with no conditions matches every
 * message. When nothing matches, the optional default target folder applies;
 * otherwise the message is left in the source folder.
 */

export interface MailSortRule {
  name?: string;
  fromContains?: string;
  subjectContains?: string;
  hasAttachment?: boolean;
  targetFolder: string;
}

export interface MailMessageInfo {
  uid: number;
  from: string;
  subject: string;
  hasAttachment: boolean;
  messageId?: string;
  date?: string;
}

export interface RuleMatchResult {
  rule: MailSortRule | null;
  ruleName: string | null;
  targetFolder: string | null;
}

export function ruleMatches(rule: MailSortRule, message: MailMessageInfo): boolean {
  if (rule.fromContains !== undefined && rule.fromContains !== "") {
    if (!message.from.toLowerCase().includes(rule.fromContains.toLowerCase())) return false;
  }
  if (rule.subjectContains !== undefined && rule.subjectContains !== "") {
    if (!message.subject.toLowerCase().includes(rule.subjectContains.toLowerCase())) return false;
  }
  if (rule.hasAttachment !== undefined) {
    if (message.hasAttachment !== rule.hasAttachment) return false;
  }
  return true;
}

export function matchRules(
  rules: readonly MailSortRule[],
  message: MailMessageInfo,
  defaultTargetFolder?: string,
): RuleMatchResult {
  for (const rule of rules) {
    if (ruleMatches(rule, message)) {
      return { rule, ruleName: rule.name ?? null, targetFolder: rule.targetFolder };
    }
  }
  if (defaultTargetFolder) {
    return { rule: null, ruleName: "default", targetFolder: defaultTargetFolder };
  }
  return { rule: null, ruleName: null, targetFolder: null };
}

/** Validate operator-supplied rules; returns a list of human-readable problems. */
export function validateRules(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return ["sortRules must be an array"];
  const problems: string[] = [];
  value.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      problems.push(`rule ${index + 1}: must be an object`);
      return;
    }
    const rule = entry as Record<string, unknown>;
    if (typeof rule.targetFolder !== "string" || rule.targetFolder.trim() === "") {
      problems.push(`rule ${index + 1}: targetFolder is required`);
    }
    for (const key of ["fromContains", "subjectContains"] as const) {
      if (rule[key] !== undefined && typeof rule[key] !== "string") {
        problems.push(`rule ${index + 1}: ${key} must be a string`);
      }
    }
    if (rule.hasAttachment !== undefined && typeof rule.hasAttachment !== "boolean") {
      problems.push(`rule ${index + 1}: hasAttachment must be a boolean`);
    }
  });
  return problems;
}

/** Coerce untrusted config JSON into typed rules, dropping invalid entries. */
export function parseRules(value: unknown): MailSortRule[] {
  if (!Array.isArray(value)) return [];
  const rules: MailSortRule[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.targetFolder !== "string" || raw.targetFolder.trim() === "") continue;
    rules.push({
      name: typeof raw.name === "string" ? raw.name : undefined,
      fromContains: typeof raw.fromContains === "string" ? raw.fromContains : undefined,
      subjectContains: typeof raw.subjectContains === "string" ? raw.subjectContains : undefined,
      hasAttachment: typeof raw.hasAttachment === "boolean" ? raw.hasAttachment : undefined,
      targetFolder: raw.targetFolder,
    });
  }
  return rules;
}
