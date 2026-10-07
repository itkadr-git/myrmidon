// server/src/myrmidon/skill-backimport/policy.ts
//
// myrmidon(1.6.5-SKILL-BACKIMPORT): the pure half of the bot-skill back-import.
// A hermes_gateway bot that authors a skill keeps it in its own container
// volume (<bot root>/hermes/skills); recreating that volume loses the skill.
// This module classifies what the sweep read out of one container — which
// directories are bot-authored skills worth importing into the company
// catalog, what key/slug/markdown they get — so the sweep itself (sweep.ts)
// is a thin loop over injected ports and every decision is testable without
// a driver or a database.
//
// The rules, deliberately conservative (the sweep writes to the company
// library with no human in the loop):
//
//  - only directories that carry a parseable SKILL.md with a non-empty name
//    are skills at all;
//  - directories under skills.pre-myrmidon are the pre-migration backup the
//    H1 adapter move left behind, not bot work — never imported;
//  - a name that resolves to a slug already sitting in the company catalog
//    is the bot's own copy of a board skill (the profile compiler put it
//    there), not a new skill — skipped, so the back-import never re-imports
//    the board's own delivery;
//  - the catalog key is `company/<companyId>/<slug>` — the same shape a
//    locally created skill gets, so the lifecycle and the runtime cache
//    treat the import like any company-local skill;
//  - a skill whose inventory classifies as scripts_executables is still
//    imported (it is company-local, not an external source), but the caller
//    surfaces the trust level so an operator sees what arrived.
//
// Nothing here reads env, fs, or the db — the sweep injects those.

import { parseFrontmatterMarkdown } from "@paperclipai/shared";

/** Path prefix (relative to the skills root) of the pre-migration backup a
 *  bot's own H1 move leaves behind. Anything under it is not bot-authored
 *  work and is never imported. */
export const SKILL_BACKUP_PREFIX = "skills.pre-myrmidon/";

export const BACKIMPORT_KEY_PREFIX = "company";

export interface BackImportCandidateFile {
  /** Path relative to the skills root of one bot (portable, forward slashes). */
  path: string;
  content: string;
}

export interface BackImportSkill {
  /** Catalog key: company/<companyId>/<slug>. */
  key: string;
  slug: string;
  name: string;
  description: string | null;
  /** The SKILL.md markdown as read (frontmatter and body). */
  markdown: string;
  /** The rest of the skill's files (SKILL.md included) for the inventory. */
  files: BackImportCandidateFile[];
  /** Directory name under the skills root the skill came from. */
  directory: string;
}

export interface ClassifiedSkills {
  skills: BackImportSkill[];
  /** Human-readable reasons a directory was not imported (warnings surface in
   *  the sweep's log, never fail the pass). */
  skipped: Array<{ directory: string; reason: string }>;
}

/** Lowercase, hyphenated, alnum — the slug rule of the skills service
 *  (normalizeSkillSlug), re-derived here so the policy module has no service
 *  import. Returns null when nothing usable remains. */
export function normalizeBackImportSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Classify one bot's skills-root file listing. `files` carries every regular
 * file below the bot's skills root with its content, exactly as the read port
 * returned it; `existingKeys` is the set of catalog keys the company already
 * has (used to skip the board's own delivered copies); `existingSlugs` the
 * set of slugs already taken in the company (a slug collision renames the
 * import deterministically with the bot's directory name).
 */
export function classifyBotSkillFiles(input: {
  companyId: string;
  files: BackImportCandidateFile[];
  existingKeys: ReadonlySet<string>;
  existingSlugs: ReadonlySet<string>;
}): ClassifiedSkills {
  const { companyId, files, existingKeys, existingSlugs } = input;
  const skills: BackImportSkill[] = [];
  const skipped: ClassifiedSkills["skipped"] = [];

  // Group by the top-level skill directory. Files at the root itself (no
  // directory) are not a skill — Hermes discovers skills one directory deep.
  const byDirectory = new Map<string, BackImportCandidateFile[]>();
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.length < 2) continue;
    const directory = parts[0]!;
    if (directory === SKILL_BACKUP_PREFIX.replace(/\/$/, "")) continue;
    const relative = parts.slice(1).join("/");
    const bucket = byDirectory.get(directory) ?? [];
    bucket.push({ path: relative, content: file.content });
    byDirectory.set(directory, bucket);
  }

  for (const [directory, dirFiles] of [...byDirectory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const skillMd = dirFiles.find((file) => file.path === "SKILL.md");
    if (!skillMd) {
      skipped.push({ directory, reason: "no SKILL.md at the directory root" });
      continue;
    }
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = parseFrontmatterMarkdown(skillMd.content).frontmatter ?? {};
    } catch {
      skipped.push({ directory, reason: "SKILL.md frontmatter did not parse" });
      continue;
    }
    const name = asString(frontmatter.name);
    if (!name) {
      skipped.push({ directory, reason: "SKILL.md has no name" });
      continue;
    }
    const description = asString(frontmatter.description);
    const slug = normalizeBackImportSlug(asString(frontmatter.slug) ?? name) ?? normalizeBackImportSlug(directory);
    if (!slug) {
      skipped.push({ directory, reason: "no usable slug" });
      continue;
    }
    const key = `${BACKIMPORT_KEY_PREFIX}/${companyId}/${slug}`;
    if (existingKeys.has(key)) {
      // Already in the catalog: either this sweep imported it earlier or a
      // human created it. Not re-imported — content drift between the bot
      // copy and the catalog is resolved by the human through the lifecycle,
      // never by an unattended overwrite.
      continue;
    }
    if (existingSlugs.has(slug)) {
      // A different key already owns the slug (a github/url import with the
      // same leaf). The import must not shadow it, so it is skipped — the
      // operator renames on the board if the bot's skill is wanted.
      skipped.push({ directory, reason: `slug "${slug}" already used by another catalog skill` });
      continue;
    }
    skills.push({
      key,
      slug,
      name,
      description,
      markdown: skillMd.content,
      files: dirFiles,
      directory,
    });
  }

  return { skills, skipped };
}

export type BackImportInventoryKind = "skill" | "markdown" | "reference" | "script" | "asset" | "other";

export interface BackImportInventoryEntry {
  path: string;
  kind: BackImportInventoryKind;
  content: string;
}

const SCRIPT_EXTENSIONS = [".sh", ".js", ".mjs", ".cjs", ".ts", ".py", ".rb", ".bash"];
const ASSET_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".pdf"];

/** The inventory kind of one file, same classification the catalog service
 *  applies (classifyInventoryKind), kept here so the sweep's payload is fully
 *  computed in the pure module. */
export function classifyBackImportFileKind(relativePath: string): BackImportInventoryKind {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  if (normalized.endsWith("/skill.md") || normalized === "skill.md") return "skill";
  if (normalized.startsWith("references/")) return "reference";
  if (normalized.startsWith("scripts/")) return "script";
  if (normalized.startsWith("assets/")) return "asset";
  if (normalized.endsWith(".md")) return "markdown";
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (SCRIPT_EXTENSIONS.some((ext) => fileName.endsWith(ext))) return "script";
  if (ASSET_EXTENSIONS.some((ext) => fileName.endsWith(ext))) return "asset";
  return "other";
}

export type BackImportTrustLevel = "markdown_only" | "assets" | "scripts_executables";

/** The trust level a skill's inventory earns, same rule as the catalog
 *  service's deriveTrustLevel. */
export function deriveBackImportTrustLevel(inventory: Array<{ kind: BackImportInventoryKind }>): BackImportTrustLevel {
  if (inventory.some((entry) => entry.kind === "script")) return "scripts_executables";
  if (inventory.some((entry) => entry.kind === "asset" || entry.kind === "other")) return "assets";
  return "markdown_only";
}

/** Build the full inventory (with contents) of one classified skill. */
export function buildBackImportInventory(skill: BackImportSkill): BackImportInventoryEntry[] {
  // Byte-order sort (not localeCompare): the same inventory on every host.
  return skill.files
    .map((file) => ({ path: file.path, kind: classifyBackImportFileKind(file.path), content: file.content }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
