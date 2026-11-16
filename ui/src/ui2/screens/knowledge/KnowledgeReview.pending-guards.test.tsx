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

type Suggestion = { id: string; body: string; targetItemId: string | null; rationale: string };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

let host: HTMLDivElement;
let root: Root;
let pending: Suggestion[];

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <KnowledgeReview />
    </QueryClientProvider>,
  ));
  await settle();
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll("button")).filter((button) => button.textContent === label);
}

function button(label: string, index = 0): HTMLButtonElement {
  const found = buttons(label)[index];
  expect(found).toBeTruthy();
  return found!;
}

async function click(label: string, index = 0) {
  await act(async () => button(label, index).click());
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  pending = [
    { id: "s1", body: "First proposed text", targetItemId: "i1", rationale: "First rationale" },
    { id: "s2", body: "Second proposed text", targetItemId: "i2", rationale: "Second rationale" },
  ];
  http.get.mockReset().mockImplementation(async () => ({ suggestions: pending }));
  http.post.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith("/accept") || url.endsWith("/decline")) pending = pending.filter((suggestion) => !url.includes(`/suggestions/${suggestion.id}/`));
    return { suggestion: { id: "s1" } };
  });
});

afterEach(() => { act(() => root.unmount()); host.remove(); });

it("blocks every row while a decision is pending and allows the remaining row after it resolves", async () => {
  const accept = deferred<{ suggestion: { id: string } }>();
  http.post.mockImplementationOnce(() => accept.promise);
  await render();

  await click("Accept", 0);
  expect(buttons("Accept")).toHaveLength(2);
  expect(buttons("Reject")).toHaveLength(2);
  expect(buttons("Edit")).toHaveLength(2);
  expect(buttons("Accept").every((candidate) => candidate.disabled)).toBe(true);
  expect(buttons("Reject").every((candidate) => candidate.disabled)).toBe(true);
  expect(buttons("Edit").every((candidate) => candidate.disabled)).toBe(true);

  await act(async () => button("Accept", 0).click());
  expect(http.post).toHaveBeenCalledTimes(1);
  expect(http.post.mock.calls[0]).toEqual(["/myrmidon/companies/c1/knowledge/suggestions/s1/accept", {}]);

  pending = pending.filter((suggestion) => suggestion.id !== "s1");
  accept.resolve({ suggestion: { id: "s1" } });
  await settle();
  expect(host.textContent).not.toContain("First proposed text");
  expect(host.textContent).toContain("Second proposed text");
  expect(button("Accept").disabled).toBe(false);
  expect(button("Reject").disabled).toBe(false);
  expect(button("Edit").disabled).toBe(false);
});

it("disables the editor until the draft write resolves and accepts only afterwards", async () => {
  const draft = deferred<{ suggestion: { id: string } }>();
  http.post.mockImplementationOnce(() => draft.promise).mockResolvedValueOnce({ suggestion: { id: "s1" } });
  await render();
  await click("Edit", 0);

  const editor = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Edited text");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Save and accept");

  expect(editor.disabled).toBe(true);
  expect(button("Save and accept").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
  expect(http.post).toHaveBeenCalledTimes(1);
  expect(http.post.mock.calls[0]).toEqual(["/myrmidon/companies/c1/knowledge/items/i1/draft", { content: "Edited text" }]);

  draft.resolve({ suggestion: { id: "s1" } });
  await settle();
  expect(http.post).toHaveBeenCalledTimes(2);
  expect(http.post.mock.calls[1]).toEqual(["/myrmidon/companies/c1/knowledge/suggestions/s1/accept", {}]);
});

it("keeps a rejected draft editable without accepting and permits a retry", async () => {
  const draft = deferred<never>();
  http.post.mockImplementationOnce(() => draft.promise);
  await render();
  await click("Edit", 0);
  const editor = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Retained edit");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Save and accept");

  draft.reject(new Error("Draft failed"));
  await settle();
  expect(http.post).toHaveBeenCalledTimes(1);
  expect(http.post.mock.calls[0]).toEqual(["/myrmidon/companies/c1/knowledge/items/i1/draft", { content: "Retained edit" }]);
  expect(host.querySelector("textarea")).not.toBeNull();
  expect(host.querySelector("textarea")?.value).toBe("Retained edit");
  expect(host.querySelector("textarea")!.disabled).toBe(false);
  expect(button("Save and accept").disabled).toBe(false);
  expect(button("Cancel").disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Draft failed");

  const retry = deferred<never>();
  http.post.mockImplementationOnce(() => retry.promise);
  await click("Save and accept");
  expect(http.post).toHaveBeenCalledTimes(2);
  expect(http.post.mock.calls[1]).toEqual(["/myrmidon/companies/c1/knowledge/items/i1/draft", { content: "Retained edit" }]);
  retry.reject(new Error("Draft failed again"));
  await settle();
});
