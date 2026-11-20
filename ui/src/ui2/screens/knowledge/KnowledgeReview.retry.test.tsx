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

const draftUrl = "/myrmidon/companies/c1/knowledge/items/i1/draft";
const acceptUrl = "/myrmidon/companies/c1/knowledge/suggestions/s1/accept";
let host: HTMLDivElement;
let root: Root;
let pending: Array<{ id: string; body: string; targetItemId: string; rationale: string }>;
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await settle();
}
async function edit() {
  await act(async () => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><KnowledgeReview /></QueryClientProvider>));
  await settle();
  await click("Edit");
  const editor = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Edited text");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return editor;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  pending = [{ id: "s1", body: "Proposed text", targetItemId: "i1", rationale: "A useful change" }];
  http.get.mockReset().mockImplementation(async () => ({ suggestions: pending }));
  http.post.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("keeps edited content and never accepts when the draft write fails", async () => {
  const draft = deferred();
  http.post.mockReturnValueOnce(draft.promise);
  const editor = await edit();
  await click("Save and accept");
  expect(http.post.mock.calls).toEqual([[draftUrl, { content: "Edited text" }]]);
  expect(editor.disabled).toBe(true);
  await act(async () => draft.reject(new Error("Draft failed")));
  await settle();
  expect(http.post).toHaveBeenCalledTimes(1);
  expect(http.get).toHaveBeenCalledWith("/myrmidon/companies/c1/knowledge/suggestions?status=pending");
  expect(host.textContent).toContain("Proposed text");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Draft failed");
  expect(editor.value).toBe("Edited text");
  expect(editor.disabled).toBe(false);
});

it("retries only the decision after a saved draft and removes the suggestion on success", async () => {
  const draft = deferred();
  const firstAccept = deferred();
  const retry = deferred();
  http.post.mockReturnValueOnce(draft.promise).mockReturnValueOnce(firstAccept.promise).mockReturnValueOnce(retry.promise);
  const editor = await edit();
  await click("Save and accept");
  expect(http.post.mock.calls).toEqual([[draftUrl, { content: "Edited text" }]]);
  await act(async () => draft.resolve({}));
  await settle();
  expect(http.post.mock.calls).toEqual([[draftUrl, { content: "Edited text" }], [acceptUrl, {}]]);
  await act(async () => firstAccept.reject(new Error("Accept failed")));
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Accept failed");
  expect(host.textContent).toContain("Proposed text");
  expect(editor.value).toBe("Edited text");
  expect(editor.disabled).toBe(true);
  await click("Save and accept");
  expect(http.post.mock.calls).toEqual([[draftUrl, { content: "Edited text" }], [acceptUrl, {}], [acceptUrl, {}]]);
  expect(host.textContent).toContain("Proposed text");
  pending = [];
  await act(async () => retry.resolve({}));
  await settle();
  expect(host.textContent).not.toContain("Proposed text");
  expect(host.textContent).toContain("No pending suggestions");
  expect(http.get).toHaveBeenCalledWith("/myrmidon/companies/c1/knowledge/suggestions?status=pending");
  expect(http.post).toHaveBeenCalledTimes(3);
});
