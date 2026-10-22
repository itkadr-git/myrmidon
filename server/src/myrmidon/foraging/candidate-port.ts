// server/src/myrmidon/foraging/candidate-port.ts
//
// myrmidon(1.6-FORAGE): the connection between FORAGING and SKILL-LIFECYCLE.
//
// The port turns a finding with a diff into a skill candidate: it resolves or
// creates the company skill whose slug is the finding's `skillKey`, records a
// revision whose markdown shows the diff (summary, added/removed lines, the
// source url/role/detectedAt) and moves the skill to `candidate` through
// `SkillLifecycleService.setCandidate`. Promotion is NOT here — it stays the
// approval pipeline's job (`promote-request` → approved `skill_promotion` →
// `promote`).
//
// The skill-table writes sit behind `ForagingSkillStore` so the port is tested
// over a fake store, by the same pattern as `skill-lifecycle/store.ts`. Only
// the two skill tables are written (`company_skills`, `company_skill_versions`)
// and only through additive inserts; no vendor code path is changed.
//
// A lifecycle failure must not break the sweep pass: every error is caught,
// logged and answered with `null` — the finding stays `unverified`, the sweep
// counts the error and continues (the existing catch in `service.ts` covers a
// throwing port, but the port itself must not throw outward).

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySkillVersions, companySkills } from "@paperclipai/db";
import type { SkillLifecycleService } from "../skill-lifecycle/index.js";
import {
  type ForagingCandidateInput,
  type ForagingCandidatePort,
  skillKeyForRole,
} from "./domain.js";

/** The skill row the port needs; only the identity fields. */
export interface ForagedSkillRef {
  id: string;
  key: string;
  slug: string;
}

/**
 * The narrow skill-table surface the port uses. `addRevision` stores the
 * candidate markdown as the revision's `SKILL.md` inventory content and moves
 * the skill's `currentVersionId` to the new revision.
 */
export interface ForagingSkillStore {
  getByKey(companyId: string, key: string): Promise<ForagedSkillRef | null>;
  createSkill(input: {
    companyId: string;
    key: string;
    slug: string;
    name: string;
    markdown: string;
  }): Promise<ForagedSkillRef>;
  addRevision(input: {
    companyId: string;
    skillId: string;
    label: string;
    markdown: string;
  }): Promise<string>;
}

const SKILL_FILE_PATH = "SKILL.md";

/** The default key a foraged skill lives under, matching the vendor naming. */
export function foragedSkillKey(companyId: string, slug: string): string {
  return `company/${companyId}/${slug}`;
}

/** `foraged-social-media-marketing` → `Foraged Social Media Marketing`. */
function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * The revision markdown for one finding: the diff with its source is visible
 * in the skill body, as the part brief requires.
 */
export function buildCandidateMarkdown(input: ForagingCandidateInput): string {
  const title = titleFromSlug(input.skillKey || skillKeyForRole(input.role));
  const lines: string[] = [
    `# ${title}`,
    "",
    `Foraged via SKILL-LIFECYCLE from source \`${input.url}\` (role \`${input.role}\`)`,
    `on ${input.detectedAt.toISOString()}. This revision is a candidate awaiting review.`,
    "",
    `## Summary`,
    "",
    input.summary,
    "",
  ];
  if (input.diff.added.length > 0) {
    lines.push("## Added", "", ...input.diff.added.map((line) => `+ ${line}`), "");
  }
  if (input.diff.removed.length > 0) {
    lines.push("## Removed", "", ...input.diff.removed.map((line) => `- ${line}`), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export interface ForagingCandidatePortDeps {
  skillStore: ForagingSkillStore;
  lifecycle: SkillLifecycleService;
  log?: { warn(obj: unknown, msg: string): void };
}

/**
 * The real candidate port: findings become skill candidates through the
 * lifecycle service. `available` is true because the port is wired.
 */
export function createForagingCandidatePort(deps: ForagingCandidatePortDeps): ForagingCandidatePort {
  const log = deps.log ?? console;
  return {
    available: true,
    async createFindingCandidate(input: ForagingCandidateInput): Promise<string | null> {
      try {
        const slug = input.skillKey || skillKeyForRole(input.role);
        const key = foragedSkillKey(input.companyId, slug);
        let skill = await deps.skillStore.getByKey(input.companyId, key);
        if (!skill) {
          skill = await deps.skillStore.createSkill({
            companyId: input.companyId,
            key,
            slug,
            name: titleFromSlug(slug),
            markdown: buildCandidateMarkdown(input),
          });
        }
        await deps.skillStore.addRevision({
          companyId: input.companyId,
          skillId: skill.id,
          label: `foraging: ${input.summary}`,
          markdown: buildCandidateMarkdown(input),
        });
        await deps.lifecycle.setCandidate(input.companyId, skill.id, {
          actorType: "system",
          actorId: "foraging",
        });
        return skill.id;
      } catch (error) {
        log.warn(
          { error, companyId: input.companyId, sourceId: input.sourceId, skillKey: input.skillKey },
          "foraging: candidate port could not register a skill candidate",
        );
        return null;
      }
    },
  };
}

/** The skill tables behind the port; writes only into `company_skills` and `company_skill_versions`. */
export function createDbForagingSkillStore(db: Db): ForagingSkillStore {
  return {
    async getByKey(companyId, key) {
      const row = await db
        .select({ id: companySkills.id, key: companySkills.key, slug: companySkills.slug })
        .from(companySkills)
        .where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, key)))
        .then((rows: ForagedSkillRef[]) => rows[0] ?? null);
      return row ?? null;
    },
    async createSkill(input) {
      const [created] = await db
        .insert(companySkills)
        .values({
          companyId: input.companyId,
          key: input.key,
          slug: input.slug,
          name: input.name,
          description: `Created by the foraging sweep from a source finding (role ${input.slug}).`,
          markdown: input.markdown,
          sourceType: "local_path",
          fileInventory: [{ path: SKILL_FILE_PATH, kind: "skill" }],
        })
        .returning({ id: companySkills.id, key: companySkills.key, slug: companySkills.slug });
      if (!created) throw new Error("foraging: could not insert the company skill");
      return created;
    },
    async addRevision(input) {
      const [row] = await db
        .select({ next: sql<number>`coalesce(max(${companySkillVersions.revisionNumber}), 0) + 1` })
        .from(companySkillVersions)
        .where(
          and(
            eq(companySkillVersions.companyId, input.companyId),
            eq(companySkillVersions.companySkillId, input.skillId),
          ),
        );
      const revisionNumber = Number(row?.next ?? 1);
      const [version] = await db
        .insert(companySkillVersions)
        .values({
          companyId: input.companyId,
          companySkillId: input.skillId,
          revisionNumber,
          label: input.label,
          fileInventory: [{ path: SKILL_FILE_PATH, kind: "skill", content: input.markdown }],
        })
        .returning({ id: companySkillVersions.id });
      if (!version) throw new Error("foraging: could not insert the skill revision");
      await db
        .update(companySkills)
        .set({ markdown: input.markdown, currentVersionId: version.id, updatedAt: new Date() })
        .where(and(eq(companySkills.companyId, input.companyId), eq(companySkills.id, input.skillId)));
      return version.id;
    },
  };
}
