// ui/src/components/myrmidon/ToolComplaintsPanel.myrmidon.test.tsx
//
// myrmidon(1.7 TOOL-COMPLAINTS-UI, OPE-12229): the complaints triage panel —
// view tests. The suite reads the list, the status filter and the threshold
// warning card back from the DOM and checks the one triage action that
// matters: "Disable tool for agent" travels the agent's EXISTING permissions
// endpoint (the payload toolComplaintDisableUpdate builds), never a bypass.

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ToolComplaintsPanelView,
  toolComplaintDisableUpdate,
  type ToolComplaintsPanelViewProps,
} from "./ToolComplaintsPanel";
import type { ToolComplaint } from "@myrmidon/shared";

// Neutral data only: agent-a ids, example tools.
const complaint = (overrides: Partial<ToolComplaint> = {}): ToolComplaint => ({
  id: "c1",
  companyId: "company-a",
  agentId: "agent-a",
  tool: "github_create_issue",
  issue: "tool failed with schema drift",
  severity: "high",
  runId: null,
  status: "open",
  createdAt: "2026-11-12T12:00:00.000Z",
  updatedAt: "2026-11-12T12:00:00.000Z",
  ...overrides,
});

function baseProps(): ToolComplaintsPanelViewProps {
  return {
    complaints: [complaint()],
    thresholdWarnings: [
      { tool: "github_create_issue", openCount: 3, threshold: 3, warning: true },
    ],
    loading: false,
    error: null,
    pendingId: null,
    disablingId: null,
    filter: "all",
    onFilterChange: vi.fn(),
    onStatusChange: vi.fn(),
    onDisableTool: vi.fn(),
  };
}

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

function render(props: ToolComplaintsPanelViewProps) {
  act(() => {
    root.render(<ToolComplaintsPanelView {...props} />);
  });
}

describe("ToolComplaintsPanelView", () => {
  it("lists complaints with tool, issue, status and agent", () => {
    const props = baseProps();
    render(props);

    expect(container.textContent).toContain("github_create_issue");
    expect(container.textContent).toContain("tool failed with schema drift");
    expect(
      container.querySelector('[data-testid="myrmidon-tool-complaint-c1"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="myrmidon-tool-complaints-list"]')?.textContent,
    ).toContain("agent-a");
  });

  it("shows the threshold warning card when a tool reaches the threshold", () => {
    render(baseProps());

    const warnings = container.querySelector('[data-testid="myrmidon-tool-complaints-warnings"]');
    expect(warnings).not.toBeNull();
    expect(
      container.querySelector('[data-testid="myrmidon-tool-complaints-warning-github_create_issue"]'),
    ).not.toBeNull();
    expect(warnings?.textContent).toContain("3");
  });

  it("hides the warning card below the threshold and shows the empty state", () => {
    render({
      ...baseProps(),
      complaints: [],
      thresholdWarnings: [
        { tool: "github_create_issue", openCount: 1, threshold: 3, warning: false },
      ],
    });

    expect(container.querySelector('[data-testid="myrmidon-tool-complaints-warnings"]')).toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-tool-complaints-empty"]')).not.toBeNull();
  });

  it("the status filter hides complaints of other statuses", () => {
    const props = baseProps();
    render({ ...props, filter: "resolved", complaints: [complaint({ status: "resolved" }), complaint({ id: "c2", status: "open" })] });

    expect(container.querySelector('[data-testid="myrmidon-tool-complaint-c1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-tool-complaint-c2"]')).toBeNull();
  });

  it("every triage button is wired: acknowledge, resolve and the disable action", () => {
    const props = baseProps();
    render(props);

    const disable = container.querySelector<HTMLButtonElement>(
      '[data-testid="myrmidon-tool-complaint-disable-c1"]',
    );
    const acknowledge = container.querySelector<HTMLButtonElement>(
      '[data-testid="myrmidon-tool-complaint-acknowledge-c1"]',
    );
    const resolve = container.querySelector<HTMLButtonElement>(
      '[data-testid="myrmidon-tool-complaint-resolve-c1"]',
    );
    expect(disable).not.toBeNull();
    expect(acknowledge).not.toBeNull();
    expect(resolve).not.toBeNull();

    act(() => disable!.click());
    expect(props.onDisableTool).toHaveBeenCalledWith(props.complaints[0]);

    act(() => resolve!.click());
    expect(props.onStatusChange).toHaveBeenCalledWith(props.complaints[0], "resolved");

    act(() => acknowledge!.click());
    expect(props.onStatusChange).toHaveBeenCalledWith(props.complaints[0], "acknowledged");
  });

  it("a resolved complaint keeps no acknowledge/resolve buttons", () => {
    render({ ...baseProps(), complaints: [complaint({ status: "resolved" })] });

    expect(
      container.querySelector('[data-testid="myrmidon-tool-complaint-acknowledge-c1"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-tool-complaint-resolve-c1"]')).toBeNull();
    // The disable action stays available — the operator may still cut the tool.
    expect(
      container.querySelector('[data-testid="myrmidon-tool-complaint-disable-c1"]'),
    ).not.toBeNull();
  });

  it("shows loading and error states", () => {
    render({ ...baseProps(), complaints: [], thresholdWarnings: [], loading: true });
    expect(container.querySelector('[data-testid="myrmidon-tool-complaints-loading"]')).not.toBeNull();

    render({ ...baseProps(), complaints: [], thresholdWarnings: [], error: "Request failed: 403" });
    expect(container.querySelector('[data-testid="myrmidon-tool-complaints-error"]')?.textContent).toBe(
      "Request failed: 403",
    );
  });
});

describe("toolComplaintDisableUpdate", () => {
  it("drops only the complained tool and echoes the agent's other rights", () => {
    const update = toolComplaintDisableUpdate(
      {
        canCreateAgents: true,
        canCreateSkills: false,
        toolAccess: { mode: "listed", tools: ["github_create_issue", "jira_search"], connections: ["conn-1"] },
      },
      { canAssignTasks: true },
      "github_create_issue",
    );
    expect(update).toEqual({
      canCreateAgents: true,
      canCreateSkills: false,
      canAssignTasks: true,
      toolAccess: { mode: "listed", tools: ["jira_search"], connections: ["conn-1"] },
    });
  });

  it("an allow-all agent drops into listed mode without the tool", () => {
    const update = toolComplaintDisableUpdate({}, { canAssignTasks: false }, "slack_send");
    expect(update.toolAccess).toEqual({ mode: "listed", tools: [], connections: [] });
    expect(update.canAssignTasks).toBe(false);
  });
});
