import { describe, expect, it } from "vitest";
import {
  matchRules,
  parseRules,
  ruleMatches,
  validateRules,
  type MailMessageInfo,
  type MailSortRule,
} from "../src/rules.js";

function msg(partial: Partial<MailMessageInfo>): MailMessageInfo {
  return {
    uid: 1,
    from: "sender@example.com",
    subject: "Quarterly report",
    hasAttachment: false,
    ...partial,
  };
}

describe("ruleMatches", () => {
  it("matches by from (case-insensitive substring)", () => {
    const rule: MailSortRule = { fromContains: "EXAMPLE.com", targetFolder: "IN" };
    expect(ruleMatches(rule, msg({ from: "Alice <alice@example.com>" }))).toBe(true);
    expect(ruleMatches(rule, msg({ from: "bob@other.org" }))).toBe(false);
  });

  it("matches by subject (case-insensitive substring)", () => {
    const rule: MailSortRule = { subjectContains: "REPORT", targetFolder: "IN" };
    expect(ruleMatches(rule, msg({ subject: "quarterly Report Q3" }))).toBe(true);
    expect(ruleMatches(rule, msg({ subject: "invoice" }))).toBe(false);
  });

  it("matches by hasAttachment", () => {
    const rule: MailSortRule = { hasAttachment: true, targetFolder: "IN" };
    expect(ruleMatches(rule, msg({ hasAttachment: true }))).toBe(true);
    expect(ruleMatches(rule, msg({ hasAttachment: false }))).toBe(false);
  });

  it("requires all conditions to hold (AND)", () => {
    const rule: MailSortRule = { fromContains: "boss@", subjectContains: "urgent", targetFolder: "IN" };
    expect(ruleMatches(rule, msg({ from: "boss@corp.io", subject: "urgent: read" }))).toBe(true);
    expect(ruleMatches(rule, msg({ from: "boss@corp.io", subject: "weekly" }))).toBe(false);
    expect(ruleMatches(rule, msg({ from: "other@corp.io", subject: "urgent" }))).toBe(false);
  });

  it("a rule without conditions matches everything", () => {
    expect(ruleMatches({ targetFolder: "ALL" }, msg({}))).toBe(true);
  });
});

describe("matchRules", () => {
  const rules: MailSortRule[] = [
    { name: "newsletters", fromContains: "news@", targetFolder: "Read later" },
    { name: "invoices", subjectContains: "invoice", targetFolder: "Finance" },
  ];

  it("applies the first matching rule in order", () => {
    const match = matchRules(rules, msg({ from: "news@site.io", subject: "invoice inside" }));
    expect(match.ruleName).toBe("newsletters");
    expect(match.targetFolder).toBe("Read later");
  });

  it("falls through to later rules", () => {
    const match = matchRules(rules, msg({ from: "acc@corp.io", subject: "invoice #42" }));
    expect(match.ruleName).toBe("invoices");
    expect(match.targetFolder).toBe("Finance");
  });

  it("returns the default folder when nothing matches", () => {
    const match = matchRules(rules, msg({ subject: "hello" }), "Misc");
    expect(match.rule).toBeNull();
    expect(match.targetFolder).toBe("Misc");
  });

  it("returns null target when nothing matches and no default", () => {
    const match = matchRules(rules, msg({ subject: "hello" }));
    expect(match.targetFolder).toBeNull();
  });

  it("reports a null ruleName for unnamed rules", () => {
    const match = matchRules([{ subjectContains: "report", targetFolder: "Reports" }], msg({}));
    expect(match.ruleName).toBeNull();
    expect(match.targetFolder).toBe("Reports");
  });
});

describe("validateRules", () => {
  it("accepts undefined and empty arrays", () => {
    expect(validateRules(undefined)).toEqual([]);
    expect(validateRules([])).toEqual([]);
  });

  it("rejects non-array input", () => {
    expect(validateRules("x")).toHaveLength(1);
  });

  it("rejects rules without targetFolder", () => {
    expect(validateRules([{ subjectContains: "a" }])).toHaveLength(1);
  });

  it("rejects rules with empty targetFolder", () => {
    expect(validateRules([{ targetFolder: "  " }])).toHaveLength(1);
  });

  it("rejects non-boolean hasAttachment", () => {
    expect(validateRules([{ targetFolder: "X", hasAttachment: "yes" }])).toHaveLength(1);
  });
});

describe("parseRules", () => {
  it("normalises rules and keeps the target folder verbatim", () => {
    const parsed = parseRules([{ name: "a", subjectContains: "s", targetFolder: "Folder" }]);
    expect(parsed).toEqual([{ name: "a", subjectContains: "s", targetFolder: "Folder" }]);
  });

  it("returns an empty array for invalid input", () => {
    expect(parseRules(null)).toEqual([]);
    expect(parseRules([{ targetFolder: "" }])).toEqual([]);
  });
});
