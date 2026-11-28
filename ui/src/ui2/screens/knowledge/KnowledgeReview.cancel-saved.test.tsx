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
let pending: Array<{ id: string; body: string; targetItemId: string | null; rationale: string }>;

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><KnowledgeReview /></QueryClientProvider>));
  await settle();
}

async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find((candidate) => candidate.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  pending = [{ id: "s1", body: "Proposed text", targetItemId: "i1", rationale: "A useful change" }];
  http.get.mockReset().mockImplementation(async () => ({ suggestions: pending }));
  http.post.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith("/accept")) throw new Error("Forbidden");
    return { suggestion: { id: "s1" } };
  });
});

afterEach(() => { act(() => root.unmount()); host.remove(); });

it("keeps a saved draft after a failed accept and cancel, without creating a duplicate draft", async () => {
  await render();
  await click("Edit");
  const editor = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Edited text");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Save and accept");
  expect(http.post).toHaveBeenCalledTimes(2);
  expect(http.post.mock.calls[0]).toEqual(["/myrmidon/companies/c1/knowledge/items/i1/draft", { content: "Edited text" }]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not complete the action");
  expect(host.textContent).not.toContain("Forbidden");

  await click("Cancel");
  await click("Edit");
  expect(host.querySelector("textarea")?.value).toBe("Edited text");
  await click("Save and accept");
  expect(http.post).toHaveBeenCalledTimes(3);
  expect(http.post.mock.calls[1]).toEqual(["/myrmidon/companies/c1/knowledge/suggestions/s1/accept", {}]);
  expect(http.post.mock.calls[2]).toEqual(["/myrmidon/companies/c1/knowledge/suggestions/s1/accept", {}]);
  expect(http.post.mock.calls.filter(([url]) => url.endsWith("/draft"))).toHaveLength(1);
});

it("cancels an untouched edit without writing a draft", async () => {
  await render();
  await click("Edit");
  await click("Cancel");
  expect(http.post).not.toHaveBeenCalled();
});

it("preserves a new page draft and its fields without creating the page twice", async () => {
  pending[0].targetItemId = null;
  let resolveDraft!: (value: unknown) => void;
  http.post.mockImplementation((url: string) => url.endsWith("/items")
    ? new Promise((resolve) => { resolveDraft = resolve; })
    : Promise.reject(new Error("Forbidden")));
  await render();
  await click("Edit");
  const inputs = host.querySelectorAll("input");
  const change = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await change(inputs[0], "New title");
  await change(inputs[1], "new-slug");
  await change(host.querySelector("textarea")!, "New content");
  await click("Save and accept");
  expect(http.post.mock.calls).toEqual([["/myrmidon/companies/c1/knowledge/items", { content: "New content", title: "New title", slug: "new-slug" }]]);
  await act(async () => resolveDraft({}));
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not complete the action");
  expect(host.textContent).not.toContain("Forbidden");
  await click("Cancel");
  await click("Edit");
  expect(host.querySelector("textarea")?.value).toBe("New content");
  expect(Array.from(host.querySelectorAll("input"), (input) => input.value)).toEqual(["New title", "new-slug"]);
  await click("Save and accept");
  expect(http.post.mock.calls).toEqual([
    ["/myrmidon/companies/c1/knowledge/items", { content: "New content", title: "New title", slug: "new-slug" }],
    ["/myrmidon/companies/c1/knowledge/suggestions/s1/accept", {}],
    ["/myrmidon/companies/c1/knowledge/suggestions/s1/accept", {}],
  ]);
});