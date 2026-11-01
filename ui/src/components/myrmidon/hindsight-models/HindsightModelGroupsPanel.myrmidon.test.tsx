// @vitest-environment jsdom
//
// OPE-9858: Component tests for HindsightModelGroupsPanel.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HindsightModelGroupsPanel } from "./HindsightModelGroupsPanel";
import { hindsightModelsApi } from "./hindsightModelsApi";
import type { HindsightModelCatalogView } from "./groupMapping";

const apiMock = vi.hoisted(() => ({
  getCatalog: vi.fn(),
  updateCatalog: vi.fn(),
}));

vi.mock("./hindsightModelsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hindsightModelsApi")>()),
  hindsightModelsApi: apiMock,
}));

function mockCatalog(): HindsightModelCatalogView {
  return {
    groups: [
      {
        role: "write",
        group: "hindsight-write",
        name: "Hindsight Write (память: запись)",
        description: "Извлечение фактов и сохранение воспоминаний",
        model: "gpt-4o-mini",
        defaultModel: "gpt-4o-mini",
        source: "default",
        updatedAt: null,
      },
      {
        role: "summarize",
        group: "hindsight-summarize",
        name: "Hindsight Summarize (память: сведение)",
        description: "Сведение разрозненных фактов и консолидация памяти",
        model: "gpt-4o-mini",
        defaultModel: "gpt-4o-mini",
        source: "default",
        updatedAt: null,
      },
      {
        role: "search",
        group: "hindsight-search",
        name: "Hindsight Search (память: поиск)",
        description: "Семантический поиск и ранжирование",
        model: "gpt-4o-mini",
        defaultModel: "gpt-4o-mini",
        source: "default",
        updatedAt: null,
      },
    ],
    limitations: {
      runtimeDependency: "OPE-9469",
      summary: "Сохраняется без перезапуска.",
      items: ["Hot-reload depends on OPE-9469"],
    },
    status: "mock_stored",
    hotReloadDependency: "OPE-9469",
    hotReloadAvailable: false,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  apiMock.getCatalog.mockReset().mockResolvedValue(mockCatalog());
  apiMock.updateCatalog.mockReset().mockImplementation(async (patch) => {
    const base = mockCatalog();
    if (patch.models?.write) base.groups[0].model = patch.models.write;
    if (patch.models?.summarize) base.groups[1].model = patch.models.summarize;
    if (patch.models?.search) base.groups[2].model = patch.models.search;
    return base;
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("HindsightModelGroupsPanel", () => {
  it("renders the 3 Hindsight roles as model groups with badges", async () => {
    act(() => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <HindsightModelGroupsPanel />
        </QueryClientProvider>,
      );
    });

    await settle();

    expect(container.querySelector('[data-testid="myrmidon-hindsight-model-groups-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="hindsight-group-card-write"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="hindsight-group-card-summarize"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="hindsight-group-card-search"]')).not.toBeNull();

    expect(container.textContent).toContain("hindsight-write");
    expect(container.textContent).toContain("hindsight-summarize");
    expect(container.textContent).toContain("hindsight-search");
  });

  it("renders the limitations banner referencing OPE-9469 dependency", async () => {
    act(() => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <HindsightModelGroupsPanel />
        </QueryClientProvider>,
      );
    });

    await settle();

    const banner = container.querySelector('[data-testid="hindsight-limitations-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("OPE-9469");
    expect(banner?.textContent).toContain("Без правки секретов");
  });

  it("selects suggested model and saves to API without server restart", async () => {
    act(() => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <HindsightModelGroupsPanel />
        </QueryClientProvider>,
      );
    });

    await settle();

    // Click suggested model pill for write (e.g. claude-3-5-haiku)
    const sugPill = container.querySelector('[data-testid="hindsight-sug-write-claude-3-5-haiku"]') as HTMLButtonElement | null;
    expect(sugPill).not.toBeNull();

    act(() => {
      sugPill?.click();
    });

    await settle();

    const writeInput = container.querySelector('[data-testid="hindsight-model-input-write"]') as HTMLInputElement;
    expect(writeInput.value).toBe("claude-3-5-haiku");

    // Click save button
    const saveButton = container.querySelector('[data-testid="hindsight-save-models-button"]') as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);

    await act(async () => {
      saveButton.click();
    });

    await settle();

    expect(apiMock.updateCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        models: expect.objectContaining({
          write: "claude-3-5-haiku",
        }),
      }),
      undefined,
    );
  });
});
