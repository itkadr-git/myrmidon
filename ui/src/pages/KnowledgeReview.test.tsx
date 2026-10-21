// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeReview } from "./KnowledgeReview";

const companyState = vi.hoisted(() => ({ selectedCompanyId: "company-1" }));
const toastState = vi.hoisted(() => ({ pushToast: vi.fn() }));
const knowledgeApiMock = vi.hoisted(() => ({
  listSuggestions: vi.fn(),
  editSuggestion: vi.fn(),
  decideSuggestion: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({ useCompany: () => companyState }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => toastState }));
vi.mock("../api/knowledge", () => ({ knowledgeApi: knowledgeApiMock }));

const suggestion = {
  id: "suggestion-1",
  targetItemId: "item-1",
  body: "Add the deployment checklist.",
  rationale: "Observed in the release run.",
  sourceKind: "run",
  sourceRef: "run-9",
  status: "pending" as const,
  createdAt: "2026-10-21T00:00:00.000Z",
};

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForAssertion(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

describe("KnowledgeReview", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    knowledgeApiMock.listSuggestions.mockReset().mockResolvedValue([suggestion]);
    knowledgeApiMock.editSuggestion.mockReset().mockResolvedValue({ suggestion });
    knowledgeApiMock.decideSuggestion.mockReset().mockResolvedValue({ suggestion });
    toastState.pushToast.mockReset();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    flushSync(() => root.render(
      <QueryClientProvider client={queryClient}>
        <KnowledgeReview />
      </QueryClientProvider>,
    ));
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it("renders the review queue with recommendation and all actions", async () => {
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Add the deployment checklist.");
      expect(container.textContent).toContain("Recommendation:");
      expect(container.textContent).toContain("Observed in the release run.");
      expect(container.textContent).toContain("Accept");
      expect(container.textContent).toContain("Edit");
      expect(container.textContent).toContain("Reject");
    });
    expect(knowledgeApiMock.listSuggestions).toHaveBeenCalledWith("company-1");
  });
});
