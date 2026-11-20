// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KnowledgeReview } from "./KnowledgeReview";

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/api/client", () => ({ api: http }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ i18n: { language: "en" } }) }));

const url = "/myrmidon/companies/c1/knowledge/suggestions?status=pending";
let host: HTMLDivElement;
let root: Root;

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  http.get.mockReset();
  http.post.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("shows loading, then recovers from a load error on retry", async () => {
  let rejectFirst: (reason: Error) => void = () => { throw new Error("GET did not start"); };
  const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
  http.get.mockReturnValueOnce(first).mockResolvedValueOnce({ suggestions: [
    { id: "s1", body: "First proposal", targetItemId: "i1", rationale: "First reason" },
    { id: "s2", body: "Second proposal", targetItemId: null, rationale: null },
  ] });

  await render();
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading suggestions...");
  expect(host.textContent).not.toContain("No pending suggestions");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(http.get.mock.calls).toEqual([[url]]);

  await act(async () => { rejectFirst(new Error("Network failure")); });
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load suggestions");
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.textContent).not.toContain("No pending suggestions");
  const retry = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Retry");
  expect(retry).toBeDefined();
  await act(async () => { retry?.click(); });
  await settle();

  expect(http.get.mock.calls).toEqual([[url], [url]]);
  expect(host.textContent).toContain("First proposal");
  expect(host.textContent).toContain("Second proposal");
  expect(host.querySelectorAll('section[aria-label="Knowledge suggestion"]')).toHaveLength(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).not.toContain("No pending suggestions");
  expect(http.post).not.toHaveBeenCalled();
});

it("shows an empty queue only after a successful empty response", async () => {
  http.get.mockResolvedValueOnce({ suggestions: [] });
  await render();
  await settle();
  expect(host.textContent).toContain("No pending suggestions");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.querySelector('section[aria-label="Knowledge suggestion"]')).toBeNull();
  expect(http.get.mock.calls).toEqual([[url]]);
  expect(http.post).not.toHaveBeenCalled();
});
