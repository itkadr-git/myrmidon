// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2I18nProvider } from "../../i18n/Ui2I18n";
import { Ui2KnowledgeReview } from "./Ui2KnowledgeReview";

const http = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/client", () => ({ api: http }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c-1" }) }));

let container: HTMLDivElement;
let root: Root;
beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  http.get.mockReset();
  http.get.mockResolvedValue({ suggestions: [] });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><Ui2I18nProvider initialLocale="en"><Ui2KnowledgeReview /></Ui2I18nProvider></QueryClientProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("Ui2KnowledgeReview", () => {
  it("renders the empty state with no suggestion tiles", async () => {
    await render();
    expect(container.textContent).toContain("No suggestions to review.");
    expect(container.querySelectorAll(".ui2-section")).toHaveLength(0);
    expect(http.get).toHaveBeenCalledWith(expect.stringContaining("/knowledge/suggestions?status=pending"));
  });

  it("shows a classifier recommendation and rationale", async () => {
    http.get.mockResolvedValue({ suggestions: [{ id: "s1", body: "New fact", recommendation: "declined", rationale: "Supported by evidence", sourceRef: "run-1", sourceKind: "run", trust: "internal", status: "pending" }] });
    await render();
    expect(container.textContent).toContain("Recommendation: Reject");
    expect(container.textContent).toContain("Supported by evidence");
  });
});