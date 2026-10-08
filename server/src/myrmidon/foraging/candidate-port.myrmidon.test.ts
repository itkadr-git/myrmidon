// myrmidon(1.6-FORAGE): the candidate port that connects FORAGING findings to
// SKILL-LIFECYCLE. The acceptance points are here: a finding becomes a skill
// candidate through the REAL lifecycle service (over an in-memory store, by the
// pattern of skill-lifecycle.myrmidon.test.ts), a lifecycle refusal answers
// null without breaking the pass, and the null port keeps the old behaviour.
//
// Without `candidate-port.ts` and the wiring in `index.ts` this file does not
// compile — the whole suite is red on the change's absence.

import { describe, expect, it } from "vitest";
import {
  nullForagingCandidatePort,
  skillKeyForRole,
  type ForagingCandidateInput,
} from "./domain.js";
import {
  buildCandidateMarkdown,
  createForagingCandidatePort,
  foragedSkillKey,
  type ForagedSkillRef,
  type ForagingSkillStore,
} from "./candidate-port.js";
import { createSkillLifecycleService } from "../skill-lifecycle/service.js";
import type {
  SkillLifecycleStore,
  SkillLifecycleVersionRef,
} from "../skill-lifecycle/store.js";
import type { SkillLifecycleEvent, SkillLifecycleRecord } from "../skill-lifecycle/domain.js";

const COMPANY = "10000000-0000-4000-8000-000000000001";
const SOURCE = "10000000-0000-4000-8000-0000000000e1";

function candidateInput(overrides: Partial<ForagingCandidateInput> = {}): ForagingCandidateInput {
  return {
    companyId: COMPANY,
    sourceId: SOURCE,
    role: "social-media-marketing",
    url: "https://example.com/playbook",
    skillKey: skillKeyForRole("social-media-marketing"),
    summary: "2 added, 1 removed",
    diff: { added: ["post twice a week", "use short video"], removed: ["one long post"] },
    detectedAt: new Date("2026-10-02T10:00:00.000Z"),
    ...overrides,
  };
}

interface FakeDb {
  skills: Map<string, ForagedSkillRef & { name: string; markdown: string; currentVersionId: string | null }>;
  revisions: SkillLifecycleVersionRef[];
  records: Map<string, SkillLifecycleRecord>;
  skillStore: ForagingSkillStore;
  lifecycleStore: SkillLifecycleStore;
}

/** One in-memory table shared by the port's skill store and the lifecycle store. */
function fakeDb(): FakeDb {
  const skills = new Map<string, ForagedSkillRef & { name: string; markdown: string; currentVersionId: string | null }>();
  const revisions: SkillLifecycleVersionRef[] = [];
  const records = new Map<string, SkillLifecycleRecord>();
  const events: SkillLifecycleEvent[] = [];
  let sequence = 0;

  const skillStore: ForagingSkillStore = {
    async getByKey(_companyId, key) {
      const found = [...skills.values()].find((skill) => skill.key === key);
      return found ? { ...found } : null;
    },
    async createSkill(input) {
      sequence += 1;
      const skill = {
        id: `skill-${sequence}`,
        key: input.key,
        slug: input.slug,
        name: input.name,
        markdown: input.markdown,
        currentVersionId: null,
      };
      skills.set(skill.id, skill);
      return { ...skill };
    },
    async addRevision(input) {
      sequence += 1;
      const version: SkillLifecycleVersionRef = {
        id: `revision-${sequence}`,
        revisionNumber: revisions.length + 1,
        fileInventory: [{ path: "SKILL.md", kind: "skill", content: input.markdown }],
      };
      revisions.push(version);
      const skill = skills.get(input.skillId);
      if (skill) {
        skill.currentVersionId = version.id;
        skill.markdown = input.markdown;
      }
      return version.id;
    },
  };

  const lifecycleStore: SkillLifecycleStore = {
    async getSkill(companyId, skillId) {
      const skill = skills.get(skillId);
      return companyId === COMPANY && skill ? { ...skill } : null;
    },
    async listSkills(companyId) {
      return companyId === COMPANY ? [...skills.values()].map((skill) => ({ ...skill })) : [];
    },
    async getRecord(companyId, skillId) {
      const record = records.get(skillId);
      return companyId === COMPANY && record ? { ...record } : null;
    },
    async listRecords(companyId) {
      return companyId === COMPANY ? [...records.values()] : [];
    },
    async saveRecord(record) {
      records.set(record.skillId, { ...record });
      return { ...record };
    },
    async appendEvent(event) {
      sequence += 1;
      const stored: SkillLifecycleEvent = {
        skillId: event.skillId,
        fromState: event.fromState,
        toState: event.toState,
        versionId: event.versionId ?? null,
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        approvalId: event.approvalId ?? null,
        reason: event.reason ?? null,
        id: `event-${sequence}`,
        createdAt: event.createdAt ?? new Date(2026, 0, sequence).toISOString(),
      };
      events.push(stored);
      return stored;
    },
    async listEvents(_companyId, skillId) {
      return events.filter((event) => event.skillId === skillId);
    },
    async getVersion(companyId, skillId, versionId) {
      if (companyId !== COMPANY) return null;
      const version = revisions.find((entry) => entry.id === versionId);
      return version ? { ...version } : null;
    },
    async getApproval() {
      return null;
    },
    async setSkillCurrentVersion(_companyId, skillId, versionId) {
      const skill = skills.get(skillId);
      if (skill) skill.currentVersionId = versionId;
    },
  };

  return { skills, revisions, records, skillStore, lifecycleStore };
}

function portWith(db: FakeDb, log?: { warn(obj: unknown, msg: string): void }) {
  return createForagingCandidatePort({
    skillStore: db.skillStore,
    lifecycle: createSkillLifecycleService({
      store: db.lifecycleStore,
      now: () => new Date("2026-10-02T12:00:00.000Z"),
    }),
    log,
  });
}

describe("the foraging candidate port", () => {
  it("is available and turns a finding into a candidate through the real lifecycle", async () => {
    const db = fakeDb();
    const port = portWith(db);
    expect(port.available).toBe(true);

    const ref = await port.createFindingCandidate(candidateInput());

    // The answer is the skill id, and the skill exists as one candidate row.
    expect(ref).toBe("skill-1");
    expect(db.skills.size).toBe(1);
    const skill = [...db.skills.values()][0];
    expect(skill.slug).toBe("foraged-social-media-marketing");
    expect(skill.key).toBe(foragedSkillKey(COMPANY, "foraged-social-media-marketing"));

    // The lifecycle accepted it: the state is `candidate`.
    expect(db.records.get(skill.id)?.state).toBe("candidate");

    // The revision shows the diff and the source, as the brief requires.
    const markdown = db.revisions[0].fileInventory[0].content;
    expect(markdown).toContain("+ post twice a week");
    expect(markdown).toContain("+ use short video");
    expect(markdown).toContain("- one long post");
    expect(markdown).toContain("https://example.com/playbook");
    expect(markdown).toContain("social-media-marketing");
    expect(markdown).toContain("2026-10-02T10:00:00.000Z");
  });

  it("reuses the skill of the key instead of creating a duplicate", async () => {
    const db = fakeDb();
    const port = portWith(db);

    const first = await port.createFindingCandidate(candidateInput());
    const second = await port.createFindingCandidate(candidateInput({ summary: "1 added" }));

    expect(first).toBe(second);
    expect(db.skills.size).toBe(1);
    // Every finding adds its own revision; the skill moves to candidate again.
    expect(db.revisions.length).toBe(2);
    expect(db.records.get(first!)?.state).toBe("candidate");
  });

  it("answers null and does not throw when the lifecycle refuses", async () => {
    const db = fakeDb();
    const warnings: Array<{ obj: unknown; msg: string }> = [];
    const port = createForagingCandidatePort({
      skillStore: db.skillStore,
      lifecycle: {
        ...createSkillLifecycleService({ store: db.lifecycleStore }),
        // The seam fails exactly like the service's own `skill_not_found`.
        async setCandidate() {
          throw new Error("skill_not_found");
        },
      },
      log: { warn: (obj, msg) => warnings.push({ obj, msg }) },
    });

    const ref = await port.createFindingCandidate(candidateInput());

    expect(ref).toBeNull();
    expect(warnings.length).toBe(1);
    expect(warnings[0].msg).toContain("candidate port");
    // The pass is not broken: the port answered, nothing propagated.
  });

  it("answers null when the skill store itself fails", async () => {
    const db = fakeDb();
    const port = createForagingCandidatePort({
      skillStore: {
        ...db.skillStore,
        async getByKey() {
          throw new Error("connection lost");
        },
      },
      lifecycle: createSkillLifecycleService({ store: db.lifecycleStore }),
      log: { warn: () => {} },
    });

    await expect(port.createFindingCandidate(candidateInput())).resolves.toBeNull();
  });

  it("keeps the regression: the null port is absent and never creates a candidate", async () => {
    expect(nullForagingCandidatePort.available).toBe(false);
    await expect(nullForagingCandidatePort.createFindingCandidate(candidateInput())).resolves.toBeNull();
  });

  it("renders the finding's diff into the revision markdown", () => {
    const markdown = buildCandidateMarkdown(candidateInput({ diff: { added: ["only added"], removed: [] } }));
    expect(markdown).toContain("+ only added");
    expect(markdown).not.toContain("## Removed");
    expect(markdown).toContain("Foraged via SKILL-LIFECYCLE");
  });
});
