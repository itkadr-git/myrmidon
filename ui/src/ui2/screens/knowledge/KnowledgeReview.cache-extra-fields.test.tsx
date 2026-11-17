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

const key = ["knowledge", "suggestions", "c1", "pending"];
const endpoint = "/myrmidon/companies/c1/knowledge/suggestions?status=pending";
const s1 = { id: "s1", body: "First suggestion", targetItemId: "i1", rationale: "" };
const s2 = { id: "s2", body: "Second suggestion", targetItemId: "i2", rationale: "" };
let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let snapshot: { suggestions: typeof s1[]; requestId: string; total: number; extension: { cursor: string } };

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  http.get.mockReset().mockReturnValue(new Promise(() => {}));
  http.post.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  snapshot = { suggestions: [s1, s2], requestId: "fixture", total: 2, extension: { cursor: "fixture" } };
  client.setQueryData(key, snapshot);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>));
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); });

async function decide() {
  const section = Array.from(host.querySelectorAll("section")).find((row) => row.textContent?.includes("First suggestion"));
  const button = Array.from(section?.querySelectorAll("button") ?? []).find((item) => item.textContent === "Accept");
  expect(button).toBeDefined();
  await act(async () => { button?.click(); });
}

it("retains the envelope and leaves the previous snapshot unchanged after a successful decision", async () => {
  http.post.mockResolvedValue({ suggestion: { id: "s1" } });
  expect(host.textContent).toContain("First suggestion");
  expect(host.textContent).toContain("Second suggestion");
  await decide();
  await vi.waitFor(() => expect(client.getQueryData(key)).toEqual({ ...snapshot, suggestions: [s2] }));
  await vi.waitFor(() => expect(host.textContent).not.toContain("First suggestion"));
  expect(host.textContent).toContain("Second suggestion");
  expect(client.getQueryData(key)).not.toBe(snapshot);
  expect(snapshot).toEqual({ suggestions: [s1, s2], requestId: "fixture", total: 2, extension: { cursor: "fixture" } });
  expect(http.get.mock.calls).toEqual([[endpoint], [endpoint]]);
  expect(http.post.mock.calls).toEqual([["/myrmidon/companies/c1/knowledge/suggestions/s1/accept", {}]]);
});

it("preserves the entire snapshot when the decision fails", async () => {
  http.post.mockRejectedValue(new Error("Forbidden"));
  await decide();
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("Forbidden"));
  expect(host.textContent).toContain("First suggestion");
  expect(host.textContent).toContain("Second suggestion");
  expect(client.getQueryData(key)).toBe(snapshot);
  expect(snapshot).toEqual({ suggestions: [s1, s2], requestId: "fixture", total: 2, extension: { cursor: "fixture" } });
  expect(http.get.mock.calls).toEqual([[endpoint]]);
  expect(http.post.mock.calls).toEqual([["/myrmidon/companies/c1/knowledge/suggestions/s1/accept", {}]]);
});
