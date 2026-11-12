// @vitest-environment jsdom
//
// myrmidon(SETTINGS-UI A): the "Workspace hygiene" settings panel — the quota
// draft parse (empty means "the cap is off", a typo cannot save), the save
// path, the per-key source label and the last-sweep status. Neutral data only.
// myrmidon(1.6.7 SETTINGS-UI, OPE-6249): the panel is mounted on Instance →
// General; its source labels and the 403 sentence go through i18n (en + ru),
// and the container (query + mutation) is covered against a stubbed API.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { i18n } from "@/i18n";
import {
  WorkspaceHygieneSettingsPanel,
  WorkspaceHygieneSettingsPanelView,
  parseWorkspaceHygieneDraft,
} from "./WorkspaceHygieneSettingsPanel";
import {
  describeWorkspaceHygieneError,
  workspaceHygieneSettingsApi,
  type WorkspaceHygieneSettingsView,
} from "./workspaceHygieneSettingsApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

const VIEW: WorkspaceHygieneSettingsView = {
  quota: {
    workspaceQuotaMb: 2048,
    totalQuotaMb: null,
    sources: { workspaceQuotaMb: "settings", totalQuotaMb: "default" },
  },
  workspaces: [
    {
      id: "ws-1",
      name: "ws-alpha",
      status: "active",
      sizeBytes: 3 * 1024 * 1024,
      sizeMb: 3,
      measuredAt: "2026-10-08T00:00:00.000Z",
      overQuota: false,
      truncated: false,
    },
  ],
  status: {
    measuredWorkspaces: 1,
    overQuotaCount: 0,
    totalSizeMb: 3,
    lastSweepAt: "2026-10-08T00:00:00.000Z",
    lastSweep: null,
  },
};

function renderView(overrides: Partial<Parameters<typeof WorkspaceHygieneSettingsPanelView>[0]> = {}) {
  const onSave = vi.fn();
  const props = { view: VIEW, onSave, pending: false, error: null, ...overrides };
  act(() => {
    root.render(<WorkspaceHygieneSettingsPanelView {...props} />);
  });
  return { onSave };
}

function input(id: string) {
  return container.querySelector<HTMLInputElement>(`#${id}`)!;
}

function setText(id: string, value: string) {
  const el = input(id);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function save() {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Save workspace hygiene quotas"),
  )!;
  act(() => button.click());
}

describe("parseWorkspaceHygieneDraft", () => {
  it("treats an empty field as the cap being off", () => {
    const { patch, errors } = parseWorkspaceHygieneDraft({
      workspaceQuotaMb: "",
      totalQuotaMb: "",
    });
    expect(errors).toEqual({});
    expect(patch).toEqual({ workspaceQuotaMb: null, totalQuotaMb: null });
  });

  it("refuses a non-integer or a zero quota", () => {
    const { patch, errors } = parseWorkspaceHygieneDraft({
      workspaceQuotaMb: "1.5",
      totalQuotaMb: "0",
    });
    expect(patch).toBeNull();
    expect(errors.workspaceQuotaMb).toBeTruthy();
    expect(errors.totalQuotaMb).toBeTruthy();
  });

  it("keeps a whole positive number", () => {
    const { patch } = parseWorkspaceHygieneDraft({
      workspaceQuotaMb: "2048",
      totalQuotaMb: "10240",
    });
    expect(patch).toEqual({ workspaceQuotaMb: 2048, totalQuotaMb: 10240 });
  });
});

describe("WorkspaceHygieneSettingsPanelView", () => {
  it("renders the stored quotas and the per-key source of each value", () => {
    renderView();
    expect(input("workspace-hygiene-workspaceQuotaMb").value).toBe("2048");
    expect(input("workspace-hygiene-totalQuotaMb").value).toBe("");
    expect(
      container.querySelector("[data-testid='workspace-hygiene-source-workspaceQuotaMb']")!
        .textContent,
    ).toBe("Saved here");
    expect(
      container.querySelector("[data-testid='workspace-hygiene-source-totalQuotaMb']")!.textContent,
    ).toBe("Default");
  });

  it("saves the edited quotas through the patch shape the API takes", () => {
    const { onSave } = renderView();
    setText("workspace-hygiene-totalQuotaMb", "4096");
    save();
    expect(onSave).toHaveBeenCalledWith({
      workspaceQuotaMb: 2048,
      totalQuotaMb: 4096,
    });
  });

  it("refuses to save a typo and shows the field error", () => {
    const { onSave } = renderView();
    setText("workspace-hygiene-workspaceQuotaMb", "many");
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-testid='workspace-hygiene-error-workspaceQuotaMb']")!.textContent,
    ).toBeTruthy();
  });

  it("reports the last sweep: measured workspaces, over quota, total size", () => {
    renderView();
    expect(container.querySelector("[data-testid='workspace-hygiene-measured']")!.textContent).toBe(
      "1",
    );
    expect(container.querySelector("[data-testid='workspace-hygiene-over-quota']")!.textContent).toBe(
      "0",
    );
    expect(container.querySelector("[data-testid='workspace-hygiene-total-mb']")!.textContent).toBe(
      "3 MB",
    );
    const row = container.querySelector("[data-testid='workspace-hygiene-workspace-row']")!;
    expect(row.textContent).toContain("ws-alpha");
    expect(row.textContent).toContain("3 MB");
  });
});

describe("WorkspaceHygieneSettingsPanelView in Russian", () => {
  it("renders the title, the save button and the per-key source labels in Russian", async () => {
    await i18n.changeLanguage("ru");
    renderView({
      view: {
        ...VIEW,
        quota: {
          ...VIEW.quota,
          sources: { workspaceQuotaMb: "env", totalQuotaMb: "default" },
        },
      },
    });
    expect(container.querySelector("h2")!.textContent).toBe("Чистота рабочих пространств");
    expect(
      container.querySelector("[data-testid='workspace-hygiene-source-workspaceQuotaMb']")!
        .textContent,
    ).toBe("Переопределено окружением");
    expect(
      container.querySelector("[data-testid='workspace-hygiene-source-totalQuotaMb']")!.textContent,
    ).toBe("По умолчанию");
    expect(
      [...container.querySelectorAll("button")].some((b) =>
        b.textContent?.includes("Сохранить пределы рабочих пространств"),
      ),
    ).toBe(true);
  });

  it("shows the stored source in Russian", async () => {
    await i18n.changeLanguage("ru");
    renderView();
    expect(
      container.querySelector("[data-testid='workspace-hygiene-source-workspaceQuotaMb']")!
        .textContent,
    ).toBe("Сохранено здесь");
  });
});

describe("describeWorkspaceHygieneError", () => {
  it("turns a 403 into the instance-admin sentence, in both languages", async () => {
    const forbidden = new ApiError("Instance admin access required", 403, null);
    expect(describeWorkspaceHygieneError(forbidden, "fallback")).toBe(
      "Instance admin rights are required.",
    );
    await i18n.changeLanguage("ru");
    expect(describeWorkspaceHygieneError(forbidden, "fallback")).toBe(
      "Нужны права администратора экземпляра.",
    );
  });

  it("keeps the server message for any other failure and falls back when there is none", () => {
    expect(describeWorkspaceHygieneError(new ApiError("Validation error", 400, null), "fallback")).toBe(
      "Validation error",
    );
    expect(describeWorkspaceHygieneError("boom", "fallback")).toBe("fallback");
  });
});

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceHygieneSettingsPanel />
      </QueryClientProvider>,
    );
  });
}

describe("WorkspaceHygieneSettingsPanel (query + mutation)", () => {
  it("loads the values from GET /myrmidon/workspace-hygiene and renders them", async () => {
    const get = vi.spyOn(workspaceHygieneSettingsApi, "get").mockResolvedValue(VIEW);
    renderPanel();
    await settle();
    expect(get).toHaveBeenCalled();
    expect(input("workspace-hygiene-workspaceQuotaMb").value).toBe("2048");
    expect(input("workspace-hygiene-totalQuotaMb").value).toBe("");
  });

  it("sends the edited quotas through PATCH and reloads the view", async () => {
    const get = vi.spyOn(workspaceHygieneSettingsApi, "get").mockResolvedValue(VIEW);
    const update = vi.spyOn(workspaceHygieneSettingsApi, "update").mockResolvedValue({
      ...VIEW,
      quota: {
        workspaceQuotaMb: 2048,
        totalQuotaMb: 4096,
        sources: { workspaceQuotaMb: "settings", totalQuotaMb: "settings" },
      },
    });
    renderPanel();
    await settle();
    setText("workspace-hygiene-totalQuotaMb", "4096");
    save();
    await settle();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toEqual({ workspaceQuotaMb: 2048, totalQuotaMb: 4096 });
    // The save invalidates the query, so the panel asks the server again.
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector("[data-testid='workspace-hygiene-save-error']")).toBeNull();
  });

  it("explains a 403 on save: instance admin rights are required", async () => {
    vi.spyOn(workspaceHygieneSettingsApi, "get").mockResolvedValue(VIEW);
    vi.spyOn(workspaceHygieneSettingsApi, "update").mockRejectedValue(
      new ApiError("Instance admin access required", 403, null),
    );
    renderPanel();
    await settle();
    setText("workspace-hygiene-totalQuotaMb", "4096");
    save();
    await settle();
    expect(
      container.querySelector("[data-testid='workspace-hygiene-save-error']")!.textContent,
    ).toBe("Instance admin rights are required.");
  });

  it("explains a 403 on save in Russian", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(workspaceHygieneSettingsApi, "get").mockResolvedValue(VIEW);
    vi.spyOn(workspaceHygieneSettingsApi, "update").mockRejectedValue(
      new ApiError("Instance admin access required", 403, null),
    );
    renderPanel();
    await settle();
    setText("workspace-hygiene-totalQuotaMb", "4096");
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Сохранить пределы рабочих пространств"),
    )!;
    act(() => button.click());
    await settle();
    expect(
      container.querySelector("[data-testid='workspace-hygiene-save-error']")!.textContent,
    ).toBe("Нужны права администратора экземпляра.");
  });

  it("shows another save failure with the server's own message", async () => {
    vi.spyOn(workspaceHygieneSettingsApi, "get").mockResolvedValue(VIEW);
    vi.spyOn(workspaceHygieneSettingsApi, "update").mockRejectedValue(
      new ApiError("Request failed: 500", 500, null),
    );
    renderPanel();
    await settle();
    setText("workspace-hygiene-totalQuotaMb", "4096");
    save();
    await settle();
    expect(
      container.querySelector("[data-testid='workspace-hygiene-save-error']")!.textContent,
    ).toBe("Request failed: 500");
  });

  it("explains a 403 on load too", async () => {
    vi.spyOn(workspaceHygieneSettingsApi, "get").mockRejectedValue(
      new ApiError("Forbidden", 403, null),
    );
    renderPanel();
    await settle();
    expect(
      container.querySelector("[data-testid='workspace-hygiene-load-error']")!.textContent,
    ).toBe("Instance admin rights are required.");
  });
});
