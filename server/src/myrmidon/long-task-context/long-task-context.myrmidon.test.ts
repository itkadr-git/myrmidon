import { describe, expect, it } from "vitest";
import {
  LONG_TASK_CONTEXT_DEFAULT_FALLBACK_WINDOW_TOKENS,
  LONG_TASK_CONTEXT_DEFAULT_HISTORY_CHARS,
  LONG_TASK_CONTEXT_DEFAULT_RESET_PCT,
  LONG_TASK_CONTEXT_SETTINGS_KEY,
  longTaskContextPct,
  normalizeLongTaskContextSettings,
  shouldResetTaskSessionForLongTaskContext,
} from "@paperclipai/shared";
import {
  COMPRESSION_TIMEOUT_ERROR_SIGNATURES,
  buildLongTaskContextResetNotice,
  isCompressionTimeoutError,
  issueThreadReference,
  planLongTaskContextReset,
} from "./domain.js";
import {
  LONG_TASK_CONTEXT_ENV_KEYS,
  resolveLongTaskContextSettings,
} from "./settings.js";

const settings = (overrides: Partial<ReturnType<typeof normalizeLongTaskContextSettings>> = {}) => ({
  ...normalizeLongTaskContextSettings(null),
  ...overrides,
});

describe("compression timeout signatures", () => {
  it("matches both production shapes of 09.10.2026", () => {
    expect(
      isCompressionTimeoutError(
        "Context compression timed out: approximately 214 298 / 378 739 tokens",
      ),
    ).toBe(true);
    expect(
      isCompressionTimeoutError("Context compression timed out without reducing this conversation"),
    ).toBe(true);
    expect(isCompressionTimeoutError("CONTEXT COMPRESSION TIMED OUT")).toBe(true);
  });

  it("does not match an ordinary failure", () => {
    expect(isCompressionTimeoutError("Connection timeout")).toBe(false);
    expect(isCompressionTimeoutError("")).toBe(false);
    expect(isCompressionTimeoutError(null)).toBe(false);
    expect(isCompressionTimeoutError(undefined)).toBe(false);
  });

  it("names both shapes the heartbeat signature list consumes", () => {
    expect([...COMPRESSION_TIMEOUT_ERROR_SIGNATURES]).toEqual([
      "context compression timed out",
      "compression timed out without reducing this conversation",
    ]);
  });
});

describe("issueThreadReference", () => {
  it("points omitted history at the thread it stays in", () => {
    expect(issueThreadReference("issue-a")).toBe("GET /api/issues/issue-a/comments (oldest first)");
    expect(issueThreadReference("  issue-a  ")).toContain("/api/issues/issue-a/comments");
    expect(issueThreadReference(null)).toBe("the task thread through the issue API");
    expect(issueThreadReference("")).toBe("the task thread through the issue API");
  });
});

describe("long task context settings", () => {
  it("defaults to enabled, 70%, a 200k fallback window and a 24k history budget", () => {
    const defaults = normalizeLongTaskContextSettings(null);
    expect(LONG_TASK_CONTEXT_SETTINGS_KEY).toBe("longTaskContext");
    expect(defaults).toEqual({
      enabled: true,
      resetPct: LONG_TASK_CONTEXT_DEFAULT_RESET_PCT,
      fallbackWindowTokens: LONG_TASK_CONTEXT_DEFAULT_FALLBACK_WINDOW_TOKENS,
      historyChars: LONG_TASK_CONTEXT_DEFAULT_HISTORY_CHARS,
    });
  });

  it("falls back to the defaults instead of half-applying a corrupt row", () => {
    expect(normalizeLongTaskContextSettings(undefined)).toEqual(settings());
    expect(normalizeLongTaskContextSettings("nonsense")).toEqual(settings());
    expect(normalizeLongTaskContextSettings({ resetPct: 250 })).toEqual(settings());
    expect(normalizeLongTaskContextSettings({ ...settings(), extra: true })).toEqual(settings());
  });

  it("keeps a usable stored row", () => {
    expect(normalizeLongTaskContextSettings({ ...settings(), resetPct: 55 }).resetPct).toBe(55);
  });

  it("lets the environment override single fields and records where they came from", () => {
    const resolved = resolveLongTaskContextSettings({
      stored: { ...settings(), resetPct: 55 },
      env: {
        [LONG_TASK_CONTEXT_ENV_KEYS.resetPct]: "40",
        [LONG_TASK_CONTEXT_ENV_KEYS.historyChars]: "15000",
      },
    });
    expect(resolved.settings.resetPct).toBe(40);
    expect(resolved.settings.historyChars).toBe(15_000);
    expect(resolved.settings.enabled).toBe(true);
    expect(resolved.sources.resetPct).toBe("env");
    expect(resolved.sources.historyChars).toBe("env");
    expect(resolved.sources.enabled).toBe("stored");
    expect(resolved.envKeys.resetPct).toBe("MYRMIDON_LONG_TASK_CONTEXT_RESET_PCT");
    expect(resolved.envKeys.enabled).toBeUndefined();
  });

  it("ignores an unparseable override instead of widening the guard", () => {
    const resolved = resolveLongTaskContextSettings({
      stored: null,
      env: {
        [LONG_TASK_CONTEXT_ENV_KEYS.resetPct]: "1e9",
        [LONG_TASK_CONTEXT_ENV_KEYS.enabled]: "maybe",
      },
    });
    expect(resolved.settings.resetPct).toBe(LONG_TASK_CONTEXT_DEFAULT_RESET_PCT);
    expect(resolved.settings.enabled).toBe(true);
    expect(resolved.sources.resetPct).toBe("default");
    expect(resolved.sources.enabled).toBe("default");
  });

  it("reports the defaults as such when nothing usable is stored", () => {
    const resolved = resolveLongTaskContextSettings({ stored: { enabled: "yes" }, env: {} });
    expect(resolved.sources.enabled).toBe("default");
    expect(resolved.sources.historyChars).toBe("default");
  });
});

describe("planLongTaskContextReset", () => {
  it("resets once the last prompt crosses the threshold", () => {
    const plan = planLongTaskContextReset({
      settings: settings(),
      promptTotal: 270_000,
      windowTokens: 378_739,
      lastRunId: "run-a",
    });
    expect(plan.reset).toBe(true);
    expect(plan.pct).toBe(71.3);
    expect(plan.lastRunId).toBe("run-a");
    expect(plan.reason).toContain("71.3% of the 378739-token");
  });

  it("leaves a session below the threshold alone", () => {
    const plan = planLongTaskContextReset({
      settings: settings(),
      promptTotal: 100_000,
      windowTokens: 378_739,
    });
    expect(plan.reset).toBe(false);
    expect(plan.reason).toBeNull();
  });

  it("resets exactly at the threshold", () => {
    const plan = planLongTaskContextReset({
      settings: settings(),
      promptTotal: 70,
      windowTokens: 100,
    });
    expect(plan.reset).toBe(true);
  });

  it("never resets a task without a measured prompt", () => {
    const plan = planLongTaskContextReset({
      settings: settings(),
      promptTotal: null,
      windowTokens: 100,
    });
    expect(plan.reset).toBe(false);
    expect(plan.pct).toBe(0);
  });

  it("reports but never resets when the guard is switched off", () => {
    const plan = planLongTaskContextReset({
      settings: settings({ enabled: false }),
      promptTotal: 100_000,
      windowTokens: 100_000,
    });
    expect(plan.reset).toBe(false);
  });

  it("refuses to reset on an unusable window", () => {
    expect(
      shouldResetTaskSessionForLongTaskContext({
        settings: settings(),
        promptTotal: 1_000,
        windowTokens: 0,
      }),
    ).toBe(false);
  });

  it("computes the share of the window defensively", () => {
    expect(longTaskContextPct(70, 100)).toBe(70);
    expect(longTaskContextPct(1, 3)).toBe(33.3);
    expect(longTaskContextPct(0, 100)).toBe(0);
    expect(longTaskContextPct(10, 0)).toBe(0);
    expect(longTaskContextPct(Number.NaN, 100)).toBe(0);
  });
});

describe("buildLongTaskContextResetNotice", () => {
  it("names the measurement, the threshold and where the older thread stays", () => {
    const plan = planLongTaskContextReset({
      settings: settings(),
      promptTotal: 270_000,
      windowTokens: 378_739,
    });
    const notice = buildLongTaskContextResetNotice({
      plan,
      settings: settings(),
      issueId: "issue-a",
    });
    expect(notice).toContain("FRESH task session");
    expect(notice).toContain("270000 tokens");
    expect(notice).toContain("threshold 70%");
    expect(notice).toContain("Context compression timed out");
    expect(notice).toContain("GET /api/issues/issue-a/comments (oldest first)");
  });
});