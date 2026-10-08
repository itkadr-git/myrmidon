// server/src/myrmidon/bot-containers/skill-backimport.ts
//
// myrmidon(1.6.5-BOT-SKILL-BACKIMPORT, OPE-6401/OPE-5906): the reverse
// direction of the skills pipeline. The compiler delivers a card's catalog
// skills into the container at hermes/skills-board/ (a managed directory the
// profile owns outright, template.ts BOT_MANAGED_DIRS). The bot's OWN skills
// — the ones it created itself at runtime — live at hermes/skills/
// (the container's ~/.hermes/skills), on the bot's volume, which a recreate
// can drop (template drift replaces the container; volumes survive, but a
// host cleanup or a volume reset does not have to).
//
// With MYRMIDON_BOT_SKILL_BACKIMPORT on (off by default), every reconcile
// pass of a live bot also reads hermes/skills/ back out of the container and
// hands the skills found there to this module, which upserts them into the
// company skill catalog (sourceKind "bot_backimport", key
// `company/<companyId>/<slug>` — the same shape a UI-created local skill
// gets, so the runtime name, the lifecycle and the compiler treat them like
// any other company skill). A skill whose content is already in the catalog
// unchanged is skipped (no new version, no write). An imported skill is a
// lifecycle *candidate*: it reaches the pilot agents of the company through
// the normal delivery path, and an operator verifies it to fleet-wide.
//
// The read-back is deliberately not part of the compiled profile: the
// profile is the board -> bot direction, and this module never feeds the
// bot's own skills back into the same bot's profile. A skill the board
// delivered (skills-board/) and the bot copied or edited under hermes/skills/
// is imported as the company's own copy — from the catalog's point of view
// it is a new local skill, which is exactly what "the bot changed it" means.
//
// Everything here is pure or goes through the two injected ports, so the
// rules (slug mapping, skip-unchanged, failure containment) are tested
// against fakes like the rest of the bot-containers rules. A failing import
// is reported and contained to that one skill: one broken skill directory in
// one container must not fail the reconcile pass or the other skills.

import { createHash } from "node:crypto";

/** The environment flag the whole feature sits behind. Off by default. */
export const BOT_SKILL_BACKIMPORT_ENV = "MYRMIDON_BOT_SKILL_BACKIMPORT";

/** Profile path of the bot's own skills directory (template.ts mountRootSegment
 *  of the hermes mount). The board's own delivery lives in the sibling
 *  `hermes/skills-board`, which the profile owns — never read back. */
export const BOT_SKILLS_PROFILE_DIR = "hermes/skills";

export function isBotSkillBackimportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[BOT_SKILL_BACKIMPORT_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** One file of a bot-owned skill, as read out of the container. */
export interface BackimportSkillFile {
  /** Forward-slash path relative to the skill directory ("SKILL.md", "scripts/run.sh"). */
  path: string;
  content: string;
}

/** One skill directory under hermes/skills/, as read out of the container. */
export interface BackimportSkill {
  /** The container directory name (hermes/skills/<name>/). Used as the skill
   *  slug — it is what the bot itself called the skill. */
  name: string;
  files: BackimportSkillFile[];
}

export interface BackimportSkillResult {
  name: string;
  /** Catalog key the skill was written under (company/<companyId>/<slug>). */
  key: string;
  outcome: "created" | "updated" | "unchanged";
  /** New version id for created/updated, the unchanged current one for unchanged. */
  versionId: string | null;
}

export interface BackimportFailure {
  name: string;
  error: string;
}

export interface BackimportSummary {
  imported: BackimportSkillResult[];
  failed: BackimportFailure[];
}

/** What the import needs from the board's skill catalog. Bound in
 *  skill-backimport-ports.ts to companySkillService; tests pass fakes. */
export interface BotSkillBackimportPorts {
  /** The company's existing skill for this catalog key, with its current
   *  version's file inventory (path + content), or null. */
  readSkillByKey(
    companyId: string,
    key: string,
  ): Promise<{ id: string; files: BackimportSkillFile[] } | null>;
  /** Creates the skill (slug, name, files) as a company-local skill with an
   *  initial version; returns the new skill id and version id. */
  createSkill(
    companyId: string,
    input: { slug: string; name: string; files: BackimportSkillFile[] },
  ): Promise<{ id: string; versionId: string | null }>;
  /** Replaces the skill's files with `files` and cuts a new version when the
   *  content changed; returns the new (or unchanged) version id. */
  updateSkill(
    companyId: string,
    skillId: string,
    input: { name: string; files: BackimportSkillFile[] },
  ): Promise<{ versionId: string | null; changed: boolean }>;
}

/**
 * Maps a container skill directory name to a catalog slug. Hermes skill
 * directories are already slug-shaped for skills created through its own
 * machinery; a name that is not is normalized (lower-cased, runs of unsafe
 * characters to a dash) and an empty result becomes "skill". Collisions of two
 * different directory names mapping to one slug surface as a normal catalog
 * conflict on the shared key — the second import is an update of the first,
 * which is the safer of the two wrong answers (it never duplicates the skill
 * under two keys).
 */
export function skillSlugFromDirName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : "skill";
}

/** Stable content fingerprint of one skill's file set: what "unchanged" is
 *  decided on. Sorted by path so the container's enumeration order never
 *  matters. */
export function skillFilesHash(files: readonly BackimportSkillFile[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return createHash("sha256")
    .update(JSON.stringify(sorted.map((entry) => [entry.path, entry.content])))
    .digest("hex");
}

/**
 * Imports every skill of one container read into the company catalog. Never
 * throws: a skill that fails to import (no SKILL.md, a catalog error) lands in
 * `failed` with the message, and the rest still import. A skill whose files
 * hash to the catalog copy's hash is `unchanged` — no version is cut, so an
 * untouched bot skill does not grow a version per sweep.
 */
export async function backimportBotSkills(
  companyId: string,
  skills: readonly BackimportSkill[],
  ports: BotSkillBackimportPorts,
): Promise<BackimportSummary> {
  const imported: BackimportSkillResult[] = [];
  const failed: BackimportFailure[] = [];
  for (const skill of skills) {
    const slug = skillSlugFromDirName(skill.name);
    const key = `company/${companyId}/${slug}`;
    try {
      const result = await backimportOneSkill(companyId, key, slug, skill, ports);
      imported.push(result);
    } catch (err) {
      failed.push({ name: skill.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { imported, failed };
}

async function backimportOneSkill(
  companyId: string,
  key: string,
  slug: string,
  skill: BackimportSkill,
  ports: BotSkillBackimportPorts,
): Promise<BackimportSkillResult> {
  const skillMd = skill.files.find((entry) => entry.path === "SKILL.md");
  if (!skillMd) {
    throw new Error(`skill ${skill.name}: no SKILL.md in the container copy, skipped`);
  }
  const files = [...skill.files].sort((a, b) => a.path.localeCompare(b.path));
  const existing = await ports.readSkillByKey(companyId, key);
  if (!existing) {
    const created = await ports.createSkill(companyId, {
      slug,
      name: skillNameFromMarkdown(skillMd.content) ?? slug,
      files,
    });
    return { name: skill.name, key, outcome: "created", versionId: created.versionId };
  }
  if (skillFilesHash(existing.files) === skillFilesHash(files)) {
    // No re-read for the version id: nothing was written, so there is no new
    // version to name, and the result does not carry the current one.
    return { name: skill.name, key, outcome: "unchanged", versionId: null };
  }
  const updated = await ports.updateSkill(companyId, existing.id, {
    name: skillNameFromMarkdown(skillMd.content) ?? slug,
    files,
  });
  return { name: skill.name, key, outcome: updated.changed ? "updated" : "unchanged", versionId: updated.versionId };
}

/** The `name:` frontmatter field of a SKILL.md, when present — the display
 *  name the catalog entry gets. The body is never parsed here. */
function skillNameFromMarkdown(markdown: string): string | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const nameLine = match[1].split(/\r?\n/).find((line) => /^name\s*:/.test(line));
  if (!nameLine) return null;
  const value = nameLine.replace(/^name\s*:\s*/, "").replace(/^["']|["']$/g, "").trim();
  return value.length > 0 ? value : null;
}
