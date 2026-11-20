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

const suggestions = [
  { id: "s1", body: "First suggestion", targetItemId: "i1", rationale: "" },
  { id: "s2", body: "Second suggestion", targetItemId: "i2", rationale: "" },
];
const queryKey = ["knowledge", "suggestions", "c1", "pending"];
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  http.get.mockReset().mockResolvedValue({ suggestions });
  http.post.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); });

async function renderQueue() {
  await act(async () => { root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>); });
  await vi.waitFor(() => expect(host.querySelectorAll("section")).toHaveLength(2));
}
function button(section: Element, label: string) {
  const result = Array.from(section.querySelectorAll("button")).find((item) => item.textContent === label);
  expect(result).toBeDefined();
  return result!;
}

it("returns focus to the second suggestion's Edit after each cancellation without posting", async () => {
  await renderQueue();
  const [first, second] = Array.from(host.querySelectorAll("section"));
  expect(first.textContent).toContain("First suggestion");
  expect(second.textContent).toContain("Second suggestion");
  for (let cycle = 0; cycle < 2; cycle++) {
    await act(async () => { button(second, "Edit").focus(); button(second, "Edit").click(); });
    const textarea = second.querySelector("textarea");
    expect(textarea?.value).toBe("Second suggestion");
    expect(document.activeElement).toBe(textarea);
    await act(async () => { button(second, "Cancel").click(); });
    expect(second.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button(second, "Edit"));
    expect(document.activeElement).not.toBe(button(first, "Edit"));
  }
  expect(http.get.mock.calls).toEqual([["/myrmidon/companies/c1/knowledge/suggestions?status=pending"]]);
  expect(http.post).not.toHaveBeenCalled();
});

it("tolerates the edited suggestion disappearing from the queue", async () => {
  await renderQueue();
  const second = host.querySelectorAll("section")[1];
  await act(async () => { button(second, "Edit").click(); });
  expect(document.activeElement).toBe(second.querySelector("textarea"));
  await act(async () => { client.setQueryData(queryKey, { suggestions: [suggestions[0]] }); });
  await vi.waitFor(() => expect(host.querySelectorAll("section")).toHaveLength(1));
  expect(host.textContent).toContain("First suggestion");
  expect(host.textContent).not.toContain("Second suggestion");
  expect(http.post).not.toHaveBeenCalled();
});
