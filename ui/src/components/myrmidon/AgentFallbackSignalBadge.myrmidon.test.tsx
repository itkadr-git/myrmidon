// @vitest-environment jsdom
// myrmidon(BOT-RUNTIME-TUNING D2): the model-fallback badge on an agent card —
// view tier, no network. Checked: an above-threshold row renders the share and
// the destructive look; a below-threshold row, a missing row and a row without
// the flag render nothing (the signal must not fire on a healthy bot).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentFallbackSignalBadge } from "./AgentFallbackSignalBadge";
import type { FallbackSignalStatusRow } from "./modelFallbackSignalApi";

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
  act(() => root.unmount());
  container.remove();
});

const ROW: FallbackSignalStatusRow = {
  agentId: "agent-1",
  total: 21,
  fallbacks: 9,
  sharePct: 43,
  servedModels: ["model-swapped"],
  aboveThreshold: true,
};

function badge(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-testid^=agent-fallback-signal-]");
}

describe("myrmidon(BOT-RUNTIME-TUNING D2) AgentFallbackSignalBadge", () => {
  it("renders the fallback share of an agent above the threshold", () => {
    act(() => root.render(<AgentFallbackSignalBadge row={ROW} />));
    expect(badge()?.textContent).toBe("fallback 43%");
    expect(badge()?.dataset.sharePct).toBe("43");
    expect(badge()?.className).toContain("text-destructive");
  });

  it("renders nothing below the threshold", () => {
    act(() => root.render(<AgentFallbackSignalBadge row={{ ...ROW, aboveThreshold: false, sharePct: 5 }} />));
    expect(badge()).toBeNull();
  });

  it("renders nothing for an agent that was never evaluated", () => {
    act(() => root.render(<AgentFallbackSignalBadge row={undefined} />));
    expect(badge()).toBeNull();
  });
});