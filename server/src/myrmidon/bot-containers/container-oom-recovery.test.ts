import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import {
  containerOomRecoveryTestUtils,
  type ContainerOomRecoveryDeps,
} from "./container-oom-recovery.js";
import type { ContainerOomEvidenceEvent } from "./container-oom-store.js";

const event = (details: Record<string, unknown>) => ({ details }) as ContainerOomEvidenceEvent;

describe("recoverContainerOom", () => {
  const run = { id: "run-1", agentId: "agent-1" };
  const issue = { id: "issue-1", companyId: "company-1", projectId: "project-1" };
  const candidates = [
    { id: "devops-1", agentId: "devops-1", role: "devops", status: "active" },
  ];
  const dependencies = (overrides: Partial<ContainerOomRecoveryDeps> = {}) => ({
    getRun: vi.fn(async () => run),
    getEvents: vi.fn(async () => [event({ kind: "resource.oom", containerId: "container-1" })]),
    getIssue: vi.fn(async () => issue),
    getCandidates: vi.fn(async () => candidates),
    ensureRecoveryIssue: vi.fn(async (input: Parameters<ContainerOomRecoveryDeps["ensureRecoveryIssue"]>[0]) => input),
    ...overrides,
  }) as ContainerOomRecoveryDeps;

  it("creates a typed recovery action with only the event's run-correlated evidence", async () => {
    const deps = dependencies();
    const result = await containerOomRecoveryTestUtils.recoverContainerOom(deps, run.id);
    expect(deps.getEvents).toHaveBeenCalledWith(run.agentId, run.id);
    expect(deps.getIssue).toHaveBeenCalledWith(run.id);
    expect(deps.ensureRecoveryIssue).toHaveBeenCalledWith(expect.objectContaining({
      kind: "resource.oom",
      sourceIssueId: issue.id,
      dedupeKey: `resource.oom:${run.id}`,
      owner: { agentId: "devops-1" },
      evidence: { runId: run.id, agentId: run.agentId, oomEvents: [{ kind: "resource.oom", containerId: "container-1" }] },
      runbookRef: "recovery/resource.oom",
    }));
    expect(result).toMatchObject({ kind: "resource.oom", sourceIssueId: issue.id });
  });

  it("does not create a recovery action without matching run evidence", async () => {
    const deps = dependencies({ getEvents: vi.fn(async () => []) });
    await expect(containerOomRecoveryTestUtils.recoverContainerOom(deps, run.id)).resolves.toBeNull();
    expect(deps.getIssue).not.toHaveBeenCalled();
    expect(deps.ensureRecoveryIssue).not.toHaveBeenCalled();
  });

  it("does not create a recovery action when the run has no issue", async () => {
    const deps = dependencies({ getIssue: vi.fn(async () => null) });
    await expect(containerOomRecoveryTestUtils.recoverContainerOom(deps, run.id)).resolves.toBeNull();
    expect(deps.ensureRecoveryIssue).not.toHaveBeenCalled();
  });

  it("does not inspect OOM evidence when the run is missing", async () => {
    const deps = dependencies({ getRun: vi.fn(async () => null) });
    await expect(containerOomRecoveryTestUtils.recoverContainerOom(deps, "missing")).resolves.toBeNull();
    expect(deps.getEvents).not.toHaveBeenCalled();
    expect(deps.ensureRecoveryIssue).not.toHaveBeenCalled();
  });
});

// Keep the public database-facing contract typed without requiring a test database.
const _dbTypecheck = (db: Db) => db;
void _dbTypecheck;
