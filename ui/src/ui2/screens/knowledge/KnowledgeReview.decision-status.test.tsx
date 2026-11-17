// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeReview } from "./KnowledgeReview";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), language: "en" }));
vi.mock("@/api/client", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ i18n: { language: mocks.language } }) }));

const suggestion = { id: "s1", body: "Proposed text", targetItemId: "i1", rationale: "" };
const listUrl = "/myrmidon/companies/c1/knowledge/suggestions?status=pending";
let host: HTMLDivElement;
let root: Root;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.get.mockReset(); mocks.post.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe.each([
  ["en", "Loading suggestions...", "Accept", "Reject"],
  ["ru", "Загрузка предложений...", "Принять", "Отклонить"],
  ["ru-RU", "Загрузка предложений...", "Принять", "Отклонить"],
] as const)("decision status in %s", (language, loading, accept, decline) => {
  it.each([["accept", "resolve"], ["decline", "resolve"], ["accept", "reject"], ["decline", "reject"]] as const)("announces %s until %s", async (action, outcome) => {
    mocks.language = language;
    const list = deferred<{ suggestions: typeof suggestion[] }>();
    const decision = deferred<{ suggestion: { id: string } }>();
    mocks.get.mockReturnValueOnce(list.promise).mockResolvedValue({ suggestions: [] });
    mocks.post.mockReturnValue(decision.promise);
    await act(async () => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><KnowledgeReview /></QueryClientProvider>));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(loading);
    expect(host.querySelector('main')?.getAttribute('aria-busy')).not.toBe('true');
    expect(mocks.get).toHaveBeenCalledWith(listUrl);
    expect(mocks.post).not.toHaveBeenCalled();
    await act(async () => { list.resolve({ suggestions: [suggestion] }); });
    await settle();
    expect(host.textContent).toContain("Proposed text");
    expect(host.querySelector('[role="status"]')).toBeNull();
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent === (action === "accept" ? accept : decline));
    expect(button).toBeDefined();
    await act(async () => { button?.click(); });
    await settle();
    expect(mocks.post.mock.calls).toEqual([[`/myrmidon/companies/c1/knowledge/suggestions/s1/${action}`, {}]]);
    expect(host.querySelector('main')?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('[role="status"]')?.textContent).not.toBe(loading);
    expect(host.textContent).toContain("Proposed text");
    await act(async () => {
      if (outcome === "resolve") decision.resolve({ suggestion: { id: "s1" } });
      else decision.reject(new Error("Forbidden"));
    });
    await settle();
    expect(host.querySelector('main')?.getAttribute('aria-busy')).not.toBe('true');
    if (outcome === "reject") {
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Forbidden");
      expect(host.textContent).toContain("Proposed text");
    } else {
      expect(host.textContent).not.toContain("Proposed text");
      expect(host.querySelector('[role="alert"]')).toBeNull();
    }
  });
});
