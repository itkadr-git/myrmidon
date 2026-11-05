// @vitest-environment jsdom
// myrmidon(1.6.6 SETTINGS-UI S): test PromptBudgetSettingsPanel with optimizer agent picker
import { act } from \"react\";
import { createRoot } from \"react-dom/client\";
import { QueryClient, QueryClientProvider } from \"@tanstack/react-query\";
import { beforeEach, describe, expect, it, vi } from \"vitest\";
import { PromptBudgetSettingsPanel } from \"./PromptBudgetSettingsPanel\";
import { promptBudgetApi } from \"./prompt-budget/promptBudgetApi\";
import { agentsApi } from \"@/api/agents\";

vi.mock(\"@/context/CompanyContext\", () => ({
  useOptionalCompany: () => ({ selectedCompanyId: \"company-test\" }),
}));

const mockSettings = {
  warnPct: 80,
  critPct: 90,
  enabled: true,
  fallbackWindowTokens: 128000,
  optimizerAgentId: null,
};

const mockAgents = [
  { id: \"agent-1\", name: \"Optimizer Bot\" },
  { id: \"agent-2\", name: \"Helper Bot\" },
];

function renderPanel(): HTMLDivElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement(\"div\");
  document.body.appendChild(container);
  createRoot(container).render(
    <QueryClientProvider client={queryClient}>
      <PromptBudgetSettingsPanel />
    </QueryClientProvider>,
  );
  return container;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(\"waitFor timeout\");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe(\"PromptBudgetSettingsPanel\", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = \"\";
  });

  it(\"renders agent options in the optimizer picker and saves selected agent\", async () => {
    vi.spyOn(promptBudgetApi, \"getSettings\").mockResolvedValue(mockSettings);
    vi.spyOn(agentsApi, \"list\").mockResolvedValue(mockAgents as never);
    const putSpy = vi.spyOn(promptBudgetApi, \"putSettings\").mockResolvedValue({
      ...mockSettings,
      optimizerAgentId: \"agent-1\",
    });

    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid=\"prompt-budget-optimizer-input\"]')));

    const select = container.querySelector<HTMLSelectElement>('[data-testid=\"prompt-budget-optimizer-input\"]')!;
    expect(select.options.length).toBe(3); // None + 2 agents
    expect(select.options[1].value).toBe(\"agent-1\");
    expect(select.options[1].textContent).toContain(\"Optimizer Bot\");

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, \"value\")!.set!;
      setter.call(select, \"agent-1\");
      select.dispatchEvent(new Event(\"change\", { bubbles: true }));
    });

    const saveBtn = container.querySelector<HTMLButtonElement>('[data-testid=\"prompt-budget-save\"]')!;
    await act(async () => {
      saveBtn.click();
    });

    await waitFor(() => putSpy.mock.calls.length > 0);
    expect(putSpy).toHaveBeenCalledWith(\"company-test\", {
      warnPct: 80,
      critPct: 90,
      fallbackWindowTokens: 128000,
      optimizerAgentId: \"agent-1\",
    });
  });

  it(\"loads existing optimizerAgentId and allows clearing it to null\", async () => {
    vi.spyOn(promptBudgetApi, \"getSettings\").mockResolvedValue({
      ...mockSettings,
      optimizerAgentId: \"agent-2\",
    });
    vi.spyOn(agentsApi, \"list\").mockResolvedValue(mockAgents as never);
    const putSpy = vi.spyOn(promptBudgetApi, \"putSettings\").mockResolvedValue(mockSettings);

    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid=\"prompt-budget-optimizer-input\"]')));

    const select = container.querySelector<HTMLSelectElement>('[data-testid=\"prompt-budget-optimizer-input\"]')!;
    expect(select.value).toBe(\"agent-2\");

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, \"value\")!.set!;
      setter.call(select, \"\");
      select.dispatchEvent(new Event(\"change\", { bubbles: true }));
    });

    const saveBtn = container.querySelector<HTMLButtonElement>('[data-testid=\"prompt-budget-save\"]')!;
    await act(async () => {
      saveBtn.click();
    });

    await waitFor(() => putSpy.mock.calls.length > 0);
    expect(putSpy).toHaveBeenCalledWith(\"company-test\", {
      warnPct: 80,
      critPct: 90,
      fallbackWindowTokens: 128000,
      optimizerAgentId: null,
    });
  });
});
