// @vitest-environment jsdom
//
// myrmidon(1.6.6-PROCS-1.7-B): the leader-lease block of the "Processes" panel.
// The read route belongs to part A of OPE-5413; until that part merges the tests
// drive the block with the contract fixtures in
// docs/myrmidon/board-leases-contract/ — the mock the PR description freezes
// for A.
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { i18n } from "@/i18n";
import enCatalog from "../../i18n/myrmidon-locales/en.json";
import ruCatalog from "../../i18n/myrmidon-locales/ru.json";
import leasesFixture from "../../../../docs/myrmidon/board-leases-contract/leases.json";
import singleProcessFixture from "../../../../docs/myrmidon/board-leases-contract/leases-single-process.json";
import { BoardLeasesPanel, BoardLeasesView } from "./BoardLeasesPanel";
import {
  BOARD_LEASES_REFETCH_MS,
  boardLeasesApi,
  boardLeasesQueryKey,
  formatLeaseTimestamp,
  isLeaderChangedEvent,
  leaseExpiryState,
  leaseIsSelf,
  parseBoardLeasesState,
} from "./boardLeasesApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Clock the contract fixtures are written around. */
const NOW = Date.parse("2026-10-08T21:00:29.000Z");

let roots: Root[] = [];

function mount(node: ReactElement, queryClient: QueryClient): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  return container;
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function stubGet(value: unknown): void {
  vi.spyOn(boardLeasesApi, "get").mockImplementation(() =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value as never),
  );
}

async function renderPanel(now = NOW): Promise<{ container: HTMLDivElement; queryClient: QueryClient }> {
  const queryClient = newClient();
  const container = mount(<BoardLeasesPanel now={now} />, queryClient);
  await settle();
  return { container, queryClient };
}

function cell(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function row(container: HTMLElement, name: string): HTMLElement | null {
  return cell(container, `myrmidon-board-lease-${name}`);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount());
  }
  roots = [];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("board lease contract fixtures (the mock for part A of OPE-5413)", () => {
  it("multi-process: parses into the block's read model", () => {
    const state = parseBoardLeasesState(leasesFixture);
    expect(state.leases.map((lease) => lease.name)).toEqual(["scheduler", "backup", "botops"]);
    expect(state.selfBootId).toBe("boot-aaa111");
    expect(state.serverTime).toBe("2026-10-08T21:00:29.000Z");
    expect(state.leases[0]?.holder?.hostname).toBe("board-1");
    expect(state.leases[0]?.epoch).toBe(12);
    // A lease whose board_processes row is gone still shows up.
    expect(state.leases[2]?.holder).toBeNull();
  });

  it("single process: one lease held by the running process", () => {
    const state = parseBoardLeasesState(singleProcessFixture);
    expect(state.leases).toHaveLength(1);
    expect(state.leases[0]?.name).toBe("scheduler");
    expect(leaseIsSelf(state.leases[0]!, state.selfBootId)).toBe(true);
  });

  it("tolerates a bare array, a stringified bigint epoch and missing fields", () => {
    const state = parseBoardLeasesState([
      { name: "scheduler", epoch: "42", holderBootId: "boot-ccc333" },
      { name: "  " },
      { epoch: 7 },
    ]);
    expect(state.leases).toHaveLength(1);
    expect(state.leases[0]?.epoch).toBe(42);
    expect(state.leases[0]?.holder).toBeNull();
    expect(state.leases[0]?.expiresAt).toBeNull();
    expect(state.selfBootId).toBeNull();
  });

  it("never throws on a malformed body", () => {
    expect(parseBoardLeasesState(null).leases).toEqual([]);
    expect(parseBoardLeasesState("nope").leases).toEqual([]);
    expect(parseBoardLeasesState({ leases: "nope" }).leases).toEqual([]);
  });

  it("keeps the en and ru catalogues in step", () => {
    const en = (enCatalog as unknown as { boardLeases: Record<string, string> }).boardLeases;
    const ru = (ruCatalog as unknown as { boardLeases: Record<string, string> }).boardLeases;
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
    expect(Object.values(ru).every((value) => value.trim().length > 0)).toBe(true);
  });
});

describe("leader lease block", () => {
  it("shows the holder, the epoch, the lifetime and who is the leader", async () => {
    stubGet(parseBoardLeasesState(leasesFixture));
    const { container } = await renderPanel();
    const text = container.textContent ?? "";

    expect(cell(container, "myrmidon-board-leases")).not.toBeNull();
    expect(text).toContain("Scheduler (background runs)");
    // holder: hostname, pid and the boot id, straight from board_processes
    expect(text).toContain("board-1");
    expect(text).toContain("pid 4242");
    expect(text).toContain("boot-aaa");
    expect(text).toContain("role worker");
    // epoch, acquired_at and expires_at of the scheduler lease
    expect(text).toContain("12");
    expect(text).toContain("2026-10-08 21:00:00 UTC");
    expect(text).toContain("2026-10-08 21:00:30 UTC");
    // the three leases of the fixture are all rendered
    expect(cell(container, "myrmidon-board-leases-rows")?.children).toHaveLength(3);

    // "I am the leader" is per lease: this process holds scheduler, another one
    // holds backup, and the third lease has nothing left to compare against.
    expect(cell(row(container, "scheduler")!, "myrmidon-board-lease-self")?.textContent).toContain(
      "I am the leader",
    );
    expect(cell(row(container, "backup")!, "myrmidon-board-lease-self")?.textContent).toContain(
      "Another process",
    );
    expect(cell(row(container, "botops")!, "myrmidon-board-lease-self")?.textContent).toContain("Unknown");
    // ... and a lease whose process row is gone says so instead of printing nothing
    expect(cell(row(container, "botops")!, "myrmidon-board-lease-self")?.dataset.state).toBe("unknown");
    expect(row(container, "botops")?.textContent).toContain("No matching board process row");
    expect(text).toContain("Refreshed 2026-10-08 21:00:29 UTC");
  });

  it("marks an expired lease and leaves the live one alone", async () => {
    stubGet(parseBoardLeasesState(leasesFixture));
    const { container } = await renderPanel();
    const backup = cell(row(container, "backup")!, "myrmidon-board-lease-expiry");
    const scheduler = cell(row(container, "scheduler")!, "myrmidon-board-lease-expiry");

    expect(backup?.dataset.state).toBe("expired");
    expect(backup?.textContent).toBe("Expired");
    expect(scheduler?.dataset.state).toBe("active");
    expect(scheduler?.textContent).toBe("Active");
  });

  it("flips a lease to expired on the clock alone", async () => {
    const state = parseBoardLeasesState(singleProcessFixture);
    const container = mount(<BoardLeasesView data={state} loading={false} error={null} now={NOW} />, newClient());
    await settle();
    expect(cell(row(container, "scheduler")!, "myrmidon-board-lease-expiry")?.dataset.state).toBe("active");

    const late = mount(
      <BoardLeasesView
        data={state}
        loading={false}
        error={null}
        now={Date.parse("2026-10-08T21:00:31.000Z")}
      />,
      newClient(),
    );
    await settle();
    expect(cell(row(late, "scheduler")!, "myrmidon-board-lease-expiry")?.dataset.state).toBe("expired");
    expect(late.textContent).toContain("Expired");
  });

  it("keeps the default single-process board to one lease row", async () => {
    stubGet(parseBoardLeasesState(singleProcessFixture));
    const { container } = await renderPanel();
    const rows = cell(container, "myrmidon-board-leases-rows");
    expect(rows?.children).toHaveLength(1);
    expect(rows?.textContent).toContain("board-solo");
    expect(cell(row(container, "scheduler")!, "myrmidon-board-lease-self")?.dataset.state).toBe("yes");
  });

  it("says 'no lease' when the list is empty instead of rendering nothing", async () => {
    stubGet({ leases: [], selfBootId: null, serverTime: null });
    const { container } = await renderPanel();
    expect(cell(container, "myrmidon-board-leases-empty")?.textContent).toContain("No lease is held right now.");
    expect(cell(container, "myrmidon-board-leases-rows")).toBeNull();
  });

  it("shows 'no data' when the endpoint is unavailable, without taking the panel down", async () => {
    stubGet(new ApiError("lease route missing", 404, null));
    const { container } = await renderPanel();

    expect(cell(container, "myrmidon-board-leases-nodata")?.textContent).toContain("No data");
    expect(cell(container, "myrmidon-board-leases-nodata-status")?.textContent).toContain("404");
    expect(cell(container, "myrmidon-board-leases-rows")).toBeNull();
    // the block itself is still there: the surrounding "Процессы" panel survives
    expect(cell(container, "myrmidon-board-leases")).not.toBeNull();
    expect(cell(container, "myrmidon-board-leases-updated")).not.toBeNull();
  });

  it("subscribes to updates: one query, polled every 10 s", async () => {
    stubGet(parseBoardLeasesState(singleProcessFixture));
    const { queryClient } = await renderPanel();
    const queries = queryClient.getQueryCache().findAll({ queryKey: boardLeasesQueryKey });
    expect(queries).toHaveLength(1);
    const options = queries[0]?.options as { refetchInterval?: number } | undefined;
    expect(options?.refetchInterval).toBe(10_000);
    expect(BOARD_LEASES_REFETCH_MS).toBe(10_000);
    expect(vi.mocked(boardLeasesApi.get)).toHaveBeenCalledTimes(1);
  });
});

describe("lease helpers", () => {
  it("reads expiry from the server verdict first, the timestamp second", () => {
    expect(leaseExpiryState({ expired: true, expiresAt: null }, NOW)).toBe("expired");
    expect(leaseExpiryState({ expired: false, expiresAt: "2026-10-08T21:00:30.000Z" }, NOW)).toBe("active");
    expect(leaseExpiryState({ expired: null, expiresAt: "2026-10-08T20:59:30.000Z" }, NOW)).toBe("expired");
    expect(leaseExpiryState({ expired: null, expiresAt: "nope" }, NOW)).toBe("unknown");
    expect(leaseExpiryState({ expired: null, expiresAt: null }, NOW)).toBe("unknown");
  });

  it("trusts the server's isSelf over the boot id comparison", () => {
    expect(leaseIsSelf({ isSelf: false, holderBootId: "boot-aaa111" }, "boot-aaa111")).toBe(false);
    expect(leaseIsSelf({ isSelf: null, holderBootId: "boot-aaa111" }, "boot-aaa111")).toBe(true);
    expect(leaseIsSelf({ isSelf: null, holderBootId: "boot-bbb222" }, "boot-aaa111")).toBe(false);
    expect(leaseIsSelf({ isSelf: null, holderBootId: null }, "boot-aaa111")).toBeNull();
    expect(leaseIsSelf({ isSelf: null, holderBootId: "boot-bbb222" }, null)).toBeNull();
  });

  it("recognises only the handover event", () => {
    expect(isLeaderChangedEvent({ type: "leader_changed", payload: { name: "scheduler" } })).toBe(true);
    expect(isLeaderChangedEvent({ type: "activity.logged" })).toBe(false);
    expect(isLeaderChangedEvent(null)).toBe(false);
    expect(isLeaderChangedEvent("leader_changed")).toBe(false);
  });

  it("formats lease timestamps in UTC so the panel reads the same everywhere", () => {
    expect(formatLeaseTimestamp("2026-10-08T21:00:00.000Z")).toBe("2026-10-08 21:00:00 UTC");
    expect(formatLeaseTimestamp(null)).toBeNull();
    expect(formatLeaseTimestamp("not a date")).toBeNull();
  });
});