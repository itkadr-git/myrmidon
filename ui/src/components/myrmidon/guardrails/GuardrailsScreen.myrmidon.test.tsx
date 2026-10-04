// @vitest-environment jsdom
// myrmidon(1.7-GRD-MODES): view-tier tests for the "Guardrails" settings
// screen — no network; the view is driven against a fake settings document,
// a fake agents list and fake server-resolved effective modes. The presence
// of the controls (Select triggers per rule per level), the effective-mode
// column with its source, and the error/loading/empty states are the
// contract; exact value changes are exercised at the container tier.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuardrailsScreenView } from "./GuardrailsScreen";
import type { GuardrailModesSettings, ResolvedGuardrailMode } from "@paperclipai/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockT = vi.hoisted(() => {
  const t = (key: string) => key;
  return { t };
});

vi.mock("@/i18n", () => ({ useTranslation: () => mockT }));

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
  vi.clearAllMocks();
});

const SETTINGS: GuardrailModesSettings = {
  company: { secret: "mask" },
  castes: { engineer: { injection: "block" } },
  agents: { "agent-a": { pii: "block" } },
};

const RESOLVED: Record<string, ResolvedGuardrailMode[]> = {
  "agent-a": [
    { rule: "secret", mode: "mask", source: "company", caste: null },
    { rule: "pii", mode: "block", source: "agent", caste: null },
    { rule: "injection", mode: "block", source: "caste", caste: "engineer" },
  ],
};

const AGENTS = [
  { agentId: "agent-a", name: "Alpha" },
  { agentId: "agent-b", name: "Beta" },
];

function renderView(overrides: Partial<Parameters<typeof GuardrailsScreenView>[0]> = {}) {
  const onSave = vi.fn();
  const props = {
    settings: SETTINGS,
    agents: AGENTS,
    resolved: RESOLVED,
    onSave,
    pending: false,
    error: null,
    ...overrides,
  };
  act(() => root.render(<GuardrailsScreenView {...props} />));
  return { onSave, props };
}

function saveButton(): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "guardrails.save",
  ) as HTMLButtonElement;
}

describe("myrmidon(1.7-GRD-MODES) GuardrailsScreenView", () => {
  it("renders the three rules for the company row with one mode select each", () => {
    renderView();
    const companyRow = container.querySelector('[data-testid="guardrails-company-row"]');
    expect(companyRow).not.toBeNull();
    // One Radix Select trigger per rule (3).
    expect(companyRow!.querySelectorAll("button").length).toBe(3);
    expect(container.textContent).toContain("guardrails.companyTitle");
    expect(container.textContent).toContain("guardrails.rule.secret");
    expect(container.textContent).toContain("guardrails.rule.pii");
    expect(container.textContent).toContain("guardrails.rule.injection");
  });

  it("shows the server-resolved effective chain with its source per agent", () => {
    renderView();
    const effective = container.querySelector('[data-testid="guardrails-effective-agent-a"]');
    expect(effective?.textContent).toContain("guardrails.mode.mask");
    expect(effective?.textContent).toContain("guardrails.source.company");
    expect(effective?.textContent).toContain("guardrails.mode.block");
    expect(effective?.textContent).toContain("guardrails.source.agent");
    expect(effective?.textContent).toContain("guardrails.source.caste");
  });

  it("renders the per-agent table with one mode select per rule per agent", () => {
    renderView();
    const table = container.querySelector('[data-testid="guardrails-agent-table"]');
    expect(table).not.toBeNull();
    // 2 agents x 3 rules = 6 trigger buttons inside the table.
    expect(table!.querySelectorAll("button").length).toBe(6);
  });

  it("shows the empty-agents notice when there are no agents", () => {
    renderView({ agents: [], resolved: {} });
    expect(container.querySelector('[data-testid="guardrails-no-agents"]')).not.toBeNull();
  });

  it("shows the passed error and keeps the save button", () => {
    renderView({ error: "boom" });
    expect(container.querySelector('[data-testid="myrmidon-guardrails-error"]')?.textContent).toBe("boom");
    expect(saveButton()).toBeDefined();
  });

  it("shows the loading notice while settings are absent", () => {
    renderView({ settings: null });
    expect(container.querySelector('[data-testid="myrmidon-guardrails-loading"]')).not.toBeNull();
  });

  it("the save button is disabled while a save is pending", () => {
    renderView({ pending: true });
    expect(saveButton().disabled).toBe(true);
  });
});
