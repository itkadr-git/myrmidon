// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KnowledgeReview } from "./KnowledgeReview";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), company: "c1" as string | null }));
vi.mock("@/api/client", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: mocks.company }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ i18n: { language: "en" } }) }));

const key = (company: string) => ["knowledge", "suggestions", company, "pending"];
const url = (company: string) => `/myrmidon/companies/${company}/knowledge/suggestions?status=pending`;
const oldData = { suggestions: [{ id: "old", body: "Old company suggestion", targetItemId: null, rationale: null }] };
const newData = { suggestions: [{ id: "new", body: "New company suggestion", targetItemId: null, rationale: null }] };
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let resolveOld: (value: typeof oldData) => void;
let rejectOld: (reason: Error) => void;

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function renderCompany(company: string | null) {
  mocks.company = company;
  await act(async () => root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>));
  await settle();
}
function expectCalls() {
  expect(mocks.get.mock.calls).toEqual([[url("c1")], [url("c2")]]);
  expect(mocks.post).not.toHaveBeenCalled();
  expect(client.getQueryCache().getAll().map((query) => query.queryKey)).toEqual([key("c1"), key("c2")]);
  expect(client.getQueryData(key("c2"))).toEqual(newData);
}
function expectNewQueue() {
  expect(host.textContent).toContain("New company suggestion");
  expect(host.textContent).not.toContain("Old company suggestion");
  expect(host.querySelectorAll('section[aria-label="Knowledge suggestion"]')).toHaveLength(1);
  expect(host.querySelector('[role="alert"]')).toBeNull();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.get.mockReset();
  mocks.post.mockReset();
  const oldRequest = new Promise<typeof oldData>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
  mocks.get.mockImplementation((request: string) => {
    if (request === url("c1")) return oldRequest;
    if (request === url("c2")) return Promise.resolve(newData);
    throw new Error(`Unexpected GET: ${request}`);
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); client.clear(); });

it("keeps the new company queue unchanged when the old read resolves late", async () => {
  await renderCompany("c1");
  await renderCompany("c2");
  expectNewQueue();
  const before = host.innerHTML;
  await act(async () => { resolveOld(oldData); });
  await settle();
  expectNewQueue();
  expect(host.innerHTML).toBe(before);
  expect(client.getQueryData(key("c1"))).toEqual(oldData);
  expectCalls();
});

it("does not show the old company read error after switching companies", async () => {
  await renderCompany("c1");
  await renderCompany("c2");
  expectNewQueue();
  const before = host.innerHTML;
  await act(async () => { rejectOld(new Error("Old company failed")); });
  await settle();
  expectNewQueue();
  expect(host.innerHTML).toBe(before);
  expect(client.getQueryState(key("c1"))?.status).toBe("error");
  expectCalls();
});

it("does not fetch without a company or revive the old queue across a null selection", async () => {
  await renderCompany("c1");
  await renderCompany(null);
  expect(host.textContent).toContain("Select a company");
  expect(mocks.get.mock.calls).toEqual([[url("c1")]]);
  await act(async () => { resolveOld(oldData); });
  await settle();
  expect(host.textContent).toContain("Select a company");
  expect(host.textContent).not.toContain("Old company suggestion");
  await renderCompany("c2");
  expectNewQueue();
  expect(client.getQueryData(key("c1"))).toEqual(oldData);
  expectCalls();
});
