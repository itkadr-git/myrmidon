// @vitest-environment jsdom
// myrmidon(1.6.3 PROMPT-BUDGET B): the prompt-budget status section of an
// agent card — view tier with a stubbed API. Checked: the level chip, the
// share and totals line, the top-parts list, the fallback-window note, the
// "no breakdown" line and the empty state.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptBudgetStatusEntry } from "./prompt-budget/promptBudgetApi";

vi.mock("./prompt-budget/promptBudgetApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("./prompt-budget/promptBudgetApi")>();
  return {
    ...original,
    promptBudgetApi: {
      ...original.promptBudgetApi,
      getStatus: vi.fn(),
    },
  };
});

import { promptBudgetApi } from "./prompt-budget/promptBudgetApi";
import { PromptBudgetStatusSection } from "./PromptBudgetStatusSection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
    lastRun: { runId: "r1", total: 950, parts: { instructions: 400, wake: 300 }, pct: 95, level: "crit" },
    settings: SETTINGS,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderSection(entries: PromptBudgetStatusEntry[]) {
  vi.mocked(promptBudgetApi.getStatus).mockResolvedValue({ agents: entries });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PromptBudgetStatusSection companyId="company-1" agentId="agent-1" />
      </QueryClientProvider>,
    );
  });
  // Let the query settle: flush microtasks until the mock's promise resolved
  // and react-query delivered the data to the component.
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (container.querySelector("[data-testid=prompt-budget-status-section]") !== null) break;
    if (entries.length === 0 && vi.mocked(promptBudgetApi.getStatus).mock.calls.length > 0) break;
  }
}

describe("myrmidon(1.6.3 PROMPT-BUDGET B) PromptBudgetStatusSection", () => {
  it("renders the level chip, the share and the top parts", async () => {
    await renderSection([entry()]);
    const section = container.querySelector("[data-testid=prompt-budget-status-section]");
    expect(section).not.toBeNull();
    expect(container.querySelector("[data-testid=prompt-budget-level]")?.textContent).toBe(
      "Crit threshold crossed",
    );
    expect(section!.textContent).toContain("95%");
    expect(section!.textContent).toContain("950 / 1000");
    const parts = container.querySelector("[data-testid=prompt-budget-parts]");
    expect(parts?.textContent).toContain("instructions — 400 tokens");
    expect(parts?.textContent).toContain("wake — 300 tokens");
  });

  it("notes the fallback window when the model window is unknown", async () => {
    await renderSection([entry({ windowIsFallback: true, windowTokens: 200_000 })]);
    expect(container.textContent).toContain("fallback window");
  });

  it("a run without parts shows the no-breakdown line", async () => {
    await renderSection([entry({ lastRun: { runId: "r1", total: 950, parts: {}, pct: 95, level: "crit" } })]);
    expect(container.textContent).toContain("No per-part breakdown recorded");
  });

  it("an agent without a usable run shows the empty state", async () => {
    await renderSection([entry({ lastRun: null })]);
    expect(container.textContent).toContain("No run with a recorded prompt size yet");
  });

  it("an agent missing from the status renders nothing", async () => {
    await renderSection([]);
    expect(container.querySelector("[data-testid=prompt-budget-status-section]")).toBeNull();
  });
});
