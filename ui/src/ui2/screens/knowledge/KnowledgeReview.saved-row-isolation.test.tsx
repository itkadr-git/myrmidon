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

const rows = [
  { id: "s1", targetItemId: "i1", body: "Original one", rationale: null },
  { id: "s2", targetItemId: "i2", body: "Original two", rationale: null },
];
const base = "/myrmidon/companies/c1/knowledge";
let host: HTMLDivElement;
let root: Root;
let requests: Array<{ resolve: (value: unknown) => void; reject: (reason: Error) => void }>;

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function click(label: string, section?: Element) {
  const button = Array.from((section ?? host).querySelectorAll("button")).find((candidate) => candidate.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await settle();
}

function row(body: string) {
  const section = Array.from(host.querySelectorAll("section")).find((candidate) => candidate.querySelector("p")?.textContent === body);
  expect(section).toBeDefined();
  return section!;
}

async function editContent(value: string) {
  const editor = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, value);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function resolveRequest(index: number) {
  expect(requests[index]).toBeDefined();
  await act(async () => requests[index].resolve({}));
  await settle();
}

async function rejectRequest(index: number) {
  expect(requests[index]).toBeDefined();
  await act(async () => requests[index].reject(new Error("Forbidden")));
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not complete the action");
  expect(host.textContent).not.toContain("Forbidden");
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  requests = [];
  http.get.mockReset().mockResolvedValue({ suggestions: rows });
  http.post.mockReset().mockImplementation(() => new Promise((resolve, reject) => requests.push({ resolve, reject })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it.each([[0, 1], [1, 0]])("isolates saved drafts when editing row %i then row %i", async (firstIndex, secondIndex) => {
  const first = rows[firstIndex];
  const second = rows[secondIndex];
  const firstEdit = `Edited ${first.id}`;
  const secondEdit = `Edited ${second.id}`;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>));
  await settle();
  expect(http.get).toHaveBeenCalledWith(`${base}/suggestions?status=pending`);

  await click("Edit", row(first.body));
  expect(host.querySelector("textarea")?.value).toBe(first.body);
  await editContent(firstEdit);
  await click("Save and accept");
  expect(http.post.mock.calls).toEqual([[`${base}/items/${first.targetItemId}/draft`, { content: firstEdit }]]);
  await resolveRequest(0);
  expect(http.post.mock.calls[1]).toEqual([`${base}/suggestions/${first.id}/accept`, {}]);
  await rejectRequest(1);
  await click("Cancel");

  await click("Edit", row(second.body));
  const secondEditor = host.querySelector("textarea")!;
  expect(secondEditor.value).toBe(second.body);
  expect(secondEditor.disabled).toBe(false);
  expect(host.textContent).not.toContain("Draft saved. Retry accepting");
  await editContent(secondEdit);
  await click("Save and accept");
  expect(http.post.mock.calls[2]).toEqual([`${base}/items/${second.targetItemId}/draft`, { content: secondEdit }]);
  await resolveRequest(2);
  expect(http.post.mock.calls[3]).toEqual([`${base}/suggestions/${second.id}/accept`, {}]);
  await rejectRequest(3);
  await click("Cancel");

  await click("Edit", row(first.body));
  expect(host.querySelector("textarea")?.value).toBe(firstEdit);
  expect(host.querySelector("textarea")?.disabled).toBe(true);
  expect(host.textContent).toContain("Draft saved. Retry accepting");
  await click("Save and accept");
  expect(http.post.mock.calls).toEqual([
    [`${base}/items/${first.targetItemId}/draft`, { content: firstEdit }],
    [`${base}/suggestions/${first.id}/accept`, {}],
    [`${base}/items/${second.targetItemId}/draft`, { content: secondEdit }],
    [`${base}/suggestions/${second.id}/accept`, {}],
    [`${base}/suggestions/${first.id}/accept`, {}],
  ]);
  await rejectRequest(4);
});
