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

const items = "/myrmidon/companies/c1/knowledge/items";
const accept = "/myrmidon/companies/c1/knowledge/suggestions/s1/accept";
let host: HTMLDivElement;
let root: Root;
let pending: Array<{ id: string; body: string; targetItemId: null; rationale: string }>;

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function renderEditor() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>));
  await settle();
  expect(host.textContent).toContain("Proposed text");
  await click("Edit");
}
function button(label: string) {
  const result = Array.from(host.querySelectorAll("button")).find((element) => element.textContent === label);
  expect(result).toBeDefined();
  return result!;
}
async function click(label: string) {
  await act(async () => button(label).click());
  await settle();
}
function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const result = Array.from(host.querySelectorAll("label")).find((element) => element.firstChild?.textContent === label)?.querySelector("input, textarea");
  expect(result).toBeTruthy();
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
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  pending = [{ id: "s1", body: "Proposed text", targetItemId: null, rationale: "New page" }];
  http.get.mockReset().mockImplementation(async () => ({ suggestions: pending }));
  http.post.mockReset().mockImplementation(async (url: string) => {
    if (url === accept) pending = [];
    return {};
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("requires non-blank title, slug and content before creating a page", async () => {
  await renderEditor();
  expect(field("Content").value).toBe("Proposed text");
  expect(button("Save and accept").disabled).toBe(true);
  await change("Title", "   ");
  await change("Page slug", "page");
  expect(button("Save and accept").disabled).toBe(true);
  await change("Title", "Page");
  await change("Page slug", "  ");
  expect(button("Save and accept").disabled).toBe(true);
  await change("Page slug", "page");
  await change("Content", " \n ");
  expect(button("Save and accept").disabled).toBe(true);
  await click("Save and accept");
  expect(http.post).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Proposed text");
  await change("Content", "Edited text");
  expect(button("Save and accept").disabled).toBe(false);
});

it("creates the trimmed page once before accepting the suggestion", async () => {
  const create = deferred();
  http.post.mockImplementation(async (url: string) => {
    if (url === items) return create.promise;
    if (url === accept) pending = [];
    return {};
  });
  await renderEditor();
  await change("Title", "  New page  ");
  await change("Page slug", "  new-page  ");
  await change("Content", " Edited content ");
  expect(http.post).not.toHaveBeenCalled();
  await click("Save and accept");
  expect(button("Save and accept").disabled).toBe(true);
  expect(http.post.mock.calls).toEqual([[items, { content: " Edited content ", title: "New page", slug: "new-page" }]]);
  await act(async () => create.resolve({}));
  await settle();
  expect(http.post.mock.calls).toEqual([
    [items, { content: " Edited content ", title: "New page", slug: "new-page" }],
    [accept, {}],
  ]);
  expect(host.textContent).toContain("No pending suggestions");
  expect(host.querySelector("textarea")).toBeNull();
  expect(http.get).toHaveBeenCalledWith("/myrmidon/companies/c1/knowledge/suggestions?status=pending");
});

it("keeps all entered fields and does not accept when creation fails", async () => {
  const create = deferred();
  http.post.mockImplementation(() => create.promise);
  await renderEditor();
  await change("Title", "  New page  ");
  await change("Page slug", "  new-page  ");
  await change("Content", "Edited content");
  await click("Save and accept");
  expect(http.post.mock.calls).toEqual([[items, { content: "Edited content", title: "New page", slug: "new-page" }]]);
  await act(async () => create.reject(new Error("Create failed")));
  await settle();
  expect(http.post).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Create failed");
  expect(host.textContent).toContain("Proposed text");
  expect(field("Title").value).toBe("  New page  ");
  expect(field("Page slug").value).toBe("  new-page  ");
  expect(field("Content").value).toBe("Edited content");
  expect(button("Save and accept").disabled).toBe(false);
});

it("retries a failed accept without creating a second draft", async () => {
  http.post.mockImplementation(async (url: string) => {
    if (url === accept) throw new Error("Accept failed");
    return {};
  });
  await renderEditor();
  await change("Title", "Page");
  await change("Page slug", "page");
  await click("Save and accept");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Accept failed");
  expect(host.textContent).toContain("Draft saved");
  expect(field("Title").disabled).toBe(true);
  http.post.mockImplementation(async () => { pending = []; return {}; });
  await click("Save and accept");
  expect(http.post.mock.calls).toEqual([
    [items, { content: "Proposed text", title: "Page", slug: "page" }],
    [accept, {}],
    [accept, {}],
  ]);
  expect(host.textContent).toContain("No pending suggestions");
});
