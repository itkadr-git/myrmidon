// myrmidon(OPE-9408): the shared snapshot behind resolveDelivery.
//
// Before: reconcileGitRecord (full store walk) AND gitEntries (full checkout
// walk) ran once per agent — N agents of a company paid N walks per pass.
// Now the reconciliation, the catalogue reads and the git entries are ONE
// `cache.once` read for the whole pass. The counters below prove the shape:
// three agents of one pass pay one walk; a new pass (fresh cache) re-reads
// and sees a changed checkout.

import { describe, expect, it, vi } from "vitest";
import { createSkillLifecycleService } from "./service.js";
import type { SkillLifecycleStore } from "./store.js";
import type { SkillLifecycleReadCache } from "./service.js";
import type { SkillLifecycleRecord } from "./domain.js";

const COMPANY = "10000000-0000-4000-8000-000000000001";
const SKILL = "10000000-0000-4000-8000-0000000000a1";
const VERSION = "10000000-0000-4000-8000-0000000000c1";
const AGENTS = ["10000000-0000-4000-8000-0000000000b1", "10000000-0000-4000-8000-0000000000b2", "10000000-0000-4000-8000-0000000000b3"];

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
  } satisfies SkillLifecycleStore;
}

/** The pass cache of the sweep: one value per key, shared in-flight. */
function passCache(): SkillLifecycleReadCache & { calls: () => number } {
  let calls = 0;
  const values = new Map<string, Promise<unknown>>();
  return {
    calls: () => calls,
    once<T>(key: string, read: () => Promise<T>): Promise<T> {
      const cached = values.get(key);
      if (cached) return cached as Promise<T>;
      calls += 1;
      // Start the read and register the promise SYNCHRONOUSLY, before any
      // await: concurrent resolveDelivery calls of the same pass must share
      // one in-flight read (this is the production cache's contract).
      const started = read();
      values.set(key, started);
      return started;
    },
  };
}

function gitRecord(entries: () => Array<{ key: string; files: Array<{ path: string; content: string }> }>) {
  return {
    refresh: vi.fn(async () => {}),
    listEntries: vi.fn(entries),
    recordVerified: vi.fn(),
  };
}

describe("myrmidon(OPE-9408): resolveDelivery shared snapshot", () => {
  it("pays one reconciliation/catalogue/entries walk for all agents of a pass", async () => {
    const listEntries = vi.fn(async () => [{ key: "team/example-skill", files: [{ path: "SKILL.md", content: "body" }] }]);
    const s = store();
    const listSkillsSpy = vi.spyOn(s, "listSkills");
    const listRecordsSpy = vi.spyOn(s, "listRecords");
    const service = createSkillLifecycleService({ store: s, gitRecord: { refresh: async () => {}, listEntries, recordVerified: async () => {} } });
    const cache = passCache();

    const deliveries = await Promise.all(AGENTS.map((agentId) => service.resolveDelivery(COMPANY, agentId, cache)));
    // Two DISTINCT cached reads per pass: the git/catalogue snapshot and the
    // company pilot set. Each must be computed exactly once for all agents.
    expect(cache.calls()).toBe(2);
    expect(listEntries).toHaveBeenCalledTimes(1);
    expect(listSkillsSpy).toHaveBeenCalledTimes(1);
    expect(listRecordsSpy).toHaveBeenCalledTimes(1);
    for (const delivery of deliveries) {
      expect(delivery.blockedKeys.size).toBe(0);
      expect(delivery.pinnedVersions.get("team/example-skill")).toBe(VERSION);
    }
  });

  it("a new pass re-reads and sees a changed checkout (HEAD moved)", async () => {
    let snapshot = [{ key: "team/example-skill", files: [{ path: "SKILL.md", content: "body" }] }];
    const service = createSkillLifecycleService({
      store: store(),
      gitRecord: gitRecord(() => snapshot),
    });

    const first = passCache();
    const before = await service.resolveDelivery(COMPANY, AGENTS[0], first);
    expect(before.blockedKeys.size).toBe(0);

    // The checkout moves between passes (a pull/revert): the next pass must
    // not serve the stale snapshot from the previous cache.
    snapshot = [];
    const second = passCache();
    const after = await service.resolveDelivery(COMPANY, AGENTS[0], second);
    expect(after.blockedKeys.has("team/example-skill")).toBe(true);
    expect(after.reasons.get("team/example-skill")).toContain("missing");
  });

  it("without a cache the behaviour is unchanged (live reads)", async () => {
    const service = createSkillLifecycleService({
      store: store(),
      gitRecord: gitRecord(() => [{ key: "team/example-skill", files: [{ path: "SKILL.md", content: "body" }] }]),
    });
    for (const agentId of AGENTS) {
      const delivery = await service.resolveDelivery(COMPANY, agentId);
      expect(delivery.blockedKeys.size).toBe(0);
    }
  });
});
