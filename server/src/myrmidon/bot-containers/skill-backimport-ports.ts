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
// Lifecycle: an imported or updated skill is (left as) a *candidate* — it
// reaches the company's pilot agents on the next compile tick, and an
// operator verifies it to fleet-wide. The back-import never promotes.

import path from "node:path";
import fs from "node:fs/promises";

import type { Db } from "@paperclipai/db";
import { companySkillService } from "../../services/index.js";
import type {
  BackimportSkillFile,
  BotSkillBackimportPorts,
} from "./skill-backimport.js";

/**
 * The directory the catalog service manages a company-local skill in is
 * derived from the service's own sourceLocator (it resolves to
 * <managedRoot>/<slug>), never recomputed here: the layout is the service's
 * business, this port only writes the files the import decided on into it.
 */
export function createDbBotSkillBackimportPorts(db: Db): BotSkillBackimportPorts {
  const skills = companySkillService(db);

  return {
    async readSkillByKey(companyId, key) {
      const skill = await skills.getByKey(companyId, key);
      if (!skill) return null;
      const files: BackimportSkillFile[] = [];
      for (const entry of skill.fileInventory) {
        const detail = await skills.readFile(companyId, skill.id, entry.path);
        if (!detail) continue;
        files.push({ path: entry.path, content: detail.content });
      }
      return { id: skill.id, files };
    },

    async createSkill(companyId, input) {
      const skill = await skills.createLocalSkill(companyId, {
        slug: input.slug,
        name: input.name,
        // The markdown is the container's own SKILL.md; the rest of the files
        // are laid down below (createLocalSkill writes SKILL.md only).
        markdown: input.files.find((entry) => entry.path === "SKILL.md")?.content,
      });
      await writeSkillFiles(skill, input.files);
      // The files write changed the directory after the initial version: cut
      // the version that carries the whole file set, so the runtime catalogue
      // resolves the imported skill complete, not SKILL.md alone.
      const version = await skills.createVersion(companyId, skill.id, { label: "Back-imported from a bot container" });
      return { id: skill.id, versionId: version.id };
    },

    async updateSkill(companyId, skillId, input) {
      const skill = await skills.getById(companyId, skillId);
      if (!skill) throw new Error(`skill ${skillId} not found`);
      const before = await readDirectoryFiles(skill);
      await writeSkillFiles(skill, input.files);
      const changed = !sameFiles(before, input.files);
      if (!changed) {
        return { versionId: skill.currentVersionId, changed: false };
      }
      const version = await skills.createVersion(companyId, skillId, { label: "Back-imported from a bot container" });
      return { versionId: version.id, changed: true };
    },
  };
}

type CatalogSkill = NonNullable<Awaited<ReturnType<ReturnType<typeof companySkillService>["getByKey"]>>>;

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
