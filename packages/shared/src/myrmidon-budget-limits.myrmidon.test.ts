// packages/shared/src/myrmidon-budget-limits.myrmidon.test.ts
//
// myrmidon(1.7-BUDGET-CONFIG A): the shared contract — signal-only resolution
// (default / stored / env forced override, typo safety), window math, and the
// over-limit predicate.

import { describe, expect, it } from "vitest";
import {
  budgetLimitWindow,
  budgetLimitsExportQuerySchema,
  budgetLimitsReportToCsv,
  escapeCsvCell,
  isBudgetLimitOver,
  normalizeBudgetLimitsSettings,
  resolveBudgetLimitsSignalOnly,
} from "./myrmidon-budget-limits.js";

describe("myrmidon(1.7-BUDGET-CONFIG A) shared contract", () => {
  it("signal-only defaults to ON when nothing is stored", () => {
    const resolved = resolveBudgetLimitsSignalOnly(undefined, {});
    expect(resolved).toEqual({ signalOnly: true, source: "default" });
  });

  it("an unreadable stored value falls back to the safe default", () => {
    expect(resolveBudgetLimitsSignalOnly("garbage", {})).toEqual({ signalOnly: true, source: "default" });
    expect(normalizeBudgetLimitsSettings({ signalOnly: "yes" })).toEqual({ signalOnly: true });
  });

  it("a stored value wins over the default and reports its source", () => {
    expect(resolveBudgetLimitsSignalOnly({ signalOnly: false }, {})).toEqual({
      signalOnly: false,
      source: "stored",
    });
    expect(resolveBudgetLimitsSignalOnly({ signalOnly: true }, {})).toEqual({
      signalOnly: true,
      source: "stored",
    });
  });

  it("the env variable is a forced override and reports source env", () => {
    expect(resolveBudgetLimitsSignalOnly({ signalOnly: true }, { MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY: "0" })).toEqual({
      signalOnly: false,
      source: "env",
    });
    expect(resolveBudgetLimitsSignalOnly({ signalOnly: false }, { MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY: "on" })).toEqual({
      signalOnly: true,
      source: "env",
    });
  });

  it("a typo in the env variable never flips the owner's choice", () => {
    expect(resolveBudgetLimitsSignalOnly({ signalOnly: false }, { MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY: "tru" })).toEqual({
      signalOnly: false,
      source: "stored",
    });
    expect(resolveBudgetLimitsSignalOnly(undefined, { MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY: "tru" })).toEqual({
      signalOnly: true,
      source: "default",
    });
  });

  it("calendar_month_utc is the [first of this UTC month, first of the next)", () => {
    const now = new Date("2026-10-04T15:30:00Z");
    const window = budgetLimitWindow("calendar_month_utc", now);
    expect(window.start?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(window.end?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("lifetime is unbounded", () => {
    expect(budgetLimitWindow("lifetime")).toEqual({ start: null, end: null });
  });

  it("isBudgetLimitOver is strict and respects isActive", () => {
    expect(isBudgetLimitOver({ amountCents: 100, isActive: true }, 101)).toBe(true);
    expect(isBudgetLimitOver({ amountCents: 100, isActive: true }, 100)).toBe(false);
    expect(isBudgetLimitOver({ amountCents: 100, isActive: true }, 0)).toBe(false);
    expect(isBudgetLimitOver({ amountCents: 100, isActive: false }, 1_000)).toBe(false);
    expect(isBudgetLimitOver({ amountCents: 0, isActive: true }, 1)).toBe(true);
  });

  describe("report export contract", () => {
    it("validates export query format with defaults", () => {
      expect(budgetLimitsExportQuerySchema.parse({})).toEqual({ format: "json" });
      expect(budgetLimitsExportQuerySchema.parse({ format: "csv" })).toEqual({ format: "csv" });
      expect(budgetLimitsExportQuerySchema.parse({ format: "json", level: "caste" })).toEqual({
        format: "json",
        level: "caste",
      });
      expect(() => budgetLimitsExportQuerySchema.parse({ format: "yaml" })).toThrow();
      expect(() => budgetLimitsExportQuerySchema.parse({ level: "invalid" })).toThrow();
    });

    it("escapes CSV cells safely", () => {
      expect(escapeCsvCell("simple")).toBe("simple");
      expect(escapeCsvCell('with, comma and "quotes"')).toBe('"with, comma and ""quotes"""');
      expect(escapeCsvCell("multiline\ntext")).toBe('"multiline\ntext"');
      expect(escapeCsvCell(null)).toBe("");
      expect(escapeCsvCell(undefined)).toBe("");
      expect(escapeCsvCell(1234)).toBe("1234");
    });

    it("serializes rows to CSV including headers", () => {
      const csv = budgetLimitsReportToCsv([
        {
          level: "nest",
          ref: "company",
          period: "calendar_month_utc",
          mode: "soft",
          amountCents: 50000,
          spentCents: 12500,
          events: 10,
          overLimit: false,
          isActive: true,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      ]);
      const lines = csv.split("\n");
      expect(lines[0]).toBe("level,ref,period,mode,amount_cents,spent_cents,events,over_limit,is_active,created_at,updated_at");
      expect(lines[1]).toBe("nest,company,calendar_month_utc,soft,50000,12500,10,false,true,2026-10-01T00:00:00.000Z,2026-10-01T00:00:00.000Z");
    });
  });
});
