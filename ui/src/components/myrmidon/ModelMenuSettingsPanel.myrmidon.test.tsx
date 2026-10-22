// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ModelMenuSettingsPanel } from "./ModelMenuSettingsPanel";
import * as modelMenuApiModule from "./modelMenuApi";

/**
 * The editor writes the instance settings row the bot reads on every `/model`:
 * the panel is the owner's half of the acceptance criterion "a change in the
 * board shows up in the Telegram menu".
 */

function renderPanel(): HTMLDivElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <QueryClientProvider client={queryClient}>
      <ModelMenuSettingsPanel />
    </QueryClientProvider>,
  );
  return container;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const view = {
  adapterType: "hermes_gateway",
  adapterTypes: [
    { type: "hermes_gateway", label: "hermes_gateway" },
    { type: "claude_local", label: "claude_local" },
  ],
  catalog: [
    { id: "qwen3-max", label: "Qwen3 Max" },
    { id: "gpt-5.2", label: "GPT-5.2" },
  ],
  stored: { groups: [{ title: "Мои модели", models: ["gpt-5.2"] }] },
  menu: {
    groups: [
      { title: "Мои модели", models: [{ id: "gpt-5.2", label: "GPT-5.2" }], children: [] },
      {
        title: "Новые",
        models: [{ id: "qwen3-max", label: "Qwen3 Max" }],
        children: [],
      },
    ],
    visibleModelIds: ["gpt-5.2", "qwen3-max"],
    hiddenModelIds: [],
    missingModelIds: [],
    duplicateModelIds: [],
    newModelIds: ["qwen3-max"],
    source: "settings",
  },
};

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function waitForLoaded(container: HTMLElement) {
  // The panel renders its shell (and "Loading…") before the query resolves, so
  // wait for the first stored group instead of for the panel itself.
  return waitFor(() => Boolean(container.querySelector('[data-testid="model-menu-title-0"]')));
}

async function waitForSettled(container: HTMLElement) {
  // The panel takes the adapter type from the first answer, which changes the
  // query key and asks once more: wait for the settled answer (the source of
  // the resolved menu and the hidden-models list), not for the first one.
  await waitFor(
    () => container.querySelector('[data-testid="model-menu-source"]')?.textContent === "Configured here",
  );
  await waitFor(() => Boolean(container.querySelector('[data-testid="model-menu-hidden-qwen3-max"]')));
}

describe("ModelMenuSettingsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("shows the stored tree, the source and the menu the bot would show", async () => {
    vi.spyOn(modelMenuApiModule.modelMenuApi, "get").mockResolvedValue(view as never);
    const container = renderPanel();
    await waitForLoaded(container);
    await waitForSettled(container);

    expect(container.querySelector<HTMLInputElement>('[data-testid="model-menu-title-0"]')?.value).toBe("Мои модели");
    expect(container.querySelector('[data-testid="model-menu-source"]')?.textContent).toBe("Configured here");
    expect(container.querySelector('[data-testid="model-menu-preview"]')?.textContent).toContain("Мои модели (1)");
    expect(container.querySelector('[data-testid="model-menu-preview"]')?.textContent).toContain("· qwen3-max");
    expect(container.textContent).toContain("2 models in the catalog, 2 visible");
  });

  it("saves an added group through the API, without a restart", async () => {
    const update = vi.fn().mockResolvedValue(view);
    vi.spyOn(modelMenuApiModule.modelMenuApi, "get").mockResolvedValue(view as never);
    vi.spyOn(modelMenuApiModule.modelMenuApi, "update").mockImplementation(update as never);
    const container = renderPanel();
    await waitForLoaded(container);
    await waitForSettled(container);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="model-menu-add-root-group"]')!.click();
    });
    await waitFor(() => Boolean(container.querySelector('[data-testid="model-menu-title-1"]')));
    await act(async () => {
      setInputValue(container.querySelector<HTMLInputElement>('[data-testid="model-menu-title-1"]')!, "Работа");
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="model-menu-save"]')!.click();
    });
    await waitFor(() => update.mock.calls.length > 0);

    expect(update).toHaveBeenCalledWith(
      {
        groups: [
          { title: "Мои модели", models: ["gpt-5.2"] },
          { title: "Работа", models: [] },
        ],
        hidden: [],
      },
      "hermes_gateway",
    );
  });

  it("saves a model as hidden instead of deleting it", async () => {
    const update = vi.fn().mockResolvedValue(view);
    vi.spyOn(modelMenuApiModule.modelMenuApi, "get").mockResolvedValue(view as never);
    vi.spyOn(modelMenuApiModule.modelMenuApi, "update").mockImplementation(update as never);
    const container = renderPanel();
    await waitForLoaded(container);
    await waitForSettled(container);

    await act(async () => {
      container.querySelector<HTMLInputElement>('[data-testid="model-menu-hidden-qwen3-max"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="model-menu-save"]')!.click();
    });
    await waitFor(() => update.mock.calls.length > 0);

    expect(update).toHaveBeenCalledWith(
      { groups: [{ title: "Мои модели", models: ["gpt-5.2"] }], hidden: ["qwen3-max"] },
      "hermes_gateway",
    );
  });
});