// @vitest-environment jsdom
//
// myrmidon(1.6.5-BOT-DISK-H4d): "working copy" / "archive" lines on a task.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import diskReportFixture from "../../../../docs/myrmidon/bot-disk-contract/disk-report.json";
import { BotDiskWorkspaceRow } from "./BotDiskWorkspaceRow";
import { botDiskLifecycleApi } from "./botDiskLifecycleApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.parse(diskReportFixture.at) + 10 * 60 * 1000;

function renderRow(issueKey: string): HTMLDivElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <QueryClientProvider client={queryClient}>
      <BotDiskWorkspaceRow issueKey={issueKey} now={now} />
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

describe("BotDiskWorkspaceRow", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    await i18n.changeLanguage("en");
  });

  it("shows bot, path and state of the working copy", async () => {
    vi.spyOn(botDiskLifecycleApi, "getReports").mockResolvedValue({ reports: [diskReportFixture] } as never);
    const container = renderRow("ABC-101");
    await settle();
    const text = container.querySelector('[data-testid="bot-disk-workspace-copy"]')?.textContent ?? "";
    expect(text).toContain("Working copy");
    expect(text).toContain("bot-001, /workspace/ABC-101, clean, pushed");
    expect(container.querySelector('[data-testid="bot-disk-workspace-archive"]')).toBeNull();
  });

  it("shows the archive with path, size and retention", async () => {
    vi.spyOn(botDiskLifecycleApi, "getReports").mockResolvedValue({ reports: [diskReportFixture] } as never);
    const container = renderRow("ABC-099");
    await settle();
    const text = container.querySelector('[data-testid="bot-disk-workspace-archive"]')?.textContent ?? "";
    expect(text).toContain("/data/hermes/.myrmidon/archive/ABC-099-20261006T140100Z.bundle");
    expect(text).toContain("2.3 MiB");
    expect(text).toContain("kept until 2026-11-05");
  });

  it("renders nothing for a task without copies, with no data, or on an old report", async () => {
    vi.spyOn(botDiskLifecycleApi, "getReports").mockResolvedValue({ reports: [diskReportFixture] } as never);
    const other = renderRow("ZZZ-1");
    await settle();
    expect(other.innerHTML).toBe("");
    vi.spyOn(botDiskLifecycleApi, "getReports").mockRejectedValue(new Error("404"));
    const failed = renderRow("ABC-101");
    await settle();
    expect(failed.innerHTML).toBe("");
    vi.spyOn(botDiskLifecycleApi, "getReports").mockResolvedValue({ reports: [{ botKey: "bot-old", at: diskReportFixture.at }] } as never);
    const old = renderRow("ABC-101");
    await settle();
    expect(old.innerHTML).toBe("");
  });

  it("renders in Russian", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(botDiskLifecycleApi, "getReports").mockResolvedValue({ reports: [diskReportFixture] } as never);
    const container = renderRow("ABC-099");
    await settle();
    expect(container.textContent).toContain("Архив");
    expect(container.textContent).toContain("хранится до");
    await i18n.changeLanguage("en");
  });
});
