// @vitest-environment jsdom
// myrmidon(1.6.6 PROCS-0.1): the «Процессы» panel. Pins what an operator reads
// off it: the current process with its role and measurements, a stale process
// marked as such, the empty/error states, and the label helpers that decide how
// each line is worded.
//
// OPE-7003 (OPE-6875 ч.I) extends the pins: rows are grouped by role in the
// operator's reading order (api → worker → all → the rest), every row carries
// a ready verdict and a restart count derived from the registry rows, and a
// single live process renders as one row without errors.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { i18n } from "@/i18n";
import {
  BoardProcessesSettingsPanel,
  boardProcessRestartCount,
  describeBoardProcessRole,
  formatBoardProcessAge,
  formatBoardProcessBytes,
  formatBoardProcessLag,
  groupBoardProcessesByRole,
} from "./BoardProcessesSettingsPanel";
import * as boardProcessesApiModule from "./boardProcessesApi";
import type { BoardProcessesView } from "./boardProcessesApi";

const en = (key: string, options?: Record<string, unknown>) => {
  const strings: Record<string, string> = {
    "processes.title": "Board processes",
    "processes.loading": "Loading processes…",
    "processes.empty": "No board process has reported yet. A process writes its row right after it starts.",
    "processes.error": "Could not read the process registry. Try again.",
    "processes.self": "this process",
    "processes.selfMissing": "This process has no row yet: the pulse writes it once the registry is up.",
    "processes.ageSeconds": "{{seconds}} s ago",
    "processes.ageMinutes": "{{minutes}} min ago",
    "processes.ageHours": "{{hours}} h ago",
    "processes.pidHost": "{{pid}} on {{host}}",
    "processes.cadence": "Pulse every {{pulse}} s; a row older than {{stale}} s is stale.",
    "processes.role.all": "board (single)",
    "processes.role.api": "API",
    "processes.role.worker": "worker",
    "processes.readyYes": "ready",
    "processes.readyNo": "not ready",
    "processes.restartCount": "{{count}}",
    "processes.groupSummary": "{{role}} — {{ready}} of {{count}} ready",
  };
  const template = strings[key] ?? key;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => String(options?.[name] ?? ""));
};

const view: BoardProcessesView = {
  selfBootId: "boot-self-0001",
  pulseSeconds: 10,
  staleAfterSeconds: 120,
  processes: [
    {
      bootId: "boot-self-0001",
      role: "all",
      pid: 4242,
      hostname: "board-1",
      container: "ctr-a",
      version: "1.6.6",
      startedAt: "2026-10-08T11:00:00.000Z",
      lastSeenAt: "2026-10-08T11:59:55.000Z",
      uptimeSeconds: 3600,
      ageSeconds: 5,
      apiPort: 3100,
      eventLoopLagMs: 8.4,
      rssBytes: 512_000_000,
      status: "live",
      self: true,
    },
    {
      bootId: "boot-gone-0002",
      role: "api",
      pid: 5,
      hostname: "board-2",
      container: null,
      version: "1.6.6",
      startedAt: "2026-10-08T10:00:00.000Z",
      lastSeenAt: "2026-10-08T11:50:00.000Z",
      uptimeSeconds: 7200,
      ageSeconds: 600,
      apiPort: null,
      eventLoopLagMs: null,
      rssBytes: null,
      status: "stale",
      self: false,
    },
  ],
};

function renderPanel(): HTMLDivElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <QueryClientProvider client={queryClient}>
      <BoardProcessesSettingsPanel />
    </QueryClientProvider>,
  );
  return container;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

const text = (container: HTMLDivElement, testId: string) =>
  container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

describe("BoardProcessesSettingsPanel", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    await i18n.changeLanguage("en");
  });

  it("shows every process grouped by role with the metrics of its last pulse", async () => {
    vi.spyOn(boardProcessesApiModule.boardProcessesApi, "list").mockResolvedValue(view);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="board-processes-table"]')));

    const rows = container.querySelectorAll('[data-testid^="board-process-row-"]');
    expect(rows).toHaveLength(2);
    // OPE-7003: api sorts before the all-in-one row of a single process.
    expect(rows[0].getAttribute("data-testid")).toBe("board-process-row-boot-gone-0002");
    expect(rows[1].getAttribute("data-testid")).toBe("board-process-row-boot-self-0001");
    // Group headers carry the ready/total summary of the role.
    expect(text(container, "board-process-group-header-api")).toBe("API — 0 of 1 ready");
    expect(text(container, "board-process-group-header-all")).toBe("board (single) — 1 of 1 ready");

    const selfRow = container.querySelector('[data-testid="board-process-row-boot-self-0001"]')!;
    expect(selfRow.querySelector('[data-testid="board-process-role"]')?.textContent).toBe("board (single)");
    expect(selfRow.querySelector('[data-testid="board-process-boot"]')?.textContent).toBe("boot-selthis process");
    expect(selfRow.querySelector('[data-testid="board-process-uptime"]')?.textContent).toBe("1 h ago");
    expect(selfRow.querySelector('[data-testid="board-process-pulse"]')?.textContent).toBe("5 s ago");
    expect(selfRow.querySelector('[data-testid="board-process-lag"]')?.textContent).toBe("8.4");
    expect(selfRow.querySelector('[data-testid="board-process-rss"]')?.textContent).toBe("488 MB");
    expect(selfRow.querySelector('[data-testid="board-process-ready"]')?.textContent).toBe("ready");
    expect(selfRow.querySelector('[data-testid="board-process-restarts"]')?.textContent).toBe("1");
    expect(container.querySelector('[data-testid="board-processes-table"]')?.textContent).toContain("3100");

    // The api row is a stale process with no measurements yet: not ready.
    const goneRow = container.querySelector('[data-testid="board-process-row-boot-gone-0002"]')!;
    expect(goneRow.getAttribute("data-stale")).toBe("true");
    expect(goneRow.querySelector('[data-testid="board-process-ready"]')?.textContent).toBe("not ready");
    expect(goneRow.querySelector('[data-testid="board-process-ready"]')?.getAttribute("data-ready")).toBe("false");
    expect(text(container, "board-processes-cadence")).toBe(
      "Pulse every 10 s; a row older than 120 s is stale.",
    );
  });

  it("marks the answering process as such and never as stale", async () => {
    vi.spyOn(boardProcessesApiModule.boardProcessesApi, "list").mockResolvedValue(view);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="board-processes-table"]')));

    const self = container.querySelector('[data-testid="board-process-row-boot-self-0001"]');
    expect(self?.getAttribute("data-self")).toBe("true");
    expect(self?.getAttribute("data-stale")).toBe("false");
    expect(container.querySelector('[data-testid="board-processes-self-missing"]')).toBeNull();
  });

  it("warns when this process has no row of its own yet", async () => {
    vi.spyOn(boardProcessesApiModule.boardProcessesApi, "list").mockResolvedValue({
      ...view,
      processes: [view.processes[1]],
    });
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="board-processes-self-missing"]')));
    expect(text(container, "board-processes-self-missing")).toContain("has no row yet");
  });

  it("says so when nothing has reported, and when the registry cannot be read", async () => {
    vi.spyOn(boardProcessesApiModule.boardProcessesApi, "list").mockResolvedValue({
      ...view,
      processes: [],
    });
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="board-processes-empty"]')));
    expect(text(container, "board-processes-empty")).toContain("has reported yet");

    vi.restoreAllMocks();
    document.body.innerHTML = "";
    vi.spyOn(boardProcessesApiModule.boardProcessesApi, "list").mockRejectedValue(new Error("nope"));
    const failing = renderPanel();
    await waitFor(() => Boolean(failing.querySelector('[data-testid="board-processes-error"]')));
    expect(failing.querySelector('[data-testid="board-processes-table"]')).toBeNull();
  });

  it("reads in Russian too: the fork catalog carries every line of the panel", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(boardProcessesApiModule.boardProcessesApi, "list").mockResolvedValue(view);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="board-processes-table"]')));
    expect(text(container, "board-processes-title")).toBe("Процессы доски");
    const selfRow = container.querySelector('[data-testid="board-process-row-boot-self-0001"]')!;
    expect(selfRow.querySelector('[data-testid="board-process-role"]')?.textContent).toBe("доска (один процесс)");
    expect(selfRow.querySelector('[data-testid="board-process-ready"]')?.textContent).toBe("готов");
    expect(selfRow.querySelector('[data-testid="board-process-restarts"]')?.textContent).toBe("1");
    expect(selfRow.querySelector('[data-testid="board-process-pulse"]')?.textContent).toBe("5 с назад");
    expect(text(container, "board-process-group-header-all")).toBe("доска (один процесс) — готовы 1 из 1");
    const goneRow = container.querySelector('[data-testid="board-process-row-boot-gone-0002"]')!;
    expect(goneRow.querySelector('[data-testid="board-process-ready"]')?.textContent).toBe("не готов");
    expect(text(container, "board-processes-cadence")).toBe(
      "Пульс раз в 10 с; строка старше 120 с считается устаревшей.",
    );
  });

  it("groups rows by role in the operator's reading order (OPE-7003)", () => {
    const mk = (role: string, bootId: string) => ({ ...view.processes[0], role, bootId });
    const groups = groupBoardProcessesByRole([
      mk("all", "b-all"),
      mk("worker", "b-worker"),
      mk("api", "b-api"),
      mk("watcher", "b-watcher"),
    ]);
    expect(groups.map((g) => g.role)).toEqual(["api", "worker", "all", "watcher"]);
    expect(groupBoardProcessesByRole([])).toEqual([]);
  });

  it("counts restarts from the boot rows of the same role on one host (OPE-7003)", () => {
    const older = {
      ...view.processes[0],
      bootId: "boot-old",
      role: "api",
      hostname: "board-1",
      startedAt: "2026-10-08T10:00:00.000Z",
    };
    const newer = {
      ...view.processes[0],
      bootId: "boot-new",
      role: "api",
      hostname: "board-1",
      startedAt: "2026-10-08T11:30:00.000Z",
    };
    const otherHost = { ...newer, bootId: "boot-else", hostname: "board-9" };
    const all = [newer, older, otherHost];
    expect(boardProcessRestartCount(older, all)).toBe(1);
    expect(boardProcessRestartCount(newer, all)).toBe(2);
    // A boot on another host is its own slot.
    expect(boardProcessRestartCount(otherHost, all)).toBe(1);
    // A single process that never restarted counts one boot.
    expect(boardProcessRestartCount(view.processes[0], [view.processes[0]])).toBe(1);
    expect(boardProcessRestartCount(view.processes[0], [])).toBe(1);
  });

  it("renders a single live process as one ready row without errors (OPE-7003)", async () => {
    vi.spyOn(boardProcessesApiModule.boardProcessesApi, "list").mockResolvedValue({
      ...view,
      processes: [view.processes[0]],
    });
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="board-processes-table"]')));
    expect(container.querySelectorAll('[data-testid^="board-process-row-"]')).toHaveLength(1);
    expect(container.querySelectorAll('tbody[data-testid^="board-process-group-"]')).toHaveLength(1);
    const row = container.querySelector('[data-testid="board-process-row-boot-self-0001"]')!;
    expect(row.querySelector('[data-testid="board-process-ready"]')?.textContent).toBe("ready");
    expect(row.querySelector('[data-testid="board-process-restarts"]')?.textContent).toBe("1");
    expect(container.querySelector('[data-testid="board-processes-error"]')).toBeNull();
  });

  it("words each line: role, age, loop lag and memory", () => {
    expect(describeBoardProcessRole(en, "all")).toBe("board (single)");
    expect(describeBoardProcessRole(en, "api")).toBe("API");
    // A role this release does not know yet shows as it came from the row.
    expect(describeBoardProcessRole(en, "watcher")).toBe("watcher");
    expect(formatBoardProcessAge(en, 5)).toBe("5 s ago");
    expect(formatBoardProcessAge(en, 600)).toBe("10 min ago");
    expect(formatBoardProcessAge(en, 7_200)).toBe("2 h ago");
    expect(formatBoardProcessAge(en, -1)).toBe("0 s ago");
    expect(formatBoardProcessLag(12.5)).toBe("13");
    expect(formatBoardProcessLag(140.4)).toBe("140");
    expect(formatBoardProcessLag(null)).toBe("—");
    expect(formatBoardProcessBytes(512_000_000)).toBe("488 MB");
    expect(formatBoardProcessBytes(64 * 1024 * 1024)).toBe("64 MB");
    expect(formatBoardProcessBytes(4_194_304)).toBe("4.0 MB");
    expect(formatBoardProcessBytes(2 * 1024 * 1024 * 1024)).toBe("2.00 GB");
    expect(formatBoardProcessBytes(2048)).toBe("2 KB");
    expect(formatBoardProcessBytes(null)).toBe("—");
  });
});
