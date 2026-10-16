// @vitest-environment jsdom
//
// myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the "Nests" section of the agent
// card — the multi-select of projects, and the "nothing picked = the whole
// company" reading.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AgentCardNestsFieldsView,
  type AgentCardNestsFieldsViewProps,
  type AgentNestsProjectOption,
} from "./AgentCardNestsFields";

// The i18n mock reads like the castes screen suite: `t` hands the key back, and
// carries the interpolation argument so the counter can be asserted.
const mockT = vi.hoisted(() => {
  const t = (key: string, options?: { count?: number }) =>
    options && typeof options.count === "number" ? `${key}:${options.count}` : key;
  return { t };
});

vi.mock("@/i18n", () => ({ useTranslation: () => mockT }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STORE = "11111111-1111-1111-1111-111111111111";
const TOOLS = "22222222-2222-2222-2222-222222222222";

const projects: AgentNestsProjectOption[] = [
  { id: STORE, name: "Магазин" },
  { id: TOOLS, name: "Разработка инструментов" },
];

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

function render(overrides: Partial<AgentCardNestsFieldsViewProps> = {}) {
  const props: AgentCardNestsFieldsViewProps = {
    projects,
    picked: [],
    saving: false,
    error: null,
    savedNote: null,
    onToggle: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
  act(() => {
    root.render(
      <TooltipProvider>
        <AgentCardNestsFieldsView {...props} />
      </TooltipProvider>,
    );
  });
  return props;
}

function box(projectId: string): HTMLInputElement {
  return container.querySelector(`[data-testid="myrmidon-agent-nests-${projectId}"]`) as HTMLInputElement;
}

function testId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

describe("AgentCardNestsFieldsView", () => {
  it("lists every project of the company and checks the saved ones", () => {
    render({ picked: [STORE] });
    expect(container.textContent).toContain("Магазин");
    expect(container.textContent).toContain("Разработка инструментов");
    expect(box(STORE).checked).toBe(true);
    expect(box(TOOLS).checked).toBe(false);
    expect(testId("myrmidon-agent-nests-summary")?.textContent).toBe("nests.selected:1");
  });

  it("reads an empty set as the whole company", () => {
    render({ picked: [] });
    expect(box(STORE).checked).toBe(false);
    expect(testId("myrmidon-agent-nests-summary")?.textContent).toBe("nests.allProjects");
  });

  it("hands the toggled project id back to the card", () => {
    const props = render({ picked: [STORE] });
    act(() => box(TOOLS).click());
    expect(props.onToggle).toHaveBeenCalledWith(TOOLS);
  });

  it("saves the picked set as it stands", () => {
    const props = render({ picked: [TOOLS] });
    act(() => (testId("myrmidon-agent-nests-save") as HTMLButtonElement).click());
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it("shows the error of a refused save and the saved note of a good one", () => {
    render({ error: "Unknown projects for this company" });
    expect(testId("myrmidon-agent-nests-error")?.textContent).toContain("Unknown projects");
    render({ savedNote: "Saved" });
    expect(testId("myrmidon-agent-nests-saved")?.textContent).toBe("Saved");
  });

  it("explains the whole-company default when the company has no projects", () => {
    render({ projects: [] });
    expect(testId("myrmidon-agent-nests-no-projects")?.textContent).toContain("nests.noProjects");
    expect(container.querySelectorAll("input[type=checkbox]")).toHaveLength(0);
  });
});