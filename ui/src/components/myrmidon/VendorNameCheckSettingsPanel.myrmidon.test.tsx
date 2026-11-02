// @vitest-environment jsdom
//
// myrmidon(1.7-REBRAND-F): the "Vendor name in the build" section of
// Instance → General — the mode picker, the baseline field, the source lines,
// the gate's own report about the build, and the dirty gate on Save.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VendorNameCheckView } from "./vendorNameCheckApi";
import { VendorNameCheckSettingsPanelView } from "./VendorNameCheckSettingsPanel";

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
});

const view: VendorNameCheckView = {
  settings: { mode: "ratchet", baseline: 28 },
  sources: { mode: "default", baseline: "default" },
  scan: {
    available: true,
    root: "/repo",
    script: "scripts/myrmidon/vendor-name/check-vendor-name.mjs",
    policyPath: "scripts/myrmidon/vendor-name/vendor-name-policy.json",
    mode: "ratchet",
    modeSource: "policy",
    exitCode: 0,
    status: "ok",
    targets: [
      {
        name: "bundle",
        dir: "ui/dist",
        status: "ok",
        visible: 28,
        identifier: 936,
        baseline: 28,
        mode: "ratchet",
        modeSource: "policy",
        files: 408,
        detail: [{ file: "ui/dist/assets/index.js", visible: 3, identifier: 357, line: 1 }],
      },
      {
        name: "snapshots",
        dir: "scripts/myrmidon/vendor-name/snapshots",
        status: "violation",
        visible: 31,
        identifier: 17,
        baseline: 17,
        mode: "ratchet",
        modeSource: "policy",
        files: 3,
        detail: [],
      },
    ],
    totals: { visible: 59, identifier: 953 },
  },
};

function render(
  value: VendorNameCheckView | null,
  onSave = vi.fn(),
  onRefresh = vi.fn(),
  pending = false,
  error: string | null = null,
) {
  flushSync(() => {
    root.render(
      <VendorNameCheckSettingsPanelView
        view={value}
        onSave={onSave}
        onRefresh={onRefresh}
        pending={pending}
        refreshing={false}
        error={error}
      />,
    );
  });
  return onSave;
}

function buttonContaining(text: string): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((el) => el.textContent?.includes(text))!;
}

function baselineInput(): HTMLInputElement {
  return container.querySelector("input[aria-label='Ratchet baseline']") as HTMLInputElement;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("VendorNameCheckSettingsPanelView", () => {
  it("renders both modes with the effective one selected, the sources and the build report", () => {
    render(view);
    expect(buttonContaining("Strict").getAttribute("aria-checked")).toBe("false");
    expect(buttonContaining("Ratchet").getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("[data-testid='vendor-name-check-mode-source']")?.textContent).toBe(
      "Mode: Default",
    );
    expect(container.querySelector("[data-testid='vendor-name-check-baseline-source']")?.textContent).toBe(
      "Baseline: Default",
    );
    const scan = container.querySelector("[data-testid='vendor-name-scan']")?.textContent ?? "";
    expect(scan).toContain("59 visible mention(s)");
    expect(scan).toContain("bundle");
    expect(scan).toContain("ui/dist/assets/index.js:1");
    // Nothing changed yet: Save stays disabled.
    expect(buttonContaining("Save vendor name check").disabled).toBe(true);
  });

  it("enables Save after a different mode is picked, and saves the pick", () => {
    const onSave = render(view);
    flushSync(() => {
      buttonContaining("Strict").click();
    });
    expect(buttonContaining("Save vendor name check").disabled).toBe(false);
    flushSync(() => {
      buttonContaining("Save vendor name check").click();
    });
    expect(onSave).toHaveBeenCalledWith({ mode: "strict" });
  });

  it("refuses a baseline that is not a count, and saves a valid one alone", () => {
    const onSave = render(view);
    flushSync(() => {
      setInputValue(baselineInput(), "many");
    });
    expect(buttonContaining("Save vendor name check").disabled).toBe(true);

    flushSync(() => {
      setInputValue(baselineInput(), "12");
    });
    expect(buttonContaining("Save vendor name check").disabled).toBe(false);
    flushSync(() => {
      buttonContaining("Save vendor name check").click();
    });
    expect(onSave).toHaveBeenCalledWith({ baseline: 12 });
  });

  it("shows the environment override, and asks for a re-read without a restart", () => {
    const onRefresh = vi.fn();
    render(
      { ...view, sources: { mode: "env", baseline: "settings" } },
      vi.fn(),
      onRefresh,
    );
    expect(container.querySelector("[data-testid='vendor-name-check-mode-source']")?.textContent).toBe(
      "Mode: Forced by the server environment",
    );
    flushSync(() => {
      buttonContaining("Check the build again").click();
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("says so when the gate cannot run from this installation", () => {
    render({
      ...view,
      scan: {
        available: false,
        reason: "no_repository",
        detail: "no repository",
        script: "scripts/myrmidon/vendor-name/check-vendor-name.mjs",
      },
    });
    expect(container.querySelector("[data-testid='vendor-name-scan']")?.textContent).toContain(
      "does not run from this installation",
    );
  });

  it("shows an error line and keeps the picker usable", () => {
    render(view, vi.fn(), vi.fn(), false, "Saving the vendor name check failed.");
    expect(container.textContent).toContain("Saving the vendor name check failed.");
    expect(buttonContaining("Ratchet")).toBeTruthy();
  });

  it("shows the load placeholder without a view", () => {
    render(null);
    expect(container.textContent).toContain("Loading the vendor name check");
  });
});