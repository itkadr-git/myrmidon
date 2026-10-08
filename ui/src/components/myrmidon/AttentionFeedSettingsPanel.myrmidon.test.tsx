// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AttentionFeedSettingsPanel } from "./AttentionFeedSettingsPanel";
import * as attentionFeedApiModule from "./attentionFeedApi";

const BOUNDS = {
  failedRunHorizonDays: { min: 1, max: 365, default: 7 },
  feedCacheTtlSeconds: { min: 0, max: 300, default: 45 },
};

const view = {
  settings: { failedRunHorizonDays: 7, feedCacheTtlSeconds: 45 },
  sources: { failedRunHorizonDays: "default", feedCacheTtlSeconds: "default" },
  bounds: BOUNDS,
};

function renderPanel(): HTMLDivElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <QueryClientProvider client={queryClient}>
      <AttentionFeedSettingsPanel />
    </QueryClientProvider>,
  );
  return container;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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

function field(container: HTMLDivElement, testId: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
}

function button(container: HTMLDivElement, testId: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
}

async function ready(container: HTMLDivElement) {
  await waitFor(() => field(container, "attention-feed-horizon-input")?.value === "7");
}

function waitForField(container: HTMLDivElement, testId: string, value: string) {
  return waitFor(() => field(container, testId)?.value === value);
}

describe("AttentionFeedSettingsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("shows both windows with their bounds and where each value comes from", async () => {
    vi.spyOn(attentionFeedApiModule.attentionFeedApi, "get").mockResolvedValue(view as never);
    const container = renderPanel();
    await ready(container);
    expect(field(container, "attention-feed-horizon-input").value).toBe("7");
    expect(field(container, "attention-feed-cache-ttl-input").value).toBe("45");
    expect(container.querySelector('[data-testid="attention-feed-horizon-bounds"]')?.textContent)
      .toContain("1–365, default 7");
    expect(container.querySelector('[data-testid="attention-feed-cache-ttl-bounds"]')?.textContent)
      .toContain("0–300, default 45");
    expect(container.querySelector('[data-testid="attention-feed-horizon-source"]')?.textContent)
      .toBe("Default");
    expect(button(container, "attention-feed-save").disabled).toBe(true);
  });

  it("marks a value that came from the saved settings row", async () => {
    vi.spyOn(attentionFeedApiModule.attentionFeedApi, "get").mockResolvedValue({
      ...view,
      settings: { failedRunHorizonDays: 14, feedCacheTtlSeconds: 90 },
      sources: { failedRunHorizonDays: "settings", feedCacheTtlSeconds: "settings" },
    } as never);
    const container = renderPanel();
    await waitForField(container, "attention-feed-horizon-input", "14");
    expect(container.querySelector('[data-testid="attention-feed-horizon-source"]')?.textContent)
      .toBe("Saved");
    expect(container.querySelector('[data-testid="attention-feed-cache-ttl-source"]')?.textContent)
      .toBe("Saved");
  });

  it("saves only the window the operator changed, without a restart", async () => {
    const update = vi.fn().mockResolvedValue(view);
    vi.spyOn(attentionFeedApiModule.attentionFeedApi, "get").mockResolvedValue(view as never);
    vi.spyOn(attentionFeedApiModule.attentionFeedApi, "update").mockImplementation(update as never);
    const container = renderPanel();
    await ready(container);

    await act(async () => {
      setInputValue(field(container, "attention-feed-horizon-input"), "14");
    });
    await act(async () => {
      button(container, "attention-feed-save").click();
    });
    await waitFor(() => update.mock.calls.length > 0);
    expect(update).toHaveBeenCalledWith({ failedRunHorizonDays: 14 });
    await waitFor(() => Boolean(container.querySelector('[data-testid="attention-feed-saved"]')));
  });

  it("saves both windows when both were changed", async () => {
    const update = vi.fn().mockResolvedValue(view);
    vi.spyOn(attentionFeedApiModule.attentionFeedApi, "get").mockResolvedValue(view as never);
    vi.spyOn(attentionFeedApiModule.attentionFeedApi, "update").mockImplementation(update as never);
    const container = renderPanel();
    await ready(container);

    await act(async () => {
      setInputValue(field(container, "attention-feed-horizon-input"), "30");
      setInputValue(field(container, "attention-feed-cache-ttl-input"), "0");
    });
    await act(async () => {
      button(container, "attention-feed-save").click();
    });
    await waitFor(() => update.mock.calls.length > 0);
    expect(update).toHaveBeenCalledWith({ failedRunHorizonDays: 30, feedCacheTtlSeconds: 0 });
  });

  it("rejects an out-of-range or fractional window before calling the API", async () => {
    const update = vi.fn();
    vi.spyOn(attentionFeedApiModule.attentionFeedApi, "get").mockResolvedValue(view as never);
    vi.spyOn(attentionFeedApiModule.attentionFeedApi, "update").mockImplementation(update as never);
    const container = renderPanel();
    await ready(container);

    await act(async () => {
      setInputValue(field(container, "attention-feed-horizon-input"), "400");
    });
    await act(async () => {
      button(container, "attention-feed-save").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(update).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="attention-feed-error"]')?.textContent)
      .toContain("Enter a whole number between 1 and 365");

    await act(async () => {
      setInputValue(field(container, "attention-feed-horizon-input"), "7");
    });
    await act(async () => {
      setInputValue(field(container, "attention-feed-cache-ttl-input"), "1.5");
    });
    await act(async () => {
      button(container, "attention-feed-save").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(update).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="attention-feed-error"]')?.textContent)
      .toContain("Enter a whole number between 0 and 300");
  });

  it("writes both built-in defaults back from the defaults button", async () => {
    const update = vi.fn().mockResolvedValue(view);
    vi.spyOn(attentionFeedApiModule.attentionFeedApi, "get").mockResolvedValue({
      ...view,
      settings: { failedRunHorizonDays: 200, feedCacheTtlSeconds: 0 },
      sources: { failedRunHorizonDays: "settings", feedCacheTtlSeconds: "settings" },
    } as never);
    vi.spyOn(attentionFeedApiModule.attentionFeedApi, "update").mockImplementation(update as never);
    const container = renderPanel();
    await waitForField(container, "attention-feed-horizon-input", "200");

    await act(async () => {
      button(container, "attention-feed-reset").click();
    });
    await waitFor(() => update.mock.calls.length > 0);
    expect(update).toHaveBeenCalledWith({ failedRunHorizonDays: 7, feedCacheTtlSeconds: 45 });
  });

  it("reports a failed save instead of claiming success", async () => {
    vi.spyOn(attentionFeedApiModule.attentionFeedApi, "get").mockResolvedValue(view as never);
    vi.spyOn(attentionFeedApiModule.attentionFeedApi, "update").mockRejectedValue(new Error("nope"));
    const container = renderPanel();
    await ready(container);

    await act(async () => {
      setInputValue(field(container, "attention-feed-horizon-input"), "14");
    });
    await act(async () => {
      button(container, "attention-feed-save").click();
    });
    await waitFor(() => Boolean(container.querySelector('[data-testid="attention-feed-error"]')));
    expect(container.querySelector('[data-testid="attention-feed-saved"]')).toBeNull();
  });
});