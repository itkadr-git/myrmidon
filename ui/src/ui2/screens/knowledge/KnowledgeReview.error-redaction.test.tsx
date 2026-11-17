// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeReview } from "./KnowledgeReview";

const transport = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), language: "en" }));
vi.mock("@/api/client", () => ({ api: { get: transport.get, post: transport.post } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ i18n: { language: transport.language } }) }));

let host: HTMLDivElement;
let root: Root;
const suggestion = { id: "s1", body: "Proposed text", targetItemId: "i1", rationale: "" };
const endpoint = "/myrmidon/companies/c1/knowledge/suggestions/s1/accept";

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  transport.get.mockReset();
  transport.post.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe.each([
  ["en", "Accept", "Could not complete the action"],
  ["ru", "Принять", "Не удалось выполнить действие"],
  ["ru-RU", "Принять", "Не удалось выполнить действие"],
])("decision error in %s", (language, accept, message) => {
  it("redacts the server error and allows the decision to be retried", async () => {
    transport.language = language;
    let rows = [suggestion];
    transport.get.mockImplementation(async () => ({ suggestions: rows }));
    let rejectDecision!: (reason: Error) => void;
    transport.post.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectDecision = reject; }));
    transport.post.mockImplementationOnce(async () => { rows = []; return { suggestion }; });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>));
    await settle();
    expect(host.textContent).toContain("Proposed text");
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent === accept);
    expect(button).toBeDefined();
    await act(async () => { button?.click(); });
    const error = new Error("SECRET_TEST_ONLY https://internal.invalid/private stack: internalFunction");
    error.stack = "SECRET_TEST_ONLY https://internal.invalid/private stack: internalFunction";
    await act(async () => { rejectDecision(error); });
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(host.textContent).toContain("Proposed text");
    expect(host.textContent).not.toContain("SECRET_TEST_ONLY");
    expect(host.textContent).not.toContain("https://internal.invalid/private");
    expect(host.textContent).not.toContain("internalFunction");
    expect(button?.disabled).toBe(false);
    expect(transport.post.mock.calls).toEqual([[endpoint, {}]]);
    await act(async () => { button?.click(); });
    await settle();
    expect(transport.post.mock.calls).toEqual([[endpoint, {}], [endpoint, {}]]);
    expect(host.textContent).not.toContain("Proposed text");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
