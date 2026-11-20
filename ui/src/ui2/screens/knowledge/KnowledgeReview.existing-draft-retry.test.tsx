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
let pending: Array<{ id: string; body: string; targetItemId: string; rationale: string }>;
const draftUrl = "/myrmidon/companies/c1/knowledge/items/i1/draft";
const acceptUrl = "/myrmidon/companies/c1/knowledge/suggestions/s1/accept";
const revised = "  Revised first line\nsecond line  \n";

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find((element) => element.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await settle();
}
async function changeContent(value: string) {
  const editor = host.querySelector("textarea");
  expect(editor).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, value);
    editor!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function openAndFail() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><KnowledgeReview /></QueryClientProvider>));
  await settle();
  await click("Edit");
  await click("Save and accept");
  expect(http.post.mock.calls).toEqual([[draftUrl, { content: "Original proposal" }]]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Draft failed");
  await changeContent(revised);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  pending = [
    { id: "s1", body: "Original proposal", targetItemId: "i1", rationale: "" },
    { id: "s2", body: "Other proposal", targetItemId: "i2", rationale: "" },
  ];
  http.get.mockReset().mockImplementation(async () => ({ suggestions: pending }));
  http.post.mockReset();
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); });

it("retries the existing draft with exact edited content before accepting only that row", async () => {
  http.post.mockImplementationOnce(async () => { throw new Error("Draft failed"); });
  http.post.mockImplementation(async (url: string) => {
    if (url === acceptUrl) pending = pending.filter((row) => row.id !== "s1");
    return {};
  });
  await openAndFail();
  await click("Save and accept");
  expect(http.post.mock.calls).toEqual([
    [draftUrl, { content: "Original proposal" }],
    [draftUrl, { content: revised }],
    [acceptUrl, {}],
  ]);
  expect(host.textContent).not.toContain("Original proposal");
  expect(host.textContent).toContain("Other proposal");
});

it("does not decide or create an article if the retry also fails", async () => {
  http.post.mockRejectedValue(new Error("Draft failed"));
  await openAndFail();
  await click("Save and accept");
  expect(http.post.mock.calls).toEqual([
    [draftUrl, { content: "Original proposal" }],
    [draftUrl, { content: revised }],
  ]);
  expect(host.querySelector("textarea")?.value).toBe(revised);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Draft failed");
  expect(host.textContent).toContain("Other proposal");
});
