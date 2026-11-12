import { describe, expect, it } from "vitest";
import { isDeveloperRole } from "@myrmidon/shared";
import {
  resolveReviewerAwareRunExecutionWorkspaceMode,
} from "../services/heartbeat.ts";
import {
  buildExecutionWorkspaceAdapterConfig,
  resolveExecutionWorkspaceMode,
} from "../services/execution-workspace-policy.ts";

// OPE-12881 (REVIEW-NO-CLONE): a review task assigned to a developer reviewer
// must not materialize a full repository checkout on the bot volume. The
// acceptance test at the assignment level: given the reviewer assignment
// context (developer-caste agent + executionStage.wakeRole === "reviewer"),
// the heartbeat workspace chain resolves to agent_default, which strips the
// workspace strategy so workspace realization takes the project_primary path
// and creates no worktree/clone directory on disk.
describe("OPE-12881 reviewer assignment workspace mode", () => {
  const reviewerAgent = {
    id: "agent-reviewer-1",
    name: "adm-dev-review-8",
    role: null,
    adapterType: "hermes_gateway",
  };
  const engineerAgent = {
    id: "agent-eng-1",
    name: "adm-dev-eng-20",
    role: null,
    adapterType: "hermes_gateway",
  };
  const reviewerStage = {
    stageId: "stage-1",
    stageType: "review",
    wakeRole: "reviewer",
  };
  const engineerStage = {
    stageId: "stage-2",
    stageType: "execution",
    wakeRole: "executor",
  };

  it("developer castes include reviewer and engineer agents", () => {
    expect(isDeveloperRole(reviewerAgent)).toBe(true);
    expect(isDeveloperRole(engineerAgent)).toBe(true);
    expect(isDeveloperRole({ id: "x", name: "adm-board-operator" })).toBe(false);
  });

  it("reviewer assignment forces agent_default even when project policy requests isolated_workspace", () => {
    const resolvedMode = resolveExecutionWorkspaceMode({
      projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });
    expect(resolvedMode).toBe("isolated_workspace");

    const mode = resolveReviewerAwareRunExecutionWorkspaceMode({
      agent: reviewerAgent,
      executionStage: reviewerStage,
      trustPresetKind: "standard",
      resolvedMode,
    });
    expect(mode).toBe("agent_default");
  });

  it("engineer assignment keeps the resolved mode", () => {
    const resolvedMode = resolveExecutionWorkspaceMode({
      projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });

    const mode = resolveReviewerAwareRunExecutionWorkspaceMode({
      agent: engineerAgent,
      executionStage: engineerStage,
      trustPresetKind: "standard",
      resolvedMode,
    });
    expect(mode).toBe("isolated_workspace");
  });

  it("reviewer wake on a non-developer agent keeps the resolved mode", () => {
    const mode = resolveReviewerAwareRunExecutionWorkspaceMode({
      agent: { id: "x", name: "adm-board-operator" },
      executionStage: reviewerStage,
      trustPresetKind: "standard",
      resolvedMode: "shared_workspace",
    });
    expect(mode).toBe("shared_workspace");
  });

  it("low_trust_review engineer run still upgrades shared_workspace to isolated_workspace", () => {
    const mode = resolveReviewerAwareRunExecutionWorkspaceMode({
      agent: engineerAgent,
      executionStage: engineerStage,
      trustPresetKind: "low_trust_review",
      resolvedMode: "shared_workspace",
    });
    expect(mode).toBe("isolated_workspace");
  });

  it("agent_default strips the workspace strategy so no worktree can be created", () => {
    const mode = resolveReviewerAwareRunExecutionWorkspaceMode({
      agent: reviewerAgent,
      executionStage: reviewerStage,
      trustPresetKind: "standard",
      resolvedMode: "isolated_workspace",
    });
    const adapterConfig = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
      issueSettings: null,
      mode,
      legacyUseProjectWorkspace: null,
    });
    expect(adapterConfig.workspaceStrategy).toBeUndefined();
  });
});
