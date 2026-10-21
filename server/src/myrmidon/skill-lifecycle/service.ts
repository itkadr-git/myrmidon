// myrmidon(1.6-SKILL-LIFE): the lifecycle service.
//
// Transitions: promote (candidate/deprecated → verified, needs an approved
// approval), deprecate (anything → deprecated), rollback (verified pointer back
// to the previous verified revision), and a delivery projection that the bot
// profile compiler reads. Every mutation appends a history event and an
// activity-log row, so the UI can show who approved what and when.

import {
  assertPromotionApproval,
  decideSkillDelivery,
  nextPromotionFields,
  nextRollbackFields,
  readSkillPilotAgents,
  rollbackTargetVersionId,
  SkillLifecycleError,
  type SkillDeliveryState,
  type SkillLifecycleEvent,
  type SkillLifecycleRecord,
  type SkillLifecycleState,
} from "./domain.js";
import type { SkillLifecycleSkillRef, SkillLifecycleStore } from "./store.js";
import type { GitSkillEntry } from "../skill-git-record/domain.js";
import { skillContentHash, skillGitDriftReason } from "../skill-git-record/domain.js";

/**
 * The git record owns verified skill content while enabled. Keeping this as a
 * narrow port lets the lifecycle keep its database-focused tests and makes a
 * failed repository operation fail closed before a promotion is persisted.
 */
export interface SkillGitRecordPort {
  refresh(): Promise<void>;
  listEntries(): Promise<GitSkillEntry[]>;
  recordVerified(input: { key: string; files: Array<{ path: string; content: string }>; revisionNumber: number }): Promise<void>;
}

export interface SkillLifecycleActor {
  actorType: "agent" | "user" | "system";
  actorId: string | null;
}

export interface SkillLifecycleActivityEntry {
  companyId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
}

export interface SkillLifecycleServiceDeps {
  store: SkillLifecycleStore;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  logActivity?: (entry: SkillLifecycleActivityEntry) => Promise<void>;
  // myrmidon(1.7 KNOWLEDGE-2.0 L-13): a verified skill is recorded in git before delivery.
  gitRecord?: SkillGitRecordPort | null;
}

export interface SkillLifecycleView {
  skillId: string;
  key: string;
  name: string;
  slug: string;
  state: SkillLifecycleState;
  /** True when the skill has no lifecycle row yet and keeps legacy delivery. */
  implicit: boolean;
  currentVersionId: string | null;
  verifiedVersionId: string | null;
  previousVerifiedVersionId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  reason: string | null;
  updatedAt: string | null;
  verifiedRevisionNumber: number | null;
  /** Git is the source of record for verified skills when configured. */
  gitDrift?: "missing" | "content_mismatch" | null;
}

export interface SkillLifecycleDelivery {
  /** Skill keys this agent must not receive at all. */
  blockedKeys: Set<string>;
  /** Skill key → revision id the lifecycle pins for delivery. */
  pinnedVersions: Map<string, string>;
  /** Why each blocked key is blocked, for the profile warnings. */
  reasons: Map<string, string>;
}

/**
 * myrmidon(PERF-DIET-G): a caller-provided cache of one sweep (the shape of
 * bot-containers/profile-pass.ts `BotProfilePass`, declared here so this module
 * needs no dependency on the bot containers). `resolveDelivery` is per agent,
 * but the two reads behind it — the company's skills and their lifecycle
 * records — are company-scoped and identical for every bot, so a caller that
 * compiles a whole sweep shares them through this.
 */
export interface SkillLifecycleReadCache {
  once<T>(key: string, read: () => Promise<T>): Promise<T>;
}

export interface SkillLifecycleService {
  list(companyId: string): Promise<SkillLifecycleView[]>;
  state(companyId: string, skillId: string): Promise<SkillLifecycleView>;
  history(companyId: string, skillId: string): Promise<SkillLifecycleEvent[]>;
  setCandidate(companyId: string, skillId: string, actor: SkillLifecycleActor): Promise<SkillLifecycleView>;
  promote(
    companyId: string,
    skillId: string,
    input: { approvalId: string; actor: SkillLifecycleActor },
  ): Promise<SkillLifecycleView>;
  deprecate(
    companyId: string,
    skillId: string,
    input: { reason?: string | null; actor: SkillLifecycleActor },
  ): Promise<SkillLifecycleView>;
  rollback(companyId: string, skillId: string, actor: SkillLifecycleActor): Promise<SkillLifecycleView>;
  /** The revision currently delivered for a skill (verified pointer, else current). */
  verifiedContent(
    companyId: string,
    skillId: string,
  ): Promise<{ versionId: string; revisionNumber: number; files: Array<{ path: string; content: string }> } | null>;
  resolveDelivery(companyId: string, agentId: string, cache?: SkillLifecycleReadCache): Promise<SkillLifecycleDelivery>;
  /** Re-point verified delivery to a matching git revision after a pull/revert. */
  reconcileGitRecord(companyId: string): Promise<void>;
}

function actorIdOf(actor: SkillLifecycleActor): string {
  return actor.actorId ?? actor.actorType;
}

export function createSkillLifecycleService(deps: SkillLifecycleServiceDeps): SkillLifecycleService {
  const store = deps.store;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());

  async function requireSkill(companyId: string, skillId: string): Promise<SkillLifecycleSkillRef> {
    const skill = await store.getSkill(companyId, skillId);
    if (!skill) throw new SkillLifecycleError("skill_not_found", "Skill not found");
    return skill;
  }

  async function recordActivity(entry: SkillLifecycleActivityEntry): Promise<void> {
    if (!deps.logActivity) return;
    try {
      await deps.logActivity(entry);
    } catch {
      // The audit row must never fail a lifecycle transition that already
      // happened; the history event is the durable record either way.
    }
  }

  function viewOf(
    skill: SkillLifecycleSkillRef,
    record: SkillLifecycleRecord | null,
    verifiedRevisionNumber: number | null,
    gitDrift: SkillLifecycleView["gitDrift"] = null,
  ): SkillLifecycleView {
    return {
      skillId: skill.id,
      key: skill.key,
      name: skill.name,
      slug: skill.slug,
      // No row: legacy/unmanaged, delivered to everyone, shown as verified.
      state: record?.state ?? "verified",
      implicit: record === null,
      currentVersionId: skill.currentVersionId,
      verifiedVersionId: record?.verifiedVersionId ?? null,
      previousVerifiedVersionId: record?.previousVerifiedVersionId ?? null,
      approvedBy: record?.approvedBy ?? null,
      approvedAt: record?.approvedAt ?? null,
      reason: record?.reason ?? null,
      updatedAt: record?.updatedAt ?? null,
      verifiedRevisionNumber,
      gitDrift,
    };
  }

  async function revisionNumber(companyId: string, skillId: string, versionId: string | null): Promise<number | null> {
    if (!versionId) return null;
    const version = await store.getVersion(companyId, skillId, versionId);
    return version?.revisionNumber ?? null;
  }

  async function gitDriftFor(
    companyId: string,
    skill: SkillLifecycleSkillRef,
    record: SkillLifecycleRecord | null,
    entries: Map<string, GitSkillEntry> | null,
  ): Promise<SkillLifecycleView["gitDrift"]> {
    if (!deps.gitRecord || record?.state !== "verified" || !record.verifiedVersionId) return null;
    const version = await store.getVersion(companyId, skill.id, record.verifiedVersionId);
    if (!version) return "missing";
    return skillGitDriftReason({
      verified: true,
      gitEntry: entries?.get(skill.key) ?? null,
      versionFiles: version.fileInventory.map((entry) => ({ path: entry.path, content: entry.content })),
    });
  }

  async function reconcileGitRecord(companyId: string): Promise<void> {
    if (!deps.gitRecord) return;
    const [skills, records, entries] = await Promise.all([store.listSkills(companyId), store.listRecords(companyId), gitEntries()]);
    const recordsBySkillId = new Map(records.map((record) => [record.skillId, record] as const));
    for (const skill of skills) {
      const record = recordsBySkillId.get(skill.id);
      if (record?.state !== "verified" || !record.verifiedVersionId) continue;
      const entry = entries?.get(skill.key);
      if (!entry) continue;
      const versions = store.listVersions ? await store.listVersions(companyId, skill.id) : [];
      const matched = versions.find((version) =>
        skillContentHash(entry.files) === skillContentHash(version.fileInventory.map((file) => ({ path: file.path, content: file.content }))),
      );
      if (!matched || matched.id === record.verifiedVersionId) continue;
      await store.saveRecord({
        ...record,
        verifiedVersionId: matched.id,
        previousVerifiedVersionId: record.verifiedVersionId,
        updatedAt: now().toISOString(),
      });
      await store.setSkillCurrentVersion(companyId, skill.id, matched.id);
      await appendEvent(companyId, skill.id, "verified", "verified", { actorType: "system", actorId: null }, {
        versionId: matched.id,
        reason: `git record reconciled revision ${matched.revisionNumber}`,
      });
    }
  }

  async function gitEntries(): Promise<Map<string, GitSkillEntry> | null> {
    if (!deps.gitRecord) return null;
    try {
      return new Map((await deps.gitRecord.listEntries()).map((entry) => [entry.key, entry] as const));
    } catch {
      // A broken checkout is an empty record: verified delivery remains fail-closed.
      return new Map();
    }
  }

  async function viewFor(companyId: string, skill: SkillLifecycleSkillRef): Promise<SkillLifecycleView> {
    const [record, entries] = await Promise.all([store.getRecord(companyId, skill.id), gitEntries()]);
    return viewOf(
      skill,
      record,
      await revisionNumber(companyId, skill.id, record?.verifiedVersionId ?? null),
      await gitDriftFor(companyId, skill, record, entries),
    );
  }

  async function appendEvent(
    companyId: string,
    skillId: string,
    from: SkillLifecycleState | null,
    to: SkillLifecycleState,
    actor: SkillLifecycleActor,
    extra: { versionId?: string | null; approvalId?: string | null; reason?: string | null } = {},
  ): Promise<void> {
    await store.appendEvent({
      companyId,
      skillId,
      fromState: from,
      toState: to,
      versionId: extra.versionId ?? null,
      actorType: actor.actorType,
      actorId: actor.actorId,
      approvalId: extra.approvalId ?? null,
      reason: extra.reason ?? null,
    });
  }

  return {
    async list(companyId) {
      const [skills, records, entries] = await Promise.all([store.listSkills(companyId), store.listRecords(companyId), gitEntries()]);
      const byId = new Map(records.map((record) => [record.skillId, record] as const));
      const out: SkillLifecycleView[] = [];
      for (const skill of skills) {
        const record = byId.get(skill.id) ?? null;
        out.push(
          viewOf(
            skill,
            record,
            await revisionNumber(companyId, skill.id, record?.verifiedVersionId ?? null),
            await gitDriftFor(companyId, skill, record, entries),
          ),
        );
      }
      return out;
    },

    async state(companyId, skillId) {
      return viewFor(companyId, await requireSkill(companyId, skillId));
    },

    async history(companyId, skillId) {
      await requireSkill(companyId, skillId);
      return store.listEvents(companyId, skillId);
    },

    async setCandidate(companyId, skillId, actor) {
      const skill = await requireSkill(companyId, skillId);
      const existing = await store.getRecord(companyId, skill.id);
      const timestamp = now();
      const saved = await store.saveRecord({
        skillId: skill.id,
        companyId,
        state: "candidate",
        verifiedVersionId: existing?.verifiedVersionId ?? null,
        previousVerifiedVersionId: existing?.previousVerifiedVersionId ?? null,
        approvedBy: existing?.approvedBy ?? null,
        approvedAt: existing?.approvedAt ?? null,
        reason: existing?.reason ?? null,
        updatedAt: timestamp.toISOString(),
      });
      await appendEvent(companyId, skill.id, existing?.state ?? null, "candidate", actor, {
        versionId: saved.verifiedVersionId,
        reason: "registered as a candidate",
      });
      await recordActivity({
        companyId,
        actorType: actor.actorType,
        actorId: actorIdOf(actor),
        action: "skill.lifecycle_candidate",
        entityType: "company_skill",
        entityId: skill.id,
        details: { skillKey: skill.key },
      });
      return viewOf(skill, saved, await revisionNumber(companyId, skill.id, saved.verifiedVersionId));
    },

    async promote(companyId, skillId, input) {
      const skill = await requireSkill(companyId, skillId);
      const approval = await store.getApproval(input.approvalId);
      const approved = assertPromotionApproval(approval, skill.id);
      const versionId = skill.currentVersionId;
      if (!versionId) {
        throw new SkillLifecycleError("promotion_no_version", "The skill has no version to promote.");
      }
      const existing = await store.getRecord(companyId, skill.id);
      const timestamp = now();
      const fields = nextPromotionFields(existing, versionId, approved, timestamp);
      const version = await store.getVersion(companyId, skill.id, versionId);
      if (!version) {
        throw new SkillLifecycleError("promotion_version_missing", "The skill version to promote no longer exists.");
      }
      // myrmidon(1.7 KNOWLEDGE-2.0 L-13): do not make a verified DB row until
      // the immutable verified snapshot has been recorded in the configured git
      // record. A repository failure therefore cannot deliver unrecorded code.
      if (deps.gitRecord) {
        await deps.gitRecord.recordVerified({
          key: skill.key,
          files: version.fileInventory.map((entry) => ({ path: entry.path, content: entry.content })),
          revisionNumber: version.revisionNumber,
        });
      }
      const saved = await store.saveRecord({
        skillId: skill.id,
        companyId,
        verifiedVersionId: fields.verifiedVersionId,
        previousVerifiedVersionId: fields.previousVerifiedVersionId,
        approvedBy: fields.approvedBy,
        approvedAt: fields.approvedAt,
        reason: fields.reason,
        state: fields.state,
        updatedAt: timestamp.toISOString(),
      });
      await appendEvent(companyId, skill.id, existing?.state ?? null, "verified", input.actor, {
        versionId,
        approvalId: approved.id,
      });
      await recordActivity({
        companyId,
        actorType: input.actor.actorType,
        actorId: actorIdOf(input.actor),
        action: "skill.lifecycle_promoted",
        entityType: "company_skill",
        entityId: skill.id,
        details: { skillKey: skill.key, versionId, approvalId: approved.id },
      });
      return viewOf(skill, saved, await revisionNumber(companyId, skill.id, saved.verifiedVersionId));
    },

    async deprecate(companyId, skillId, input) {
      const skill = await requireSkill(companyId, skillId);
      const existing = await store.getRecord(companyId, skill.id);
      const timestamp = now();
      const saved = await store.saveRecord({
        skillId: skill.id,
        companyId,
        state: "deprecated",
        verifiedVersionId: existing?.verifiedVersionId ?? null,
        previousVerifiedVersionId: existing?.previousVerifiedVersionId ?? null,
        approvedBy: existing?.approvedBy ?? null,
        approvedAt: existing?.approvedAt ?? null,
        reason: input.reason ?? null,
        updatedAt: timestamp.toISOString(),
      });
      await appendEvent(companyId, skill.id, existing?.state ?? null, "deprecated", input.actor, {
        versionId: saved.verifiedVersionId,
        reason: input.reason ?? null,
      });
      await recordActivity({
        companyId,
        actorType: input.actor.actorType,
        actorId: actorIdOf(input.actor),
        action: "skill.lifecycle_deprecated",
        entityType: "company_skill",
        entityId: skill.id,
        details: { skillKey: skill.key, reason: input.reason ?? null },
      });
      return viewOf(skill, saved, await revisionNumber(companyId, skill.id, saved.verifiedVersionId));
    },

    async rollback(companyId, skillId, actor) {
      const skill = await requireSkill(companyId, skillId);
      const existing = await store.getRecord(companyId, skill.id);
      if (!existing) {
        throw new SkillLifecycleError("rollback_no_verified_version", "The skill has no lifecycle record to roll back.");
      }
      const target = rollbackTargetVersionId(existing);
      const version = await store.getVersion(companyId, skill.id, target);
      if (!version) {
        throw new SkillLifecycleError("rollback_target_missing", "The previous verified version no longer exists.");
      }
      const timestamp = now();
      const fields = nextRollbackFields(existing);
      const saved = await store.saveRecord({
        skillId: skill.id,
        companyId,
        state: fields.state,
        verifiedVersionId: fields.verifiedVersionId,
        previousVerifiedVersionId: fields.previousVerifiedVersionId,
        approvedBy: existing.approvedBy,
        approvedAt: existing.approvedAt,
        reason: fields.reason,
        updatedAt: timestamp.toISOString(),
      });
      // The delivery path reads the skill's current version, so a rollback must
      // move it too — otherwise the restored content is the pointer's only.
      await store.setSkillCurrentVersion(companyId, skill.id, target);
      await appendEvent(companyId, skill.id, existing.state, saved.state, actor, {
        versionId: target,
        reason: `rolled back to revision ${version.revisionNumber}`,
      });
      await recordActivity({
        companyId,
        actorType: actor.actorType,
        actorId: actorIdOf(actor),
        action: "skill.lifecycle_rolled_back",
        entityType: "company_skill",
        entityId: skill.id,
        details: { skillKey: skill.key, versionId: target, revisionNumber: version.revisionNumber },
      });
      return viewOf({ ...skill, currentVersionId: target }, saved, version.revisionNumber);
    },

    async verifiedContent(companyId, skillId) {
      const skill = await requireSkill(companyId, skillId);
      const record = await store.getRecord(companyId, skill.id);
      const versionId = record?.verifiedVersionId ?? skill.currentVersionId;
      if (!versionId) return null;
      const version = await store.getVersion(companyId, skill.id, versionId);
      if (!version) return null;
      return {
        versionId,
        revisionNumber: version.revisionNumber,
        files: version.fileInventory.map((entry) => ({ path: entry.path, content: entry.content })),
      };
    },

    async reconcileGitRecord(companyId) {
      await reconcileGitRecord(companyId);
    },

    // myrmidon(PERF-DIET-G): the two reads are company-scoped and identical for
    // every bot of the company — shared through `cache` when the caller compiles
    // more than one bot (a sweep). The decision below stays per agent: a
    // candidate reaches the pilot set, not the fleet.
    async resolveDelivery(companyId, agentId, cache) {
      // myrmidon(1.7 KNOWLEDGE-2.0 L-13): each profile reconciliation treats
      // the pulled git snapshot as authoritative, so a git revert restores the
      // matching historical version before this agent receives its skills.
      await reconcileGitRecord(companyId);
      const readCatalogue = () => Promise.all([store.listSkills(companyId), store.listRecords(companyId)]);
      const [skills, records] = cache
        ? await cache.once(`skill-lifecycle:${companyId}`, readCatalogue)
        : await readCatalogue();
      const entries = await gitEntries();
      const byId = new Map(records.map((record) => [record.skillId, record] as const));
      const pilotAgentIds = readSkillPilotAgents(env);
      const delivery: SkillLifecycleDelivery = { blockedKeys: new Set(), pinnedVersions: new Map(), reasons: new Map() };
      for (const skill of skills) {
        const record = byId.get(skill.id) ?? null;
        const state: SkillDeliveryState | null = record
          ? { state: record.state, verifiedVersionId: record.verifiedVersionId, authorAgentId: skill.originAgentId ?? null }
          : null;
        const drift = await gitDriftFor(companyId, skill, record, entries);
        if (drift) {
          delivery.blockedKeys.add(skill.key);
          delivery.reasons.set(skill.key, `verified skill is absent or different in the git record (${drift})`);
          continue;
        }
        const decision = decideSkillDelivery({ skillKey: skill.key, agentId, lifecycle: state, pilotAgentIds });
        if (decision.blocked) {
          delivery.blockedKeys.add(skill.key);
          if (decision.reason) delivery.reasons.set(skill.key, decision.reason);
          continue;
        }
        if (decision.pinnedVersionId) delivery.pinnedVersions.set(skill.key, decision.pinnedVersionId);
      }
      return delivery;
    },
  };
}