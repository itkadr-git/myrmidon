// myrmidon(1.7 KNOWLEDGE-2.0 L-13): the git record is the source of truth
// for verified skill delivery. These focused tests use fake ports only: no
// local repository, credential or network is needed.

import { describe, expect, it, vi } from "vitest";
import { skillContentHash, skillGitDriftReason, skillGitRelativePath } from "./domain.js";
import { createSkillLifecycleService } from "../skill-lifecycle/service.js";
import type { SkillLifecycleStore } from "../skill-lifecycle/store.js";
import type { SkillLifecycleRecord } from "../skill-lifecycle/domain.js";

const COMPANY = "10000000-0000-4000-8000-000000000001";
const SKILL = "10000000-0000-4000-8000-0000000000a1";
const VERSION = "10000000-0000-4000-8000-0000000000c1";
const AGENT = "10000000-0000-4000-8000-0000000000b1";

function record(): SkillLifecycleRecord {
  return {
    companyId: COMPANY,
    skillId: SKILL,
    state: "verified",
    verifiedVersionId: VERSION,
    previousVerifiedVersionId: null,
    approvedBy: "user-a",
    approvedAt: "2026-10-11T00:00:00.000Z",
    reason: null,
    updatedAt: "2026-10-11T00:00:00.000Z",
  };
}

function store(): SkillLifecycleStore {
  return {
    async getSkill() { return { id: SKILL, key: "team/example-skill", name: "Example", slug: "example", currentVersionId: VERSION }; },
    async listSkills() { return [{ id: SKILL, key: "team/example-skill", name: "Example", slug: "example", currentVersionId: VERSION }]; },
    async getRecord() { return record(); },
    async listRecords() { return [record()]; },
    async saveRecord(value) { return value; },
    async appendEvent(value) { return { ...value, id: "event", createdAt: "2026-10-11T00:00:00.000Z" }; },
    async listEvents() { return []; },
    async getVersion() { return { id: VERSION, revisionNumber: 1, fileInventory: [{ path: "SKILL.md", content: "body" }] }; },
    async getApproval() { return null; },
    async setSkillCurrentVersion() {},
  };
}

describe("myrmidon(1.7 KNOWLEDGE-2.0 L-13): git record", () => {
  it("uses a deterministic path and content hash for a nested skill key", () => {
    expect(skillGitRelativePath("team/example-skill", "references/guide.md")).toBe(
      "skills/team/example-skill/references/guide.md",
    );
    expect(skillGitRelativePath("team/example-skill", "../escape.md")).toBeNull();
    expect(skillGitRelativePath("../escape", "SKILL.md")).toBeNull();
    expect(skillContentHash([{ path: "b.md", content: "b" }, { path: "SKILL.md", content: "a" }]))
      .toBe(skillContentHash([{ path: "SKILL.md", content: "a" }, { path: "b.md", content: "b" }]));
  });

  it("marks an absent or different verified snapshot as drift", () => {
    expect(skillGitDriftReason({ verified: true, gitEntry: null, versionFiles: [{ path: "SKILL.md", content: "body" }] })).toBe("missing");
    expect(skillGitDriftReason({
      verified: true,
      gitEntry: { key: "team/example-skill", files: [{ path: "SKILL.md", content: "different" }] },
      versionFiles: [{ path: "SKILL.md", content: "body" }],
    })).toBe("content_mismatch");
  });

  it("withholds a verified skill from delivery until its git record agrees", async () => {
    const gitRecord = {
      refresh: vi.fn(),
      listEntries: vi.fn(async () => []),
      recordVerified: vi.fn(),
    };
    const service = createSkillLifecycleService({ store: store(), gitRecord });
    const delivery = await service.resolveDelivery(COMPANY, AGENT);
    expect(delivery.blockedKeys.has("team/example-skill")).toBe(true);
    expect(delivery.reasons.get("team/example-skill")).toContain("missing");
    expect((await service.list(COMPANY))[0]?.gitDrift).toBe("missing");
  });

  it("delivers a verified skill after the git record has its exact snapshot", async () => {
    const service = createSkillLifecycleService({
      store: store(),
      gitRecord: {
        refresh: async () => {},
        listEntries: async () => [{ key: "team/example-skill", files: [{ path: "SKILL.md", content: "body" }] }],
        recordVerified: async () => {},
      },
    });
    const delivery = await service.resolveDelivery(COMPANY, AGENT);
    expect(delivery.blockedKeys.size).toBe(0);
    expect(delivery.pinnedVersions.get("team/example-skill")).toBe(VERSION);
  });
});
