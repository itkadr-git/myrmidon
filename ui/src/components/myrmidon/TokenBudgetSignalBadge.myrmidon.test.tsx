// @vitest-environment jsdom
// myrmidon(1.7 TOKEN-BUDGET-SIGNAL, OPE-12232): the card view of the token
// budget signal. Checked: "warn" renders the amber badge with the observed
// share of the budget, "info" renders the quiet badge, and "none"/no payload
// render nothing — the signal informs, it never implies a stop.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { TokenBudgetSignalBadge } from "./TokenBudgetSignalBadge";
import type { TokenBudgetSignal } from "@myrmidon/shared";

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

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function signal(level: TokenBudgetSignal["level"], overrides: Partial<TokenBudgetSignal> = {}): TokenBudgetSignal {
  return {
    level,
    scopeType: "issue",
    scopeId: "issue-1",
    policyId: "policy-1",
    metric: "issue_tokens",
    amountTokens: 1000,
    observedTokens: level === "warn" ? 1100 : 500,
    utilizationPercent: level === "warn" ? 110 : 50,
    warnPercent: 80,
    enforcement: "signal",
    ...overrides,
  };
}

function badge(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-testid=issue-token-budget-signal]");
}

describe("myrmidon(1.7 TOKEN-BUDGET-SIGNAL) TokenBudgetSignalBadge", () => {
  it("renders the warn level with the observed share of the budget", () => {
    act(() => root.render(<TokenBudgetSignalBadge signal={signal("warn")} />));
    const el = badge();
    expect(el).not.toBeNull();
    expect(el?.dataset.level).toBe("warn");
    expect(el?.textContent).toBe("Token budget 1.1k / 1.0k (110%)");
    expect(el?.className).toContain("amber");
  });

  it("renders the info level as the quiet badge", () => {
    act(() => root.render(<TokenBudgetSignalBadge signal={signal("info")} />));
    const el = badge();
    expect(el).not.toBeNull();
    expect(el?.dataset.level).toBe("info");
    expect(el?.textContent).toContain("50%");
  });

  it("renders nothing for the none level and without a payload", () => {
    act(() => root.render(<TokenBudgetSignalBadge signal={signal("none")} />));
    expect(badge()).toBeNull();
    act(() => root.render(<TokenBudgetSignalBadge signal={null} />));
    expect(badge()).toBeNull();
    act(() => root.render(<TokenBudgetSignalBadge signal={undefined} />));
    expect(badge()).toBeNull();
  });
});
