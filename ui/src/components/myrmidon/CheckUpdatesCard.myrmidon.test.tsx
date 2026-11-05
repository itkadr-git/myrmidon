// @vitest-environment jsdom

// myrmidon(1.7 AUTO-UPDATE-SETTINGS, OPE-10186): tests for CheckUpdatesCard UI.
// View-level: the card renders against a mocked checkUpdatesApi, the same
// pattern as DeployJobsPanel.myrmidon.test.tsx (props-in, DOM-out).
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckUpdatesCardView, type CheckUpdatesCardViewProps } from "./CheckUpdatesCard";
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

function response(
  overrides: Partial<checkUpdatesApi.CheckUpdatesResponseLike> = {},
): checkUpdatesApi.CheckUpdatesResponseLike {
  return {
    currentVersion: "1.6.6",
    currentCommit: "0123456",
    currentDigest: "sha256:current",
    channel: "stable",
    updateAvailable: false,
    latestVersion: "1.6.6",
    latestCommit: null,
    latestDigest: null,
    releaseTag: "myr-v1.6.6",
    releaseUrl: null,
    releaseNotes: null,
    publishedAt: NOW,
    checkedAt: NOW,
    error: null,
    ...overrides,
  };
}

function render(props: Partial<CheckUpdatesCardViewProps> = {}) {
  flushSync(() => {
    root.render(
      <CheckUpdatesCardView
        data={response()}
        pending={false}
        error={null}
        channel="stable"
        onChannelChange={() => {}}
        onCheck={() => {}}
        {...props}
      />,
    );
  });
}

describe("CheckUpdatesCardView", () => {
  it("shows an update-available result when a newer release exists", () => {
    render({ data: response({ updateAvailable: true, latestVersion: "1.7.0", releaseUrl: "https://github.com/itkadr-git/myrmidon/releases/tag/myr-v1.7.0" }) });

    const status = document.querySelector(
      "[data-testid='myrmidon-check-updates-status']",
    ) as HTMLElement | null;
    expect(status?.textContent).toContain("1.7.0");

    const link = document.querySelector(
      "[data-testid='myrmidon-check-updates-result'] a",
    ) as HTMLAnchorElement | null;
    expect(link?.getAttribute("href")).toBe(
      "https://github.com/itkadr-git/myrmidon/releases/tag/myr-v1.7.0",
    );
  });

  it("shows up-to-date message when no newer version exists", () => {
    render();

    const status = document.querySelector(
      "[data-testid='myrmidon-check-updates-status']",
    ) as HTMLElement | null;
    expect(status?.textContent).toContain("latest version");
  });

  it("shows a canary result by latest commit short sha", () => {
    render({
      channel: "canary",
      data: response({
        channel: "canary",
        updateAvailable: true,
        latestVersion: null,
        latestCommit: "9999999abcdef0123456789abcdef01234567",
      }),
    });

    const status = document.querySelector(
      "[data-testid='myrmidon-check-updates-status']",
    ) as HTMLElement | null;
    expect(status?.textContent).toContain("9999999");
  });

  it("shows an error message when the check fails", () => {
    render({ data: undefined, error: new Error("Upstream request failed (503)") });

    const error = document.querySelector(
      "[data-testid='myrmidon-check-updates-error']",
    ) as HTMLElement | null;
    expect(error?.textContent).toContain("Upstream request failed (503)");
  });

  it("disables the check button while pending", () => {
    render({ pending: true });

    const button = document.querySelector(
      "[data-testid='myrmidon-check-updates-button']",
    ) as HTMLButtonElement | null;
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Checking");
  });

  it("invokes onCheck with the selected channel", () => {
    const onCheck = vi.fn();
    const onChannelChange = vi.fn();
    render({ onCheck, onChannelChange, channel: "rc" });

    const button = document.querySelector(
      "[data-testid='myrmidon-check-updates-button']",
    ) as HTMLButtonElement | null;
    flushSync(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onCheck).toHaveBeenCalledWith("rc");

    const select = document.querySelector(
      "[data-testid='myrmidon-check-updates-channel']",
    ) as HTMLSelectElement | null;
    expect(select?.value).toBe("rc");
  });
});
