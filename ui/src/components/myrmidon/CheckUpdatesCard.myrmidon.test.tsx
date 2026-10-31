// @vitest-environment jsdom

// myrmidon(1.7 AUTO-UPDATE-SETTINGS, OPE-10186): tests for CheckUpdatesCard UI
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckUpdatesCard } from "./CheckUpdatesCard";
import * as checkUpdatesApi from "./checkUpdatesApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const NOW = "2026-10-31T12:00:00.000Z";

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CheckUpdatesCard />
      </QueryClientProvider>,
    );
  });
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function get(el: (sel: string) => HTMLElement | null) {
  const found = el("[data-testid^='myrmidon-check-updates']");
  return found;
}

describe("CheckUpdatesCard", () => {
  it("shows an update-available result when a newer release exists", async () => {
    vi.spyOn(checkUpdatesApi.checkUpdatesApi, "get").mockResolvedValue({
      currentVersion: "1.6.6",
      currentCommit: "0123456",
      currentDigest: "sha256:current",
      channel: "stable",
      updateAvailable: true,
      latestVersion: "1.7.0",
      latestCommit: null,
      latestDigest: null,
      releaseTag: "myr-v1.7.0",
      releaseUrl: "https://github.com/itkadr-git/myrmidon/releases/tag/myr-v1.7.0",
      releaseNotes: "Release 1.7.0",
      publishedAt: NOW,
      checkedAt: NOW,
      error: null,
    });

    renderCard();
    await tick();

    const result = document.querySelector(
      "[data-testid='myrmidon-check-updates-result']",
    ) as HTMLElement | null;
    expect(result).toBeTruthy();
    const status = document.querySelector(
      "[data-testid='myrmidon-check-updates-status']",
    ) as HTMLElement | null;
    expect(status?.textContent).toContain("1.7.0");
  });

  it("shows up-to-date message when no newer version exists", async () => {
    vi.spyOn(checkUpdatesApi.checkUpdatesApi, "get").mockResolvedValue({
      currentVersion: "1.7.0",
      currentCommit: null,
      currentDigest: null,
      channel: "stable",
      updateAvailable: false,
      latestVersion: "1.7.0",
      latestCommit: null,
      latestDigest: null,
      releaseTag: "myr-v1.7.0",
      releaseUrl: null,
      releaseNotes: null,
      publishedAt: NOW,
      checkedAt: schemas_now(),
      error: null,
    });

    renderCard();
    await tick();

    const status = document.querySelector(
      "[data-testid='myrmidon-check-updates-status']",
    ) as HTMLElement | null;
    expect(status?.textContent).toContain("latest version");
  });

  it("shows an error message when the check fails", async () => {
    vi.spyOn(checkUpdatesApi.checkUpdatesApi, "get").mockRejectedValue(
      new Error("Upstream request failed (503)"),
    );

    renderCard();
    await tick();

    const error = document.querySelector(
      "[data-testid='myrmidon-check-updates-error']",
    ) as HTMLElement | null;
    expect(error?.textContent).toContain("Upstream request failed (503)");
  });
});

function schemas_now() {
  return NOW;
}
