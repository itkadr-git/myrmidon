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

const payload = `<b>literal</b><img src=x onerror="globalThis.reviewSentinel = 1"><script>globalThis.reviewSentinel = 2</script>[click](javascript:globalThis.reviewSentinel=3)<a href="javascript:globalThis.reviewSentinel=4" onclick="globalThis.reviewSentinel=5">link</a>`;
let host: HTMLDivElement;
let root: Root;
async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render(body: string, rationale: string) {
  http.get.mockResolvedValue({ suggestions: [{ id: "s1", body, rationale, targetItemId: "i1" }] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><KnowledgeReview /></QueryClientProvider>));
  await settle();
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find((element) => element.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button?.click());
  await settle();
}
function expectInert() {
  const row = host.querySelector('section[aria-label]');
  expect(row).not.toBeNull();
  expect(row?.textContent).toContain(payload);
  expect(row?.querySelector("script, img, a, link, [onerror], [onclick]")).toBeNull();
  expect((globalThis as { reviewSentinel?: number }).reviewSentinel).toBe(0);
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { reviewSentinel?: number }).reviewSentinel = 0;
  http.get.mockReset();
  http.post.mockReset().mockResolvedValue({ suggestion: { id: "s1" } });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (globalThis as { reviewSentinel?: number }).reviewSentinel;
});
it("renders untrusted body as literal text and preserves it in the saved draft", async () => {
  await render(payload, "ordinary rationale");
  expect(host.textContent).toContain("ordinary rationale");
  expectInert();
  await click("Edit");
  expect(host.querySelector("textarea")?.value).toBe(payload);
  expect(http.post).not.toHaveBeenCalled();
  await click("Save and accept");
  expect(http.post.mock.calls[0]).toEqual(["/myrmidon/companies/c1/knowledge/items/i1/draft", { content: payload }]);
  expect(http.post.mock.calls[1]).toEqual(["/myrmidon/companies/c1/knowledge/suggestions/s1/accept", {}]);
  expect((globalThis as { reviewSentinel?: number }).reviewSentinel).toBe(0);
});
it("renders untrusted rationale as literal text and accepts normally", async () => {
  await render("ordinary body", payload);
  expect(host.textContent).toContain("ordinary body");
  expectInert();
  await click("Accept");
  expect(http.post).toHaveBeenCalledWith("/myrmidon/companies/c1/knowledge/suggestions/s1/accept", {});
  expect((globalThis as { reviewSentinel?: number }).reviewSentinel).toBe(0);
});
