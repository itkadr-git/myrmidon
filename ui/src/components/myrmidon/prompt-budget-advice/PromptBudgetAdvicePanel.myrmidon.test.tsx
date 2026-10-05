// @vitest-environment jsdom
//
// myrmidon(1.6.3 PROMPT-BUDGET C): the advice block of the agent card — the
// breakdown, the recommendations, the healthy and no-run states, and the
// deep-analysis button with the link to the task it filed. The view is pure, so
// no router and no network are involved.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptBudgetAdvice, PromptBudgetDeepTask } from "./promptBudgetAdviceApi";
import { PromptBudgetAdviceView } from "./PromptBudgetAdvicePanel";
import { deepTaskHref, formatSharePct, formatTokensShort } from "./promptBudgetAdviceConfig";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

const BLOATED: PromptBudgetAdvice = {
  agentId: "11111111-1111-4111-8111-111111111111",
  agentName: "agent-a",
  model: "model-a",
  hasRun: true,
  runId: "44444444-4444-4444-8444-444444444444",
  total: 20_000,
  parts: [
    { part: "sessionHistory", tokens: 9_000, sharePct: 45 },
    { part: "instructionsBundle", tokens: 6_000, sharePct: 30 },
    { part: "wakePayload", tokens: 3_000, sharePct: 15 },
  ],
  healthy: false,
  recommendations: [
    {
      ruleId: "session-history",
      part: "sessionHistory",
      tokens: 9_000,
      sharePct: 45,
      severity: "warn",
      title: "Session history and handoff",
      action: "Use a run-scoped session strategy instead of an issue-scoped one.",
    },
    {
      ruleId: "instructions",
      part: "instructionsBundle",
      tokens: 6_000,
      sharePct: 30,
      severity: "crit",
      title: "Instructions bundle",
      action: "Move reference material out of the always-on instructions bundle into skills.",
    },
  ],
};

function render(input: {
  advice?: PromptBudgetAdvice | null;
  onDeep?: () => void;
  deepPending?: boolean;
  deepTask?: PromptBudgetDeepTask | null;
  error?: string | null;
}) {
  flushSync(() => {
    root.render(
      <PromptBudgetAdviceView
        advice={input.advice}
        onDeep={input.onDeep ?? vi.fn()}
        deepPending={input.deepPending ?? false}
        deepTask={input.deepTask ?? null}
        error={input.error ?? null}
      />,
    );
  });
}

function deepButton(): HTMLButtonElement {
  return container.querySelector("[data-testid='prompt-budget-advice-deep']")!;
}

describe("PromptBudgetAdviceView", () => {
  it("names each bloated part with its share and action", () => {
    render({ advice: BLOATED });
    const items = container.querySelectorAll("[data-testid='prompt-budget-advice-list'] li");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Session history and handoff");
    expect(items[0]!.textContent).toContain("sessionHistory");
    expect(items[0]!.textContent).toContain("45%");
    expect(items[0]!.textContent).toContain("run-scoped session strategy");
    expect(items[0]!.getAttribute("data-severity")).toBe("warn");
    expect(items[1]!.getAttribute("data-severity")).toBe("crit");
    // The whole breakdown is shown, biggest first, including the part under the threshold.
    const parts = container.querySelectorAll("[data-testid='prompt-budget-advice-parts'] li");
    expect(parts).toHaveLength(3);
    expect(parts[0]!.textContent).toContain("sessionHistory");
  });

  it("says the prompt is fine when nothing crosses the threshold", () => {
    render({ advice: { ...BLOATED, healthy: true, recommendations: [] } });
    expect(container.querySelector("[data-testid='prompt-budget-advice-healthy']")).toBeTruthy();
    expect(container.querySelector("[data-testid='prompt-budget-advice-list']")).toBeNull();
    expect(deepButton().disabled).toBe(false);
  });

  it("reports a missing breakdown and disables the deep button", () => {
    render({ advice: { ...BLOATED, hasRun: false, runId: null, total: 0, parts: [], recommendations: [] } });
    expect(container.querySelector("[data-testid='prompt-budget-advice-no-run']")).toBeTruthy();
    expect(deepButton().disabled).toBe(true);
  });

  it("calls the deep handler and shows the pending label", () => {
    const onDeep = vi.fn();
    render({ advice: BLOATED, onDeep });
    flushSync(() => deepButton().click());
    expect(onDeep).toHaveBeenCalledTimes(1);

    render({ advice: BLOATED, onDeep, deepPending: true });
    expect(deepButton().disabled).toBe(true);
    expect(deepButton().textContent).toContain("Filing the task");
  });

  it("links to the filed task and shows the error line", () => {
    render({
      advice: BLOATED,
      deepTask: {
        issueId: "55555555-5555-4555-8555-555555555555",
        identifier: "OPA-1",
        title: "Prompt budget deep analysis: agent-a",
      },
    });
    const link = container.querySelector("[data-testid='prompt-budget-advice-deep-task'] a")!;
    expect(link.textContent).toBe("OPA-1");
    expect(link.getAttribute("href")).toBe(deepTaskHref("OPA-1"));

    render({ advice: BLOATED, error: "Filing the deep analysis task failed." });
    expect(container.textContent).toContain("Filing the deep analysis task failed.");
  });

  it("shows the task id when the filed task has no identifier yet", () => {
    render({
      advice: BLOATED,
      deepTask: {
        issueId: "55555555-5555-4555-8555-555555555555",
        identifier: null,
        title: "Prompt budget deep analysis: agent-a",
      },
    });
    const line = container.querySelector("[data-testid='prompt-budget-advice-deep-task']")!;
    expect(line.querySelector("a")).toBeNull();
    expect(line.textContent).toContain("55555555-5555-4555-8555-555555555555");
  });

  it("shows a loading line before the first answer", () => {
    render({ advice: null });
    expect(container.textContent).toContain("Loading the prompt breakdown");
  });
});

describe("promptBudgetAdviceConfig", () => {
  it("formats shares and token counts for the panel", () => {
    expect(formatSharePct(45)).toBe("45%");
    expect(formatSharePct(45.5)).toBe("45.5%");
    expect(formatSharePct(Number.NaN)).toBe("0%");
    expect(formatTokensShort(950)).toBe("950");
    expect(formatTokensShort(9_000)).toBe("9k");
    expect(formatTokensShort(0)).toBe("0");
  });
});