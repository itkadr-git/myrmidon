// server/src/myrmidon/bot-containers/skill-backimport-ports.ts
//
// myrmidon(1.6.5-BOT-SKILL-BACKIMPORT, OPE-6401/OPE-5906): the database
// binding of the bot-skill back-importer (skill-backimport.ts). Kept out of
// the rule module so the rules are tested against fakes, like the rest of
// the bot-containers ports (profile-ports.ts pattern).
//
// Everything lands in the existing company skill catalog: a back-imported
// skill is a company-local skill (sourceKind "managed_local" — the same kind
// a UI-created skill gets, so the runtime name, the lifecycle delivery and
// the profile compiler treat it like any other company skill) whose managed
// directory is written from the container's files. An update rewrites that
// directory and cuts a new version when the content changed; the compiler's
// runtime catalogue resolves the skill's current version, so the next pass
// delivers the imported copy back to the bots the lifecycle selects.
//
// Provenance (review, point 4): the import refuses to touch a catalog entry
// whose origin marker (skill metadata `bot_backimport_agent`) is absent (a
// UI-created skill) or points at another agent. That marker is written on
// create, re-checked before every update, and the update only replaces the
// managed directory when it still owns the entry. Two bots with the same
// slug never overwrite each other: the second one's import fails loudly
// instead of flip-flopping the entry.
//
// Lifecycle (review, point 3): a created or updated skill is set to
// *candidate* through the skill lifecycle service — a bot-written skill is
// untrusted and goes through the same candidate -> pilot -> verified gate a
// human's upload does. The back-import never promotes.
//
// Delivery (review, point 2): after every import the skill's catalog key is
// added to the authoring agent's desired skills (paperclipSkillSync — the
// same mechanism the company base skills use), because the compiler only
// delivers explicitly desired skills: without this the imported copy never
// comes back to the bot and a volume recreation loses it.

import path from "node:path";
import fs from "node:fs/promises";

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySkills } from "@paperclipai/db";
import { companySkillService } from "../../services/index.js";
import { readPaperclipSkillSyncPreference, writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { BOT_BACKIMPORT_ORIGIN_METADATA_KEY, skillLifecycleService } from "../skill-lifecycle/index.js";
import type {
  BackimportSkillFile,
  BotSkillBackimportPorts,
} from "./skill-backimport.js";

/** Metadata key holding the originating agent's id on a back-imported skill. */
export { BOT_BACKIMPORT_ORIGIN_METADATA_KEY };

/**
 * The directory the catalog service manages a company-local skill in is
 * derived from the service's own sourceLocator (it resolves to
 * <managedRoot>/<slug>), never recomputed here: the layout is the service's
 * business, this port only writes the files the import decided on into it.
 */
export function createDbBotSkillBackimportPorts(db: Db): BotSkillBackimportPorts {
  const skills = companySkillService(db);
  const lifecycle = skillLifecycleService(db);

  return {
    async readSkillByKey(companyId, key) {
      const skill = await skills.getByKey(companyId, key);
      if (!skill) return null;
      const files: BackimportSkillFile[] = [];
      for (const entry of skill.fileInventory) {
        // A version's inventory can list a file the current directory lost
        // (edited elsewhere between passes): treated as absent, not an error.
        const detail = await skills.readFile(companyId, skill.id, entry.path).catch(() => null);
        if (!detail) continue;
        files.push({ path: entry.path, content: detail.content });
      }
      const originAgentId = originFromMetadata(skill.metadata);
      return { id: skill.id, files, originAgentId };
    },

    async createSkill(companyId, agentId, input) {
      const skill = await skills.createLocalSkill(companyId, {
        slug: input.slug,
        name: input.name,
        // The markdown is the container's own SKILL.md; the rest of the files
        // are laid down below (createLocalSkill writes SKILL.md only).
        markdown: input.files.find((entry) => entry.path === "SKILL.md")?.content,
      });
      // The origin marker is what the provenance check keys on; there is no
      // create-time metadata field on the service API, so it goes in with a
      // targeted metadata merge, the same shape the service's internal
      // updateSkillMetadata uses.
      await mergeSkillMetadata(db, skill.id, companyId, { [BOT_BACKIMPORT_ORIGIN_METADATA_KEY]: agentId });
      await writeSkillFiles(skill, input.files);
      // The files write changed the directory after the initial version: cut
      // the version that carries the whole file set, so the runtime catalogue
      // resolves the imported skill complete, not SKILL.md alone.
      const version = await skills.createVersion(companyId, skill.id, { label: "Back-imported from a bot container" });
      await lifecycle.setCandidate(companyId, skill.id, { actorType: "agent", actorId: agentId });
      return { id: skill.id, versionId: version.id };
    },

    async updateSkill(companyId, agentId, skillId, input) {
      const skill = await skills.getById(companyId, skillId);
      if (!skill) throw new Error(`skill ${skillId} not found`);
      await assertBackimportOrigin(skill, agentId);
      const before = await readDirectoryFiles(skill);
      await writeSkillFiles(skill, input.files);
      const changed = !sameFiles(before, input.files);
      if (!changed) {
        return { versionId: skill.currentVersionId, changed: false };
      }
      const version = await skills.createVersion(companyId, skillId, { label: "Back-imported from a bot container" });
      await lifecycle.setCandidate(companyId, skillId, { actorType: "agent", actorId: agentId });
      return { versionId: version.id, changed: true };
    },

    async deliverSkillToAgent(companyId, agentId, key) {
      const rows = await db
        .select({ id: agents.id, adapterConfig: agents.adapterConfig })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .limit(1);
      const agent = rows[0];
      if (!agent) return { added: false };
      const adapterConfig = isRecord(agent.adapterConfig) ? agent.adapterConfig : {};
      const preference = readPaperclipSkillSyncPreference(adapterConfig);
      if (preference.desiredSkillEntries.some((entry) => entry.key === key)) {
        return { added: false };
      }
      const merged = writePaperclipSkillSyncPreference(
        adapterConfig,
        [...preference.desiredSkillEntries, { key, versionId: null }],
      );
      await db
        .update(agents)
        .set({ adapterConfig: merged, updatedAt: new Date() })
        .where(and(eq(agents.id, agent.id), eq(agents.companyId, companyId)));
      return { added: true };
    },
  };
}

type CatalogSkill = NonNullable<Awaited<ReturnType<ReturnType<typeof companySkillService>["getByKey"]>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function originFromMetadata(metadata: unknown): string | null {
  const value = isRecord(metadata) ? metadata[BOT_BACKIMPORT_ORIGIN_METADATA_KEY] : undefined;
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function assertBackimportOrigin(skill: CatalogSkill, agentId: string): Promise<void> {
  const origin = originFromMetadata(skill.metadata);
  if (origin !== agentId) {
    throw new Error(
      `skill ${skill.slug}: catalog entry is ${
        origin ? `another back-import (agent ${origin})` : "not a back-import"
      }, not overwritten`,
    );
  }
}

/** Same targeted metadata merge the catalog service's updateSkillMetadata
 *  does, kept local because the service API does not expose it. */
async function mergeSkillMetadata(
  db: Db,
  skillId: string,
  companyId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const rows = await db
    .select({ metadata: companySkills.metadata })
    .from(companySkills)
    .where(and(eq(companySkills.id, skillId), eq(companySkills.companyId, companyId)))
    .limit(1);
  const current = rows[0]?.metadata;
  const metadata = { ...(isRecord(current) ? current : {}), ...patch };
  await db
    .update(companySkills)
    .set({ metadata, updatedAt: new Date() })
    .where(and(eq(companySkills.id, skillId), eq(companySkills.companyId, companyId)));
}

/** The skill's managed directory on disk, off the catalog row. The directory
 *  layout under the managed root is the service's own convention (it resolves
 *  a local_path skill's sourceLocator to the directory); this port only
 *  writes the files the import decided on into it. */
function skillDirectoryOf(skill: CatalogSkill): string {
  if (skill.sourceType !== "local_path" || !skill.sourceLocator) {
    throw new Error(`skill ${skill.id} has no managed directory (sourceType ${skill.sourceType})`);
  }
  return path.resolve(skill.sourceLocator);
}

/** The skill's current files as (path, content), from its managed directory. */
async function readDirectoryFiles(skill: CatalogSkill): Promise<BackimportSkillFile[]> {
  const root = skillDirectoryOf(skill);
  const out: BackimportSkillFile[] = [];
  for (const entry of skill.fileInventory) {
    const content = await fs.readFile(path.join(root, entry.path), "utf8").catch(() => null);
    if (content !== null) out.push({ path: entry.path, content });
  }
  return out;
}

/** Replaces the managed directory's content with exactly `files`: the
 *  container's copy is the truth, so a file the bot deleted disappears here
 *  too (a stale file would survive into every version cut afterwards). */
async function writeSkillFiles(skill: CatalogSkill, files: readonly BackimportSkillFile[]): Promise<void> {
  const root = skillDirectoryOf(skill);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  for (const entry of files) {
    const target = path.resolve(root, entry.path);
    if (!target.startsWith(root + path.sep)) continue; // path escapes the skill dir: dropped, never written
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.content, "utf8");
  }
}

function sameFiles(left: readonly BackimportSkillFile[], right: readonly BackimportSkillFile[]): boolean {
  if (left.length !== right.length) return false;
  const byPath = new Map(left.map((entry) => [entry.path, entry.content]));
  return right.every((entry) => byPath.get(entry.path) === entry.content);
}
