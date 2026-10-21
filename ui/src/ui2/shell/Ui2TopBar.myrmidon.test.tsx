// @vitest-environment jsdom
// myrmidon(UI-2.0 Wave A part 2, ia-v2 §3 + §7.5): view test for the UI-2.0
// top-bar chips. The chip row renders the honest mapping from the composed
// strip (colony / runs / spend), the empty state ("—") while a source has
// not resolved, and NO "of $0" text when budgetCents = 0 (owner rule).
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ui2StatusStrip } from "../useUi2Status";

const stripMock = vi.hoisted(() => ({
  current: null as Ui2StatusStrip | null,
}));

vi.mock("../useUi2Status", () => ({
  useUi2StatusStrip: () => stripMock.current,
  useUi2AttentionCount: () => 0,
}));

vi.mock("./Ui2CommanderPalette", () => ({
  Ui2CommanderPalette: () => null,
}));

// i18n: the ui2 catalog lookup — mirror the catalog keys the bar uses.
const CATALOG: Record<string, string> = {
  "ui2.nests.all": "All nests",
  "ui2.chip.colony": "{{active}} of {{total}}",
  "ui2.chip.runs": "{{running}} running",
  "ui2.chip.runsFailed": "{{running}} running · {{failed}} failed today",
  "ui2.chip.spend": "{{spend}} of {{budget}}",
  "ui2.chip.empty": "—",
  "ui2.commander.aria": "Tell the Commander (Ctrl K)",
  "ui2.commander.placeholder": "Tell the Commander…",
  "ui2.decisions.badge": "{{count}} decisions waiting",
};

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      let out = CATALOG[key] ?? key;
      for (const [k, v] of Object.entries(opts ?? {})) {
        out = out.replaceAll(`{{${k}}}`, String(v));
      }
      return out;
    },
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

import { Ui2TopBar } from "./Ui2TopBar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Repo's act pattern: flush the callback sync, then await its result. */
async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

let container: HTMLDivElement;
let root: Root | null = null;

function renderBar() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

beforeEach(() => {
  renderBar();
});

afterEach(async () => {
  await act(() => {
    root?.unmount();
  });
  container.remove();
  root = null;
  stripMock.current = null;
});

function baseStrip(overrides: Partial<Ui2StatusStrip> = {}): Ui2StatusStrip {
  return {
    colony: { running: 3, total: 12, attention: false },
    runs: { running: 5, failedToday: 0, attention: false },
    spend: { spend: "$315", spendCents: 31_454, budgetCents: 0, budget: null },
    waiting: { count: 0, approvals: 0, decisions: 0, interactions: 0 },
    ...overrides,
  };
}

async function renderWith(strip: Ui2StatusStrip | null) {
  stripMock.current = strip;
  await act(() => {
    root!.render(<Ui2TopBar />);
  });
  return container.textContent ?? "";
}

describe("myrmidon(UI2 Wave A part 2) top bar chips", () => {
  it("renders colony / runs / spend from the composed strip", async () => {
    const text = await renderWith(baseStrip());
    expect(text).toContain("3 of 12");
    expect(text).toContain("5 running");
    expect(text).toContain("$315");
  });

  it("shows spend only when no budget is configured (no 'of $0')", async () => {
    const text = await renderWith(baseStrip());
    expect(text).toContain("$315");
    expect(text).not.toContain("of $0");
    expect(text).not.toMatch(/\$0 of \$0/);
  });

  it("keeps the 'spend of budget' form when a budget is set", async () => {
    const text = await renderWith(
      baseStrip({
        spend: { spend: "$31", spendCents: 3_100, budgetCents: 10_000, budget: "$100" },
      }),
    );
    expect(text).toContain("$31 of $100");
  });

  it("renders the failed-today variant when failures happened", async () => {
    const text = await renderWith(
      baseStrip({ runs: { running: 21, failedToday: 56, attention: true } }),
    );
    expect(text).toContain("21 running · 56 failed today");
  });

  it("renders the empty state ('—') while a chip source has not resolved", async () => {
    const text = await renderWith(baseStrip({ colony: null, runs: null, spend: null }));
    // Three chips, all empty — plus no partial numbers.
    expect(text.match(/—/g)?.length).toBe(3);
    expect(text).not.toContain("0 of 0");
  });

  it("renders all empty states when the whole strip is unresolved", async () => {
    const text = await renderWith(null);
    expect(text.match(/—/g)?.length).toBe(3);
  });

  it("shows the waiting badge only when the count is known and > 0", async () => {
    // The badge renders the number with a `ui2.decisions.badge` aria label.
    const withBadge = await renderWith(
      baseStrip({ waiting: { count: 7, approvals: 1, decisions: 2, interactions: 4 } }),
    );
    const badgeCount = container.querySelector('[aria-label*="decisions"]');
    expect(badgeCount?.textContent).toContain("7");
    expect(withBadge).toContain("Ctrl K7");
    const without = await renderWith(baseStrip());
    expect(container.querySelector('[aria-label*="decisions"]')).toBeNull();
    expect(without).not.toContain("Ctrl K7");
  });
});
