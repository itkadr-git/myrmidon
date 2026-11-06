// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AgentAccessPolicySection, buildAgentAccessPolicyUpdate } from "./AgentAccessPolicySection";

const permissions = {
  canCreateAgents: false,
  canCreateSkills: true,
  canAssignTasks: true,
  trustPreset: "standard" as const,
  authorizationPolicy: {
    trustPreset: "standard" as const,
    assignmentPolicy: { mode: "company_default" as const },
    protectedAgent: { blockAssignment: false },
  },
};

describe("AgentAccessPolicySection", () => {
  it("preserves existing trust policy when editing assignment settings", () => {
    expect(buildAgentAccessPolicyUpdate(permissions, { assignmentPolicy: { mode: "protected" } }))
      .toMatchObject({
        canAssignTasks: true,
        authorizationPolicy: {
          trustPreset: "standard",
          assignmentPolicy: { mode: "protected" },
          protectedAgent: { blockAssignment: false },
        },
      });
  });

  it("requires confirmation before blocking assignments", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    flushSync(() => root.render(<AgentAccessPolicySection permissions={permissions} disabled={false} onChange={onChange} />));
    const checkbox = Array.from(container.querySelectorAll('input[type="checkbox"]')).at(-1) as HTMLInputElement;
    flushSync(() => checkbox.click());
    expect(onChange).not.toHaveBeenCalled();
    const confirm = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Confirm change");
    expect(confirm).toBeTruthy();
    flushSync(() => confirm!.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      authorizationPolicy: expect.objectContaining({ protectedAgent: { blockAssignment: true } }),
    }));
    flushSync(() => root.unmount());
    container.remove();
  });
});
