// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KnowledgeReview } from "./KnowledgeReview";

const mocks = vi.hoisted(() => ({ company: "c1", get: vi.fn(), post: vi.fn() }));
vi.mock("@/api/client", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: mocks.company }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ i18n: { language: "en" } }) }));

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>));
  await settle();
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
  await settle();
}
async function edit(value: string) {
  const editor = host.querySelector("textarea");
  expect(editor).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, value);
    editor!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.company = "c1";
  mocks.get.mockReset().mockImplementation(async (url: string) => ({ suggestions: [{
    id: "shared-id", body: url.includes("/c1/") ? "Company one suggestion" : "Company two suggestion",
    targetItemId: url.includes("/c1/") ? "item-one" : "item-two", rationale: null,
  }] }));
  mocks.post.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { act(() => root.unmount()); host.remove(); client.clear(); });

it.each(["resolve", "reject"])("isolates a late %s decision after switching companies", async (outcome) => {
  let resolvePost!: (value: unknown) => void;
  let rejectPost!: (reason: Error) => void;
  const pending = new Promise((resolve, reject) => { resolvePost = resolve; rejectPost = reject; });
  mocks.post.mockResolvedValueOnce({}).mockReturnValueOnce(pending);

  await render();
  await click("Edit");
  await edit("Company one edited draft");
  await click("Save and accept");
  expect(mocks.post.mock.calls).toEqual([
    ["/myrmidon/companies/c1/knowledge/items/item-one/draft", { content: "Company one edited draft" }],
    ["/myrmidon/companies/c1/knowledge/suggestions/shared-id/accept", {}],
  ]);

  mocks.company = "c2";
  await render();
  expect(mocks.get).toHaveBeenCalledWith("/myrmidon/companies/c2/knowledge/suggestions?status=pending");
  expect(host.textContent).toContain("Company two suggestion");
  expect(host.textContent).not.toContain("Company one suggestion");
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await click("Edit");
  expect(host.querySelector("textarea")?.value).toBe("Company two suggestion");
  await edit("Company two unfinished draft");

  await act(async () => {
    if (outcome === "resolve") resolvePost({ suggestion: { id: "shared-id" } });
    else rejectPost(new Error("Company one decision failed"));
    await pending.catch(() => {});
  });
  await settle();
  expect(host.textContent).toContain("Company two suggestion");
  expect(host.textContent).not.toContain("Company one suggestion");
  expect(host.textContent).not.toContain("Company one decision failed");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector("textarea")?.value).toBe("Company two unfinished draft");
  expect(mocks.post.mock.calls).toEqual([
    ["/myrmidon/companies/c1/knowledge/items/item-one/draft", { content: "Company one edited draft" }],
    ["/myrmidon/companies/c1/knowledge/suggestions/shared-id/accept", {}],
  ]);
});
