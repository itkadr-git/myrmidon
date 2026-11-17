// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { KnowledgeReview } from "./KnowledgeReview";

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/api/client", () => ({ api: http }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ i18n: { language: "en" } }) }));

it("retains the queue and actions after a background read error and retries without writes", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  http.get.mockReset();
  http.post.mockReset();
  const row = (id: string, body: string) => ({ id, body, targetItemId: "i1", rationale: "" });
  const first = { suggestions: [row("s1", "First suggestion"), row("s2", "Second suggestion")] };
  const updated = { suggestions: [row("s1", "Updated suggestion"), row("s2", "Second suggestion")] };
  let rejectRefetch!: (error: Error) => void;
  let resolveRetry!: (value: typeof updated) => void;
  http.get.mockResolvedValueOnce(first)
    .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRefetch = reject; }))
    .mockReturnValueOnce(new Promise((resolve) => { resolveRetry = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const endpoint = "/myrmidon/companies/c1/knowledge/suggestions?status=pending";
  const expectRowsAndActions = () => {
    const rows = Array.from(host.querySelectorAll('section[aria-label="Knowledge suggestion"]'));
    expect(rows).toHaveLength(2);
    for (const section of rows) {
      expect(Array.from(section.querySelectorAll("button")).map((button) => [button.textContent, button.disabled]))
        .toEqual([["Accept", false], ["Reject", false], ["Edit", false]]);
    }
  };
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>); });
    await vi.waitFor(() => expect(host.textContent).toContain("Second suggestion"));
    expect(host.textContent).toContain("First suggestion");
    expectRowsAndActions();
    await act(async () => { void client.invalidateQueries({ queryKey: ["knowledge", "suggestions", "c1", "pending"] }); });
    expect(http.get).toHaveBeenCalledTimes(2);
    expectRowsAndActions();
    await act(async () => { rejectRefetch(new Error("offline")); });
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load suggestions"));
    expect(host.textContent).toContain("First suggestion");
    expect(host.textContent).toContain("Second suggestion");
    expectRowsAndActions();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.textContent).not.toContain("No pending suggestions");
    const retry = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Retry");
    expect(retry?.disabled).toBe(false);
    await act(async () => { retry?.click(); });
    expect(http.get).toHaveBeenCalledTimes(3);
    await act(async () => { resolveRetry(updated); });
    await vi.waitFor(() => expect(host.textContent).toContain("Updated suggestion"));
    expect(host.textContent).not.toContain("First suggestion");
    expect(host.textContent).toContain("Second suggestion");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expectRowsAndActions();
    expect(http.get.mock.calls).toEqual([[endpoint], [endpoint], [endpoint]]);
    expect(http.post).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
    client.clear();
  }
});
