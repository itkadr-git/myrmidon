// The contract suite against the reference fake adapter (OPE-7004).
//
// This file proves the suite itself: every test of
// `runChannelConnectorContractTests` passes against the reference fake
// adapter of `./fake-adapter.ts`, including the retry/backoff and timeout
// paths that a real adapter drives through its own diagnostics. OPE-6960
// plugs the same suite into the real Telegram connector with one line:
//
//   runChannelConnectorContractTests("telegram", () => telegramConnector(), knobs);

import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeChannelAdapter } from "./fake-adapter.js";
import { makeContractTestHarness, runChannelConnectorContractTests } from "./contract-test-suite.js";

const fake = createFakeChannelAdapter();

runChannelConnectorContractTests("telegram", () => fake.connector, {
  failNextSends: (count) => fake.failNextSends(count),
  sendAttempts: () => fake.attempts,
  reset: () => fake.reset(),
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fake adapter timeouts (contract: a send must not outlive its timeout)", () => {
  it("a send slower than the adapter timeout fails instead of hanging", async () => {
    vi.useFakeTimers();
    const slow = createFakeChannelAdapter({ sendDelayMs: 60_000, sendTimeoutMs: 1_000 });
    const { ctx, publication, transport } = makeContractTestHarness();
    const plan = await slow.connector.outbound.plan(publication, ctx);
    const sending = slow.connector.outbound.send(plan, transport, ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await sending;
    expect(result.delivered).toBe(false);
    expect(result.failedPartIndex).not.toBeNull();
  });

  it("a send within the timeout still delivers", async () => {
    vi.useFakeTimers();
    const fast = createFakeChannelAdapter({ sendDelayMs: 500, sendTimeoutMs: 5_000 });
    const { ctx, publication, transport } = makeContractTestHarness();
    const plan = await fast.connector.outbound.plan(publication, ctx);
    const sending = fast.connector.outbound.send(plan, transport, ctx);
    await vi.advanceTimersByTimeAsync(500);
    const result = await sending;
    expect(result.delivered).toBe(true);
    expect(result.externalMessageIds.length).toBeGreaterThan(0);
  });
});
