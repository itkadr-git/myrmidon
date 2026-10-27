// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const queries = vi.hoisted(() => ({ results: [] as Array<{ data: unknown; isError: boolean }> }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => queries.results.shift()),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
import { useQuery } from "@tanstack/react-query";
import { useUi2StatusStrip, type Ui2StatusStrip } from "../useUi2Status";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.clearAllMocks());

function readStrip(failedSource: number | null) {
  const data = [
    { agents: { active: 1, running: 2, paused: 0, error: 0 }, runActivity: [] },
    { approvals: 3 },
    [{ id: "run" }],
    { spendCents: 100, budgetCents: 0 },
    [{ status: "open" }],
    { countsBySourceKind: { issue_thread_interaction: 2 } },
  ];
  queries.results = data.map((value, index) => ({ data: value, isError: failedSource === index }));
  let strip: Ui2StatusStrip | null = null;
  function Probe() {
    strip = useUi2StatusStrip("company");
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return strip as Ui2StatusStrip | null;
}

describe("UI2 status source availability", () => {
  it("composes complete data and explicitly refreshes on interval and focus", () => {
    expect(readStrip(null)?.waiting?.count).toBe(6);
    for (const [options] of vi.mocked(useQuery).mock.calls) {
      expect(options).toMatchObject({ refetchInterval: 30_000, refetchOnWindowFocus: true });
    }
  });

  it.each([1, 4, 5])("does not expose a stale/partial waiting total when source %i fails", (source) => {
    const strip = readStrip(source);
    expect(strip?.waiting).toBeNull();
    expect(strip?.colony?.running).toBe(2);
    expect(strip?.spend?.spendCents).toBe(100);
  });

  it.each([0, 2, 3])("marks failed chip source %i unavailable even with cached data", (source) => {
    const strip = readStrip(source);
    expect(strip?.[source === 0 ? "colony" : source === 2 ? "runs" : "spend"]).toBeNull();
    expect(strip?.waiting?.count).toBe(6);
  });
});
