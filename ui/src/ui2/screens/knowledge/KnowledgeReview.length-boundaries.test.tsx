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

let host: HTMLDivElement;
let root: Root;
let targetItemId: string | null;
const items = "/myrmidon/companies/c1/knowledge/items";
const accept = "/myrmidon/companies/c1/knowledge/suggestions/s1/accept";

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
function button(label: string) {
  const result = Array.from(host.querySelectorAll("button")).find((element) => element.textContent === label);
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}
function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const result = Array.from(host.querySelectorAll("label")).find((element) => element.firstChild?.textContent === label)?.querySelector("input, textarea");
  if (!result) throw new Error(`Missing field ${label}`);
  return result as HTMLInputElement | HTMLTextAreaElement;
}
async function change(label: string, value: string) {
  const element = field(label);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function renderEditor() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>));
  await settle();
  await act(async () => button("Edit").click());
}
async function submit() {
  await act(async () => button("Save and accept").click());
  await settle();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  targetItemId = null;
  http.get.mockReset().mockImplementation(async () => ({ suggestions: [{ id: "s1", body: "Proposed text", targetItemId, rationale: null }] }));
  http.post.mockReset().mockResolvedValue({});
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("exposes the limits and submits all fields at their exact boundaries", async () => {
  await renderEditor();
  expect(field("Title").maxLength).toBe(300);
  expect(field("Page slug").maxLength).toBe(200);
  expect(field("Content").maxLength).toBe(500000);
  const title = "t".repeat(300), slug = "s".repeat(200), content = "c".repeat(500000);
  await change("Title", title);
  await change("Page slug", slug);
  await change("Content", content);
  expect(host.querySelector("form")?.checkValidity()).toBe(true);
  await submit();
  expect(http.post.mock.calls).toEqual([[items, { title, slug, content }], [accept, {}]]);
});

it.each([["Title", 300], ["Page slug", 200], ["Content", 500000]] as const)("blocks an overlong %s before any API call", async (label, limit) => {
  await renderEditor();
  await change("Title", "Title");
  await change("Page slug", "slug");
  await change(label, "x".repeat(limit + 1));
  expect(field(label).value).toHaveLength(limit + 1);
  // jsdom does not apply tooLong to programmatically populated values.
  expect(field(label).maxLength).toBe(limit);
  await submit();
  expect(http.post).not.toHaveBeenCalled();
  // A submit event can also bypass native constraint validation.
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await settle();
  expect(http.post).not.toHaveBeenCalled();
});

it("submits an existing target without title or slug", async () => {
  targetItemId = "existing";
  await renderEditor();
  expect(host.querySelectorAll("input")).toHaveLength(0);
  await change("Content", "c".repeat(500000));
  await submit();
  expect(http.post.mock.calls).toEqual([
    [`${items}/existing/draft`, { content: "c".repeat(500000) }],
    [accept, {}],
  ]);
});
