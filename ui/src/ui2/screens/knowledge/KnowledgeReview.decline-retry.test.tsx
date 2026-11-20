// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KnowledgeReview } from "./KnowledgeReview";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), company: "c1" }));
vi.mock("@/api/client", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: mocks.company }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ i18n: { language: "en" } }) }));

const rows = [
  { id: "s1", body: "First suggestion", targetItemId: "i1", rationale: null },
  { id: "s2", body: "Second suggestion", targetItemId: "i2", rationale: null },
];
const pendingKey = ["knowledge", "suggestions", "c1", "pending"];
const itemKey = ["knowledge", "items", "c1"];
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function clickFirst(label: string) {
  const section = Array.from(host.querySelectorAll("section")).find((node) => node.textContent?.includes("First suggestion"));
  const button = Array.from(section?.querySelectorAll("button") ?? []).find((node) => node.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await settle();
}
async function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(itemKey, ["c1 item"]);
  client.setQueryData(["knowledge", "items", "c2"], ["c2 item"]);
  client.setQueryData(["knowledge", "suggestions", "c2", "pending"], { suggestions: [] });
  await act(async () => root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>));
  await settle();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.company = "c1";
  mocks.get.mockReset().mockResolvedValue({ suggestions: rows });
  mocks.post.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); client.clear(); });

it.each([["Reject", "decline"], ["Accept", "accept"]])("keeps both rows after rejection fails, then %s uses only its decision endpoint", async (label, action) => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  mocks.post.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await render();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await clickFirst("Reject");
  expect(mocks.post.mock.calls).toEqual([["/myrmidon/companies/c1/knowledge/suggestions/s1/decline", {}]]);
  await act(async () => first.reject(new Error("Decision failed")));
  await settle();
  expect(host.textContent).toContain("First suggestion");
  expect(host.textContent).toContain("Second suggestion");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not complete the action");
  expect(host.textContent).not.toContain("Decision failed");
  expect(invalidate).not.toHaveBeenCalled();
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(mocks.post).toHaveBeenCalledTimes(1);

  await clickFirst(label);
  expect(mocks.post.mock.calls).toEqual([
    ["/myrmidon/companies/c1/knowledge/suggestions/s1/decline", {}],
    [`/myrmidon/companies/c1/knowledge/suggestions/s1/${action}`, {}],
  ]);
  mocks.get.mockResolvedValue({ suggestions: [rows[1]] });
  await act(async () => second.resolve({ suggestion: { id: "s1" } }));
  await settle();
  expect(host.textContent).not.toContain("First suggestion");
  expect(host.textContent).toContain("Second suggestion");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([{ queryKey: pendingKey }, { queryKey: itemKey }]);
  expect(client.getQueryState(["knowledge", "items", "c2"])?.isInvalidated).toBe(false);
  expect(client.getQueryState(["knowledge", "suggestions", "c2", "pending"])?.isInvalidated).toBe(false);
  expect(mocks.post).toHaveBeenCalledTimes(2);
  expect(mocks.get.mock.calls).toEqual([
    ["/myrmidon/companies/c1/knowledge/suggestions?status=pending"],
    ["/myrmidon/companies/c1/knowledge/suggestions?status=pending"],
  ]);
});
