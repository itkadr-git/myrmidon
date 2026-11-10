// ui/src/ui2/screens/settings/system/Ui2DatastoreRetentionSettings.myrmidon.test.tsx
//
// myrmidon(OPE-12613): guard for the "Database storage" retention settings
// panel (DB-SIZE). GET /api/myrmidon/datastore-care answers the resolved
// retention values with sources and the last compaction pass state. Editing
// is instance-admin only (server-side assertInstanceAdmin), mirrored in the
// UI through currentBoardAccess: a non-admin gets disabled inputs and NO
// Save button. A dirty draft sends ONE PATCH with only the changed fields;
// Reset sends explicit nulls. 0 days renders a warning that compaction is off.
// A 403 on GET renders the denied state.

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2DatastoreRetentionSettings } from "./Ui2DatastoreRetentionSettings";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";
import type { DatastoreCareRetentionView } from "@/api/myrmidonDatastoreCare";

const mockDatastoreCareApi = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

vi.mock("@/api/myrmidonDatastoreCare", () => ({
  datastoreCareApi: mockDatastoreCareApi,
  datastoreCareQueryKey: ["myrmidon", "datastore-care"] as const,
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

const mockGet = mockDatastoreCareApi.get;
const mockUpdate = mockDatastoreCareApi.update;
const mockGetAccess = mockAccessApi.getCurrentBoardAccess;

function defaultView(): DatastoreCareRetentionView {
  return {
    retention: {
      heartbeatRunContextDays: 7,
      source: "default",
      contextCompactMaxBatches: 10,
      contextCompactMaxBatchesSource: "default",
      externalMachineBackup: false,
    },
    lastRun: {
      lastRunAt: "2026-11-09T12:00:00.000Z",
      waitingForBackup: false,
      backupCheckedAt: "2026-11-09T12:00:00.000Z",
      lastCompacted: 42,
      lastFreedBytes: 1048576,
      compactedTotal: 100,
      freedBytesTotal: 5242880,
    },
  };
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

describe("myrmidon(UI2) Ui2DatastoreRetentionSettings panel", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  async function renderPanel(locale: "en" | "ru" = "en") {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale={locale}>
            <Ui2DatastoreRetentionSettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockGet.mockResolvedValue(defaultView());
    mockUpdate.mockReset();
    // Default user is instance admin
    mockGetAccess.mockResolvedValue({
      user: { id: "user-1", email: "admin@example.com", name: "Admin", image: null },
      userId: "user-1",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
      source: "session",
      keyId: null,
    });
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders values, sources and the last pass from the GET answer", async () => {
    await renderPanel();

    expect(mockGet).toHaveBeenCalledTimes(1);

    const daysInput = container.querySelector<HTMLInputElement>("#ui2-retention-days");
    expect(daysInput?.value).toBe("7");

    const batchesInput = container.querySelector<HTMLInputElement>("#ui2-retention-batches");
    expect(batchesInput?.value).toBe("10");

    const externalCheck = container.querySelector<HTMLInputElement>("#ui2-retention-external");
    expect(externalCheck?.checked).toBe(false);

    // Sources
    const sources = container.querySelectorAll(".ui2-retention-source");
    expect(sources.length).toBe(2);
    expect(sources[0]?.textContent).toContain("Default");
    expect(sources[1]?.textContent).toContain("Default");

    // Last run facts
    const facts = container.querySelector(".ui2-retention-lastrun-facts");
    expect(facts).not.toBeNull();
    expect(facts?.textContent).toContain("42");
    expect(facts?.textContent).toContain("1 MB");
  });

  it("admin changes days: sends ONE partial PATCH with only the changed field", async () => {
    await renderPanel();

    const daysInput = container.querySelector<HTMLInputElement>("#ui2-retention-days")!;
    flushSync(() => {
      setNativeValue(daysInput, "14");
    });
    await flushReact();

    const save = container.querySelector<HTMLButtonElement>(".ui2-retention-save")!;
    expect(save.disabled).toBe(false);

    mockUpdate.mockResolvedValue({ heartbeatRunContextDays: 14 });
    save.click();
    await flushReact();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // Acceptance: PATCH contains ONLY the field that was changed
    expect(mockUpdate).toHaveBeenCalledWith({ heartbeatRunContextDays: 14 });
  });

  it("non-admin sees no active Save button and receives a read-only note", async () => {
    mockGetAccess.mockResolvedValue({
      user: { id: "user-2", email: "member@example.com", name: "Member", image: null },
      userId: "user-2",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      source: "session",
      keyId: null,
    });

    await renderPanel();

    // Inputs disabled
    expect(container.querySelector<HTMLInputElement>("#ui2-retention-days")?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#ui2-retention-batches")?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#ui2-retention-external")?.disabled).toBe(true);

    // Acceptance: non-admin does NOT see an active Save button (button is absent)
    expect(container.querySelector(".ui2-retention-save")).toBeNull();
    expect(container.querySelector(".ui2-retention-reset")).toBeNull();
    expect(container.textContent).toContain("Only an instance admin can edit these settings.");
  });

  it("shows the warning when days value is 0", async () => {
    await renderPanel();

    expect(container.querySelector(".ui2-retention-days-warning")).toBeNull();

    const daysInput = container.querySelector<HTMLInputElement>("#ui2-retention-days")!;
    flushSync(() => {
      setNativeValue(daysInput, "0");
    });
    await flushReact();

    const warning = container.querySelector(".ui2-retention-days-warning");
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain("0 days: compaction is off — run context is kept forever.");
  });

  it("reset sends null for all fields to clear them back to env/default", async () => {
    const settingsView = defaultView();
    settingsView.retention.heartbeatRunContextDays = 14;
    settingsView.retention.source = "settings";
    settingsView.retention.contextCompactMaxBatchesSource = "settings";
    mockGet.mockResolvedValueOnce(settingsView).mockResolvedValueOnce(defaultView());

    await renderPanel();

    expect(container.querySelectorAll(".ui2-retention-source")[0]?.textContent).toContain("Saved");

    const reset = container.querySelector<HTMLButtonElement>(".ui2-retention-reset")!;
    mockUpdate.mockResolvedValue({});
    reset.click();
    await flushReact();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({
      heartbeatRunContextDays: null,
      contextCompactMaxBatches: null,
      externalMachineBackup: null,
    });
    expect(container.querySelectorAll(".ui2-retention-source")[0]?.textContent).toContain("Default");
  });

  it("renders denied state on 403 GET error", async () => {
    const error = new Error("Forbidden") as Error & { status?: number };
    error.status = 403;
    mockGet.mockRejectedValue(error);

    await renderPanel();

    expect(container.querySelector('[data-testid="ui2-denied-state"]')).not.toBeNull();
    expect(container.textContent).toContain("Access denied");
  });

  it("renders properly in Russian without missing keys", async () => {
    await renderPanel("ru");

    expect(container.textContent).toContain("Хранение данных базы");
    expect(container.textContent).toContain("Срок хранения контекста прогонов (дней)");
    expect(container.textContent).toContain("По умолчанию");
    expect(container.textContent).toContain("Последний проход уплотнения");
    expect(container.querySelector(".ui2-retention-save")?.textContent).toBe("Сохранить");
    expect(container.querySelector(".ui2-retention-reset")?.textContent).toBe(
      "Сбросить к значениям по умолчанию",
    );
  });
});
