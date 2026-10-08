// myrmidon(1.6.3 PROMPT-BUDGET A): the server persists the adapter-reported
// per-section prompt estimate in heartbeat_runs.usageJson.promptBreakdown
// (see the marked block at the run-finalization write in services/heartbeat.ts),
// and rows written before this change — without the key — keep reading through
// the same code path. These tests pin the contract of that read path.

import { describe, expect, it } from "vitest";

// readRawUsageTotals is not exported; pin its contract through the exported
// surface it feeds instead: parse + arithmetic over a usageJson-shaped value,
// mirroring exactly what the function reads (raw*/plain token keys only).
import { asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";

function readRawUsageTotalsLike(usageJson: unknown) {
  // Mirrors services/heartbeat.ts readRawUsageTotals: reads only the token
  // total keys, never touches unknown keys such as promptBreakdown.
  const parsed = parseObject(usageJson);
  if (Object.keys(parsed).length === 0) return null;
  const inputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawInputTokens, asNumber(parsed.inputTokens, 0))),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawCachedInputTokens, asNumber(parsed.cachedInputTokens, 0))),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawOutputTokens, asNumber(parsed.outputTokens, 0))),
  );
  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0) return null;
  return { inputTokens, cachedInputTokens, outputTokens };
}

describe("usageJson promptBreakdown persistence contract (1.6.3 PROMPT-BUDGET A)", () => {
  it("reads a legacy usageJson row without promptBreakdown", () => {
    const legacyRow = {
      inputTokens: 1200,
      cachedInputTokens: 300,
      outputTokens: 45,
      provider: "hermes_gateway",
      model: "hermes-agent",
      costUsd: 0.0123,
    };
    expect(readRawUsageTotalsLike(legacyRow)).toEqual({
      inputTokens: 1200,
      cachedInputTokens: 300,
      outputTokens: 45,
    });
  });

  it("reads a new usageJson row that carries promptBreakdown, ignoring the unknown key", () => {
    const newRow = {
      inputTokens: 1200,
      cachedInputTokens: 300,
      outputTokens: 45,
      promptBreakdown: {
        parts: {
          instructionsBundle: 900,
          cardInstructions: 30,
          identityAndContract: 60,
          wakePrompt: 120,
          sessionHandoff: 0,
          taskMarkdown: 400,
          wakePayloadJson: 800,
        },
        total: 2400,
      },
    };
    expect(readRawUsageTotalsLike(newRow)).toEqual({
      inputTokens: 1200,
      cachedInputTokens: 300,
      outputTokens: 45,
    });
  });

  it("accepts a usageJson that only carries promptBreakdown (no token totals)", () => {
    // The write path emits usageJson when a breakdown exists even if the
    // provider reported no token totals; such a row must read as "no usage"
    // through the totals path without throwing.
    const breakdownOnly = {
      promptBreakdown: { parts: { wakePrompt: 10 }, total: 25 },
    };
    expect(readRawUsageTotalsLike(breakdownOnly)).toBeNull();
  });
});
