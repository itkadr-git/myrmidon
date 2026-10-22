// @vitest-environment jsdom
// myrmidon(1.6.3 PROMPT-BUDGET B): the prompt-budget badge on an agent card —
// view tier, no network. Checked: the share text; warn and crit get their
// tones and the marker; an ok entry renders plainly; a missing entry renders
// nothing at all.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentPromptBudgetBadge } from "./AgentPromptBudgetBadge";
import type { PromptBudgetStatusEntry } from "./prompt-budget/promptBudgetApi";

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
  act(() => root.unmount());
  container.remove();
});

const SETTINGS = {
  warnPct: 70,
  critPct: 90,
  enabled: true,
  fallbackWindowTokens: 200_000,
  optimizerAgentId: null,
};

function entry(overrides: Partial<PromptBudgetStatusEntry> = {}): PromptBudgetStatusEntry {
  return {
    agentId: "agent-1",
    model: "neutral-model",
    windowTokens: 1000,
    windowIsFallback: false,
    lastRun: { runId: "r1", total: 500, parts: {}, pct: 50, level: "ok" },
    settings: SETTINGS,
    ...overrides,
  };
}

function badge(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-testid^=agent-prompt-budget-badge-]");
}

describe("myrmidon(1.6.3 PROMPT-BUDGET B) AgentPromptBudgetBadge", () => {
  it("renders the last run's share of the window", () => {
    act(() => root.render(<AgentPromptBudgetBadge entry={entry()} />));
    expect(badge()?.textContent).toBe("50%");
    expect(badge()?.dataset.level).toBe("ok");
  });

  it("a warn entry gets the warn level marker", () => {
    act(() =>
      root.render(
        <AgentPromptBudgetBadge
          entry={entry({ lastRun: { runId: "r1", total: 800, parts: {}, pct: 80, level: "warn" } })}
        />,
      ),
    );
    expect(badge()?.dataset.level).toBe("warn");
    expect(badge()?.textContent).toBe("80%");
  });

  it("a crit entry gets the crit level marker", () => {
    act(() =>
      root.render(
        <AgentPromptBudgetBadge
          entry={entry({ lastRun: { runId: "r1", total: 950, parts: {}, pct: 95, level: "crit" } })}
        />,
      ),
    );
    expect(badge()?.dataset.level).toBe("crit");
  });

  it("the tooltip carries the breakdown of the last run", () => {
    act(() =>
      root.render(
        <AgentPromptBudgetBadge
          entry={entry({
            lastRun: {
              runId: "r1",
              total: 950,
              parts: { instructions: 400, wake: 300 },
              pct: 95,
              level: "crit",
            },
          })}
        />,
      ),
    );
    expect(badge()?.title).toContain("950/1000");
    expect(badge()?.title).toContain("instructions 400");
  });

  it("a missing entry or a missing last run renders nothing", () => {
    act(() => root.render(<AgentPromptBudgetBadge entry={undefined} />));
    expect(badge()).toBeNull();
    act(() => root.render(<AgentPromptBudgetBadge entry={entry({ lastRun: null })} />));
    expect(badge()).toBeNull();
  });
});
