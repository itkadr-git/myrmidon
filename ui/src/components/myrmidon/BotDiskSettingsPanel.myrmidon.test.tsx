// @vitest-environment jsdom
//
// myrmidon(1.6.5-BOT-DISK-H4d): the bot disk lifecycle section of the panel.
// Data are the epic contract fixtures (docs/myrmidon/bot-disk-contract), which
// must pass the contract schemas; the read routes are stubbed.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { wsDiskApiResponseSchema, wsDiskReportSchema } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import diskReportFixture from "../../../../docs/myrmidon/bot-disk-contract/disk-report.json";
import dockergateDiskFixture from "../../../../docs/myrmidon/bot-disk-contract/dockergate-disk.json";
import { BotDiskSettingsPanel } from "./BotDiskSettingsPanel";
import { botDiskApi } from "./botDiskApi";
import { botDiskLifecycleApi } from "./botDiskLifecycleApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const reportAt = Date.parse(diskReportFixture.at);
const settingsView = { settings: { enabled: true, idleTtlMs: 1 }, sources: { enabled: "default", idleTtlMs: "default" } } as never;

function renderPanel(now: number, taskStatuses?: Record<string, string>): HTMLDivElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <QueryClientProvider client={queryClient}>
      <BotDiskSettingsPanel now={now} taskStatuses={taskStatuses} />
    </QueryClientProvider>,
  );
  return container;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function stub(physical: unknown, reports: unknown) {
  vi.spyOn(botDiskApi, "get").mockResolvedValue(settingsView);
  vi.spyOn(botDiskLifecycleApi, "getPhysical").mockImplementation(() =>
    physical instanceof Error ? Promise.reject(physical) : Promise.resolve(physical as never),
  );
  vi.spyOn(botDiskLifecycleApi, "getReports").mockImplementation(() =>
    reports instanceof Error ? Promise.reject(reports) : Promise.resolve(reports as never),
  );
}

describe("bot disk contract fixtures", () => {
  it("pass the C4 and C5 schemas the panel is built on", () => {
    expect(wsDiskReportSchema.safeParse(diskReportFixture).success).toBe(true);
    expect(wsDiskApiResponseSchema.safeParse(dockergateDiskFixture).success).toBe(true);
  });
});

describe("BotDiskSettingsPanel lifecycle section", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    await i18n.changeLanguage("en");
  });

  it("shows the no-data state when the board has nothing (empty or route missing)", async () => {
    stub(new Error("404"), new Error("404"));
    const missing = renderPanel(reportAt);
    await settle();
    expect(missing.querySelector('[data-testid="bot-disk-lifecycle-empty"]')?.textContent).toContain("No data");
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    stub({ ...dockergateDiskFixture, projects: [] }, { reports: [] });
    const empty = renderPanel(reportAt);
    await settle();
    expect(empty.querySelector('[data-testid="bot-disk-partition"]')?.textContent).toContain("/srv/myrmidon-xfs");
    expect(empty.querySelector('[data-testid="bot-disk-bots"] tbody')?.children.length).toBe(0);
  });

  it("shows partition, quota/used, E/G/X counts, archives, report age and image per bot", async () => {
    stub(dockergateDiskFixture, { reports: [diskReportFixture] });
    const container = renderPanel(reportAt + 5 * 60 * 1000, { "ABC-101": "in_progress" });
    await settle();
    const partition = container.querySelector('[data-testid="bot-disk-partition"]')?.textContent ?? "";
    expect(partition).toContain("55.1%");
    const row = container.querySelector('[data-testid="bot-disk-bot-bot-001"]') as HTMLElement;
    expect(row.querySelector('[data-testid="bot-disk-quota-cell"]')?.textContent).toBe("6.0 GiB / 6.0 GiB (100%)");
    expect(row.querySelector('[data-testid="bot-disk-copies-cell"]')?.textContent).toBe("1/1/0");
    expect(row.children[3].textContent).toBe("1");
    expect(row.children[5].textContent).toBe("myr-v1.6.5-rc.5");
    const report = row.querySelector('[data-testid="bot-disk-report-cell"]') as HTMLElement;
    expect(report.dataset.stale).toBe("false");
    expect(report.textContent).toContain("5 min ago");
    const copies = container.querySelectorAll('[data-testid="bot-disk-copy"]');
    expect(copies).toHaveLength(2);
    expect(copies[0].textContent).toContain("ABC-101");
    expect(copies[0].textContent).toContain("in_progress");
    expect(copies[0].textContent).toContain("bot/ABC-101");
    expect(copies[0].textContent).toContain("clean, pushed");
    expect(copies[1].textContent).toContain("unknown, unknown");
  });

  it("marks a report older than 30 minutes", async () => {
    stub(dockergateDiskFixture, { reports: [diskReportFixture] });
    const container = renderPanel(reportAt + 31 * 60 * 1000);
    await settle();
    const report = container.querySelector('[data-testid="bot-disk-report-cell"]') as HTMLElement;
    expect(report.dataset.stale).toBe("true");
    expect(report.textContent).toContain("stale");
  });

  it("does not fail on an old report without fields, and flags failed self-checks", async () => {
    stub({ partition: undefined, projects: undefined }, { reports: [{ botKey: "bot-old", at: diskReportFixture.at }, { ...diskReportFixture, botKey: "bot-bad", selfChecks: { reflink: false, gitref: true, wsCli: null } }] });
    const container = renderPanel(reportAt + 60 * 1000);
    await settle();
    const old = container.querySelector('[data-testid="bot-disk-bot-bot-old"]') as HTMLElement;
    expect(old.querySelector('[data-testid="bot-disk-copies-cell"]')?.textContent).toBe("—");
    expect(old.querySelector('[data-testid="bot-disk-quota-cell"]')?.textContent).toBe("no quota");
    expect(container.querySelector('[data-testid="bot-disk-bot-bot-bad"]')?.textContent).toContain("Self-check failed: reflink");
  });

  it("renders in Russian", async () => {
    await i18n.changeLanguage("ru");
    stub(dockergateDiskFixture, { reports: [diskReportFixture] });
    const container = renderPanel(reportAt + 31 * 60 * 1000);
    await settle();
    expect(container.querySelector('[data-testid="bot-disk-lifecycle"]')?.textContent).toContain("Диск ботов");
    expect(container.querySelector('[data-testid="bot-disk-report-cell"]')?.textContent).toContain("устарел");
    await i18n.changeLanguage("en");
  });
});
