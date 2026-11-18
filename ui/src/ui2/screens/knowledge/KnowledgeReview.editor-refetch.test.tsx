// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { KnowledgeReview } from "./KnowledgeReview";

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/api/client", () => ({ api: http }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ i18n: { language: "en" } }) }));

const key = ["knowledge", "suggestions", "c1", "pending"];
const url = "/myrmidon/companies/c1/knowledge";
const initial = [{ id: "s1", body: "Original body", rationale: "Original reason", targetItemId: "i1" }];
const refreshed = [
  { id: "s2", body: "Neighbor body", rationale: "Neighbor reason", targetItemId: "i2" },
  { id: "s1", body: "Fresh body", rationale: "Fresh reason", targetItemId: "i1" },
];
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
function row(body: string) {
  const section = Array.from(host.querySelectorAll("section")).find((element) => element.textContent?.includes(body));
  expect(section).toBeDefined();
  return section!;
}
async function click(section: HTMLElement, label: string) {
  const button = Array.from(section.querySelectorAll("button")).find((element) => element.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await settle();
}
async function setupRefetch() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let resolveRefetch: ((value: { suggestions: typeof refreshed }) => void) | undefined;
  let requests = 0;
  http.get.mockReset().mockImplementation((requestUrl: string) => {
    if (requestUrl !== `${url}/suggestions?status=pending`) throw new Error(`Unexpected GET: ${requestUrl}`);
    if (++requests === 1) return Promise.resolve({ suggestions: initial });
    if (requests === 2) return new Promise((resolve) => { resolveRefetch = resolve; });
    return Promise.resolve({ suggestions: refreshed.filter((item) => item.id !== "s1") });
  });
  http.post.mockReset().mockResolvedValue({});
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>));
  await settle();
  await click(row("Original body"), "Edit");
  const editor = row("Original body").querySelector("textarea")!;
  expect(editor.value).toBe("Original body");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Local edit");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(editor.value).toBe("Local edit");
  await act(async () => { void client.invalidateQueries({ queryKey: key }); });
  await settle();
  expect(resolveRefetch).toBeDefined();
  expect(http.post).not.toHaveBeenCalled();
  await act(async () => resolveRefetch!({ suggestions: refreshed }));
  await settle();
  expect(http.get.mock.calls).toEqual([[`${url}/suggestions?status=pending`], [`${url}/suggestions?status=pending`]]);
  expect(Array.from(host.querySelectorAll("section")).map((section) => section.querySelector("p")?.textContent)).toEqual(["Neighbor body", "Fresh body"]);
  expect(row("Fresh body").textContent).toContain("Fresh reason");
  expect(row("Fresh body").querySelector("textarea")?.value).toBe("Local edit");
  expect(row("Neighbor body").textContent).toContain("Neighbor reason");
  expect(row("Neighbor body").textContent).not.toContain("Local edit");
  expect(row("Neighbor body").querySelector("textarea")).toBeNull();
  expect(http.post).not.toHaveBeenCalled();
}

afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove();
  client?.clear();
  vi.clearAllMocks();
});

it("keeps the local editor on refetch and saves it before accepting the same suggestion", async () => {
  await setupRefetch();
  await click(row("Fresh body"), "Save and accept");
  expect(http.post.mock.calls).toEqual([
    [`${url}/items/i1/draft`, { content: "Local edit" }],
    [`${url}/suggestions/s1/accept`, {}],
  ]);
  expect(host.textContent).toContain("Neighbor body");
  expect(host.textContent).not.toContain("Fresh body");
});

it("cancels without a write and reopens with the fresh server body", async () => {
  await setupRefetch();
  await click(row("Fresh body"), "Cancel");
  expect(host.querySelector("textarea")).toBeNull();
  expect(http.post).not.toHaveBeenCalled();
  await click(row("Fresh body"), "Edit");
  expect(row("Fresh body").querySelector("textarea")?.value).toBe("Fresh body");
  expect(row("Neighbor body").querySelector("textarea")).toBeNull();
  expect(http.post).not.toHaveBeenCalled();
});
