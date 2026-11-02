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
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><KnowledgeReview /></QueryClientProvider>));
  await settle();
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
  await settle();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  pending = [{ id: "s1", body: "Proposed text", targetItemId: "i1", rationale: "A useful change" }];
  http.get.mockReset().mockImplementation(async () => ({ suggestions: pending }));
  http.post.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith("/accept") || url.endsWith("/decline")) pending = [];
    return { suggestion: { id: "s1" } };
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
it.each([ ["Accept", "accept"], ["Reject", "decline"] ])("%s updates the API and removes the suggestion from the pending queue", async (label, endpoint) => {
  await render();
  expect(host.textContent).toContain("Proposed text");
  await click(label);
  expect(http.post).toHaveBeenCalledWith(`/myrmidon/companies/c1/knowledge/suggestions/s1/${endpoint}`, {});
  expect(http.get).toHaveBeenCalledWith("/myrmidon/companies/c1/knowledge/suggestions?status=pending");
  expect(host.textContent).not.toContain("Proposed text");
  expect(host.textContent).toContain("No pending suggestions");
});
it("opens the editor without deciding and saves the edited draft before accepting", async () => {
  await render();
  await click("Edit");
  const editor = host.querySelector("textarea")!;
  expect(editor.value).toBe("Proposed text");
  expect(http.post).not.toHaveBeenCalled();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Edited text");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Save and accept");
  expect(http.post.mock.calls[0]).toEqual(["/myrmidon/companies/c1/knowledge/items/i1/draft", { content: "Edited text" }]);
  expect(http.post.mock.calls[1][0]).toContain("/suggestions/s1/accept");
  expect(host.textContent).not.toContain("Proposed text");
});
it("keeps the suggestion and shows an error when a decision fails", async () => {
  http.post.mockRejectedValue(new Error("Forbidden"));
  await render();
  await click("Accept");
  expect(host.textContent).toContain("Proposed text");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Forbidden");
});
it("does not accept if saving the draft fails", async () => {
  http.post.mockRejectedValue(new Error("Draft failed"));
  await render();
  await click("Edit");
  await click("Save and accept");
  expect(http.post).toHaveBeenCalledTimes(1);
  expect(host.querySelector("textarea")).not.toBeNull();
  expect(host.textContent).toContain("Draft failed");
});
it("cancels editing without a write", async () => {
  await render();
  await click("Edit");
  await click("Cancel");
  expect(http.post).not.toHaveBeenCalled();
  expect(host.querySelector("textarea")).toBeNull();
});
