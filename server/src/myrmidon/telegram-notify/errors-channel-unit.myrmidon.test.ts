// myrmidon(1.6-TG-NOTIFY-C): unit tests of the errors-channel filter, the
// rate limiter and the settings parser. No database here; the sweep's
// end-to-end behaviour (publication staging against the fake Telegram
// transport) lives in errors-channel.myrmidon.test.ts.

import { describe, expect, it } from "vitest";
import { defaultTelegramNotifySettings } from "@paperclipai/shared";
import {
  ERROR_CHANNEL_SOURCE_KINDS,
  ERROR_CHANNEL_TEXT_MAX,
  errorChannelCardText,
  errorChannelPublicationKey,
  filterErrorChannelCard,
  HourlyRateLimiter,
  type ErrorChannelSettings,
} from "./errors.js";

const OFF: ErrorChannelSettings = { ...defaultTelegramNotifySettings().errors };
const ON: ErrorChannelSettings = {
  enabled: true,
  chatId: "-1001234567890",
  topicId: null,
  minSeverity: "error",
  maxPerHour: 10,
};

describe("filterErrorChannelCard", () => {
  it("sends nothing when the channel is disabled (the default)", () => {
    expect(filterErrorChannelCard(OFF, { sourceKind: "failed_run", severity: "critical" })).toEqual({
      send: false,
      reason: "disabled",
    });
  });

  it("sends nothing without a chat target even when enabled", () => {
    expect(filterErrorChannelCard({ ...ON, chatId: null }, { sourceKind: "failed_run", severity: "critical" })).toEqual({
      send: false,
      reason: "no_chat",
    });
  });

  it("admits error-kind cards at or above the error threshold", () => {
    for (const sourceKind of ERROR_CHANNEL_SOURCE_KINDS) {
      expect(filterErrorChannelCard(ON, { sourceKind, severity: "high" })).toEqual({ send: true });
      expect(filterErrorChannelCard(ON, { sourceKind, severity: "critical" })).toEqual({ send: true });
    }
  });

  it("keeps non-error attention kinds out of the channel", () => {
    for (const sourceKind of ["approval", "decision", "review", "stack_update", "join_request"] as const) {
      expect(filterErrorChannelCard(ON, { sourceKind, severity: "critical" })).toEqual({
        send: false,
        reason: "not_error_kind",
      });
    }
  });

  it("threshold error drops medium/low; threshold warning admits medium but not low", () => {
    expect(filterErrorChannelCard(ON, { sourceKind: "budget_alert", severity: "medium" })).toEqual({
      send: false,
      reason: "below_threshold",
    });
    expect(filterErrorChannelCard(ON, { sourceKind: "budget_alert", severity: "low" })).toEqual({
      send: false,
      reason: "below_threshold",
    });
    const warning: ErrorChannelSettings = { ...ON, minSeverity: "warn" };
    expect(filterErrorChannelCard(warning, { sourceKind: "budget_alert", severity: "medium" })).toEqual({ send: true });
    expect(filterErrorChannelCard(warning, { sourceKind: "budget_alert", severity: "low" })).toEqual({
      send: false,
      reason: "below_threshold",
    });
    const fatal: ErrorChannelSettings = { ...ON, minSeverity: "fatal" };
    expect(filterErrorChannelCard(fatal, { sourceKind: "failed_run", severity: "critical" })).toEqual({ send: true });
    expect(filterErrorChannelCard(fatal, { sourceKind: "failed_run", severity: "high" })).toEqual({
      send: false,
      reason: "below_threshold",
    });
  });
});

describe("HourlyRateLimiter", () => {
  const HOUR = 60 * 60 * 1000;
  const base = Date.parse("2026-10-03T10:00:00.000Z");
  let clock = base;
  const now = () => new Date(clock);

  it("admits up to the limit and drops the rest (no queueing)", () => {
    const limiter = new HourlyRateLimiter(now);
    const verdicts = Array.from({ length: 12 }, () => limiter.admit("company-a", 10));
    expect(verdicts.filter(Boolean)).toHaveLength(10);
    expect(verdicts.slice(10)).toEqual([false, false]);
  });

  it("re-admits after the hour window rolls", () => {
    const limiter = new HourlyRateLimiter(now);
    for (let i = 0; i < 10; i += 1) expect(limiter.admit("company-a", 10)).toBe(true);
    expect(limiter.admit("company-a", 10)).toBe(false);
    clock = base + HOUR + 1;
    expect(limiter.admit("company-a", 10)).toBe(true);
  });

  it("counts companies separately", () => {
    const limiter = new HourlyRateLimiter(now);
    for (let i = 0; i < 10; i += 1) expect(limiter.admit("company-a", 10)).toBe(true);
    expect(limiter.admit("company-b", 10)).toBe(true);
    expect(limiter.admit("company-a", 10)).toBe(false);
  });

  it("treats a non-positive limit as always dropped", () => {
    const limiter = new HourlyRateLimiter(now);
    expect(limiter.admit("company-a", 0)).toBe(false);
  });
});

describe("errorChannelCardText", () => {
  it("builds one neutral line: [severity] title: whyNow", () => {
    expect(
      errorChannelCardText({
        sourceKind: "failed_run",
        severity: "high",
        subject: {
          kind: "run",
          companyId: "c1",
          identifier: null,
          status: null,
          href: null,
          title: "agent-a run failed",
          id: "run-1",
        },
        whyNow: "Run failed after automatic retries were exhausted.",
      }),
    ).toBe("[high] agent-a run failed: Run failed after automatic retries were exhausted.");
  });

  it("falls back to the subject id when the title is null and clamps length", () => {
    const text = errorChannelCardText({
      sourceKind: "agent_error_alert",
      severity: "critical",
      subject: {
        kind: "agent",
        companyId: "c1",
        identifier: null,
        status: null,
        href: null,
        title: null,
        id: "agent-b",
      },
      whyNow: "x".repeat(ERROR_CHANNEL_TEXT_MAX + 50),
    });
    expect(text).toMatch(/^\[critical\] agent-b: x+/);
    expect(text.length).toBeLessThanOrEqual(ERROR_CHANNEL_TEXT_MAX);
  });
});

describe("errorChannelPublicationKey", () => {
  it("keys the publication by company and card dedup key", () => {
    expect(errorChannelPublicationKey({ companyId: "c1", dedupKey: "agent_error:a1" })).toBe(
      "notify:errors:c1:agent_error:a1",
    );
  });

  it("hasRoom does not charge; consume does", () => {
    clock = base;
    const limiter = new HourlyRateLimiter(now);
    for (let i = 0; i < 5; i += 1) expect(limiter.hasRoom("company-a", 2)).toBe(true);
    limiter.consume("company-a");
    expect(limiter.hasRoom("company-a", 2)).toBe(true);
    limiter.consume("company-a");
    expect(limiter.hasRoom("company-a", 2)).toBe(false);
    clock = base + HOUR + 1;
    expect(limiter.hasRoom("company-a", 2)).toBe(true);
    expect(limiter.hasRoom("company-a", 0)).toBe(false);
  });
});
