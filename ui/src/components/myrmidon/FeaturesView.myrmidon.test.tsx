// @vitest-environment jsdom
//
// myrmidon(FEATURES): the Instance -> Features view — sorted by health, the
// honest "unknown", the inline switch and the links to the panel and the guide.
import * as React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeaturesReport, FeatureView } from "@paperclipai/shared";
import { FeaturesView, sortFeatures } from "./FeaturesView";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockT = vi.hoisted(() => ({
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
}));

vi.mock("@/i18n", () => ({ useTranslation: () => mockT }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) =>
    React.createElement("a", { href: to, ...rest }, children),
}));

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
});

function feature(overrides: Partial<FeatureView> & Pick<FeatureView, "key">): FeatureView {
  return {
    name: overrides.key,
    description: `${overrides.key} description`,
    docs: "docs/myrmidon/SETTINGS.md",
    enabled: true,
    config: [{ label: "Enabled", value: "true", source: "env", envVar: "MYRMIDON_EXAMPLE_ENABLED" }],
    settings: null,
    toggle: null,
    needsAttentionSince: null,
    health: {
      status: "working",
      reason: "all good",
      lastSuccessAt: null,
      lastError: null,
      errors24h: 0,
      effect: null,
    },
    ...overrides,
  };
}

const features: FeatureView[] = [
  feature({ key: "off-one", health: { status: "off", reason: "the switch is off", lastSuccessAt: null, lastError: null, errors24h: null, effect: null } }),
  feature({ key: "working-one", health: { status: "working", reason: "ok", lastSuccessAt: new Date().toISOString(), lastError: null, errors24h: 0, effect: { label: "issues claimed in 24 h", value: 7 } } }),
  feature({
    key: "failing-one",
    needsAttentionSince: new Date().toISOString(),
    health: {
      status: "failing",
      reason: "the last pass failed",
      lastSuccessAt: null,
      lastError: { at: new Date().toISOString(), message: "ENOENT: no such file" },
      errors24h: 12,
      effect: { label: "directories reaped in 24 h", value: 0 },
    },
  }),
  feature({ key: "unknown-one", health: { status: "unknown", reason: "unknown — no health signal", lastSuccessAt: null, lastError: null, errors24h: null, effect: null } }),
  feature({ key: "misconfigured-one", health: { status: "misconfigured", reason: "the volume root does not exist", lastSuccessAt: null, lastError: null, errors24h: 3, effect: null } }),
];

const report: FeaturesReport = {
  checkedAt: new Date().toISOString(),
  features,
  summary: { failing: 1, misconfigured: 1, unknown: 1, working: 1, off: 1 },
};

function render(overrides: Partial<React.ComponentProps<typeof FeaturesView>> = {}) {
  const props = {
    report,
    loading: false,
    error: null,
    toggleError: null,
    togglingKey: null,
    refreshing: false,
    onToggle: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
  flushSync(() => {
    root.render(<FeaturesView {...props} />);
  });
  return props;
}

describe("sortFeatures", () => {
  it("puts failing, misconfigured and unknown before working, and off last", () => {
    expect(sortFeatures(features).map((item) => item.key)).toEqual([
      "failing-one",
      "misconfigured-one",
      "unknown-one",
      "working-one",
      "off-one",
    ]);
  });
});

describe("FeaturesView", () => {
  it("shows the count per status and a card per feature in health order", () => {
    render();
    for (const status of ["failing", "misconfigured", "unknown", "working", "off"]) {
      expect(container.querySelector(`[data-testid='features-count-${status}']`)?.textContent).toBe("1");
    }
    const cards = [...container.querySelectorAll("[data-testid^='feature-']")].filter((el) =>
      /^feature-[a-z]+-one$/.test(el.getAttribute("data-testid") ?? ""),
    );
    expect(cards.map((el) => el.getAttribute("data-testid"))).toEqual([
      "feature-failing-one",
      "feature-misconfigured-one",
      "feature-unknown-one",
      "feature-working-one",
      "feature-off-one",
    ]);
  });

  it("draws unknown as unknown, with its reason, never as working", () => {
    render();
    const card = container.querySelector("[data-testid='feature-unknown-one']")!;
    expect(card.querySelector("[data-testid='feature-status-unknown']")).not.toBeNull();
    expect(card.querySelector("[data-testid='feature-status-working']")).toBeNull();
    expect(card.querySelector("[data-testid='feature-reason-unknown-one']")?.textContent).toContain("no health signal");
  });

  it("shows the error count, the last error and the effect metric", () => {
    render();
    expect(container.querySelector("[data-testid='feature-errors-failing-one']")?.textContent).toBe("12");
    expect(container.querySelector("[data-testid='feature-last-error-failing-one']")?.textContent).toContain("ENOENT");
    expect(container.querySelector("[data-testid='feature-effect-working-one']")?.textContent).toBe("7");
    expect(container.querySelector("[data-testid='feature-attention-failing-one']")).not.toBeNull();
    expect(container.querySelector("[data-testid='feature-attention-working-one']")).toBeNull();
  });

  it("lists the effective config with its source and the variable", () => {
    render();
    const config = container.querySelector("[data-testid='feature-config-working-one']")!;
    expect(config.textContent).toContain("MYRMIDON_EXAMPLE_ENABLED");
    expect(config.textContent).toContain("features.source.env");
  });

  it("flips an inline switch and locks it when the environment forces the value", () => {
    const toggled = feature({ key: "switch-one", toggle: { enabled: false, lockedBy: null } });
    const locked = feature({ key: "locked-one", toggle: { enabled: true, lockedBy: "env" } });
    const props = render({ report: { ...report, features: [toggled, locked] } });
    const button = container.querySelector("[data-testid='feature-toggle-switch-one']") as HTMLButtonElement;
    flushSync(() => button.click());
    expect(props.onToggle).toHaveBeenCalledWith("switch-one", true);
    const lockedButton = container.querySelector("[data-testid='feature-toggle-locked-one']") as HTMLButtonElement;
    expect(lockedButton.disabled).toBe(true);
    expect(container.querySelector("[data-testid='feature-locked-locked-one']")).not.toBeNull();
  });

  it("links to the settings panel and to the guide", () => {
    const withPanel = feature({ key: "panel-one", settings: { path: "/company/settings", panel: "Run limits" } });
    render({ report: { ...report, features: [withPanel] } });
    expect(container.querySelector("[data-testid='feature-settings-panel-one']")?.getAttribute("href")).toBe("/company/settings");
    const docs = container.querySelector("[data-testid='feature-docs-panel-one']")?.getAttribute("href") ?? "";
    expect(docs).toBe("https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.md");
  });

  it("hides the health numbers of an off feature and shows loading and errors", () => {
    render();
    expect(container.querySelector("[data-testid='feature-errors-off-one']")).toBeNull();
    render({ report: null, loading: true });
    expect(container.textContent).toContain("features.loading");
    render({ report: null, error: "boom" });
    expect(container.querySelector("[data-testid='features-error']")?.textContent).toBe("boom");
  });

  it("asks for a refresh", () => {
    const props = render();
    const button = [...container.querySelectorAll("button")].find((el) => el.textContent?.includes("features.refresh"))!;
    flushSync(() => button.click());
    expect(props.onRefresh).toHaveBeenCalled();
  });
});
