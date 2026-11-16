// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { KnowledgeReview } from "./KnowledgeReview";

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/api/client", () => ({ api: http }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ i18n: { language: "en" } }) }));

const pendingKey = ["knowledge", "suggestions", "c1", "pending"];
const pendingUrl = "/myrmidon/companies/c1/knowledge/suggestions?status=pending";
const itemsUrl = "/myrmidon/companies/c1/knowledge/items";
const rows = [
  { id: "s1", body: "First proposal", targetItemId: "i1", rationale: "First reason" },
  { id: "s2", body: "Second proposal", targetItemId: "i2", rationale: "Second reason" },
  { id: "s3", body: "Third proposal", targetItemId: "i3", rationale: "Third reason" },
];
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let unsubscribe: (() => void) | undefined;

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function clickRow(body: string, label: string) {
  const section = Array.from(host.querySelectorAll("section")).find((element) => element.textContent?.includes(body));
  expect(section).toBeDefined();
  const button = Array.from(section!.querySelectorAll("button")).find((element) => element.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await settle();
}

afterEach(() => {
  unsubscribe?.();
  if (root) act(() => root.unmount());
  host?.remove();
  client?.clear();
  vi.clearAllMocks();
});

it("removes only the decided suggestion while pending and item refetches run", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let pending = [...rows];
  let resolveRefetch: ((value: { suggestions: typeof rows }) => void) | undefined;
  let pendingRequests = 0;
  http.get.mockReset().mockImplementation((url: string) => {
    if (url === itemsUrl) return Promise.resolve({ items: [] });
    if (url !== pendingUrl) throw new Error(`Unexpected GET: ${url}`);
    if (++pendingRequests === 1) return Promise.resolve({ suggestions: [...pending] });
    return new Promise((resolve) => { resolveRefetch = resolve; });
  });
  http.post.mockReset().mockImplementation(async (url: string) => {
    const match = url.match(/\/suggestions\/(s[123])\/(accept|decline)$/);
    if (!match) throw new Error(`Unexpected POST: ${url}`);
    pending = pending.filter((row) => row.id !== match[1]);
    return { suggestion: { id: match[1] } };
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const items = new QueryObserver(client, {
    queryKey: ["knowledge", "items", "c1"],
    queryFn: () => http.get(itemsUrl),
  });
  unsubscribe = items.subscribe(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>));
  await settle();
  expect(client.getQueryData(pendingKey)).toEqual({ suggestions: rows });
  expect(host.textContent).toContain("First proposal");
  expect(host.textContent).toContain("Second proposal");
  expect(host.textContent).toContain("Third proposal");
  expect(host.textContent).toContain("Third reason");
  expect(http.post).not.toHaveBeenCalled();
  expect(http.get).toHaveBeenCalledWith(pendingUrl);
  expect(http.get).toHaveBeenCalledTimes(2);

  await clickRow("Second proposal", "Accept");
  expect(http.post.mock.calls).toEqual([["/myrmidon/companies/c1/knowledge/suggestions/s2/accept", {}]]);
  expect(resolveRefetch).toBeDefined();
  expect(client.getQueryData(pendingKey)).toEqual({ suggestions: [rows[0], rows[2]] });
  expect(host.textContent).not.toContain("Second proposal");
  expect(host.textContent).not.toContain("Second reason");
  expect(host.textContent).toContain("First proposal");
  expect(host.textContent).toContain("Third proposal");
  expect(host.textContent).toContain("Third reason");
  expect(http.get.mock.calls.filter(([url]) => url === itemsUrl)).toHaveLength(2);
  expect(http.get.mock.calls.filter(([url]) => url === pendingUrl)).toHaveLength(2);

  await act(async () => resolveRefetch!({ suggestions: [...pending] }));
  await settle();
  resolveRefetch = undefined;
  await clickRow("First proposal", "Reject");
  expect(http.post.mock.calls).toEqual([
    ["/myrmidon/companies/c1/knowledge/suggestions/s2/accept", {}],
    ["/myrmidon/companies/c1/knowledge/suggestions/s1/decline", {}],
  ]);
  expect(resolveRefetch).toBeDefined();
  expect(client.getQueryData(pendingKey)).toEqual({ suggestions: [rows[2]] });
  expect(host.textContent).not.toContain("First proposal");
  expect(host.textContent).not.toContain("First reason");
  expect(host.textContent).not.toContain("Second proposal");
  expect(host.textContent).toContain("Third proposal");
  expect(host.textContent).toContain("Third reason");
  expect(host.textContent).not.toContain("No pending suggestions");
  expect(http.get.mock.calls.filter(([url]) => url === itemsUrl)).toHaveLength(3);
  expect(http.get.mock.calls.filter(([url]) => url === pendingUrl)).toHaveLength(3);
  await act(async () => resolveRefetch!({ suggestions: [...pending] }));
  await settle();
  expect(client.getQueryData(pendingKey)).toEqual({ suggestions: [rows[2]] });
  expect(host.textContent).toContain("Third reason");
});
