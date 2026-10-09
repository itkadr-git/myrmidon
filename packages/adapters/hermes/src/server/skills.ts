import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  ensurePaperclipSkillSymlink,
  isPaperclipSkillSourceMissing,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { fileURLToPath } from "node:url";
import {
  moveOccupiedSkillTargetAside,
  moveSkillTargetLinkAside,
  pointsIntoVendorSkillsHome,
  resolveHermesSkillsHome,
  SKILL_BACKUP_DIR,
} from "./myrmidon-skills-home.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: unknown = line.slice(idx + 1).trim();
    // Strip quotes
    if (typeof val === "string" && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    frontmatter[key] = val;
  }
  return frontmatter as SkillFrontmatter;
}

async function scanHermesSkills(
  skillsHome: string,
  locationRoot = "~/.hermes/skills", // myrmidon(H1): label the profile skills directory
): Promise<AdapterSkillEntry[]> {
  const entries: AdapterSkillEntry[] = [];

  try {
    const categories = await fs.readdir(skillsHome, { withFileTypes: true });
    for (const cat of categories) {
      if (!cat.isDirectory()) continue;
      const catPath = path.join(skillsHome, cat.name);

      // Check if the category directory itself has a SKILL.md (top-level skill)
      const topLevelSkillMd = path.join(catPath, "SKILL.md");
      if (await fs.stat(topLevelSkillMd).catch(() => null)) {
        entries.push(await buildSkillEntry(cat.name, topLevelSkillMd, cat.name, locationRoot));
      }

      // Scan for sub-skills
      const items = await fs.readdir(catPath, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        if (!item.isDirectory()) continue;
        const skillMd = path.join(catPath, item.name, "SKILL.md");
        if (await fs.stat(skillMd).catch(() => null)) {
          const key = item.name;
          entries.push(await buildSkillEntry(key, skillMd, `${cat.name}/${item.name}`, locationRoot));
        }
      }
    }
  } catch {
    // ~/.hermes/skills/ doesn't exist — no skills available
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

async function buildSkillEntry(
  key: string,
  skillMdPath: string,
  categoryPath: string,
  locationRoot = "~/.hermes/skills",
): Promise<AdapterSkillEntry> {
  let description: string | null = null;
  try {
    const content = await fs.readFile(skillMdPath, "utf8");
    const fm = parseSkillFrontmatter(content);
    description = fm.description ?? null;
  } catch {
    // ignore
  }

  return {
    key,
    runtimeName: key,
    desired: true, // Hermes loads all available skills
    managed: false,
    state: "installed",
    origin: "user_installed",
    originLabel: "Hermes skill",
    locationLabel: `${locationRoot}/${categoryPath}`,
    readOnly: true, // Hermes manages its own skills — Paperclip can't toggle them
    sourcePath: skillMdPath,
    targetPath: null,
    detail: description,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function buildHermesSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  // myrmidon(H1): list skills from the agent's own profile when HERMES_HOME is set
  const { skillsHome: hermesSkillsHome, locationLabel } = resolveHermesSkillsHome(config);

  // 1. Scan Paperclip-managed skills (bundled with the adapter)
  const paperclipEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, paperclipEntries);
  const desiredSet = new Set(desiredSkills);
  const availableByKey = new Map(paperclipEntries.map((e) => [e.key, e]));

  // 2. Scan Hermes's own skills from ~/.hermes/skills/
  const hermesSkillEntries = await scanHermesSkills(hermesSkillsHome, locationLabel);
  const hermesKeys = new Set(hermesSkillEntries.map((e) => e.key));

  // 3. Merge: Paperclip skills first (ephemeral), then Hermes skills
  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [];

  // Paperclip-managed skills
  for (const entry of paperclipEntries) {
    const desired = desiredSet.has(entry.key);
    entries.push({
      key: entry.key,
      runtimeName: entry.runtimeName,
      desired,
      managed: true,
      state: desired ? "configured" : "available",
      origin: "company_managed",
      originLabel: "Managed by Paperclip",
      readOnly: false,
      sourcePath: entry.source,
      targetPath: null,
      detail: desired
        ? "Will be available on the next run via Hermes skill loading."
        : null,
    });
  }

  // Hermes-installed skills (read-only, always loaded)
  for (const entry of hermesSkillEntries) {
    // Skip if Paperclip already manages a skill with the same key
    if (availableByKey.has(entry.key)) continue;
    entries.push(entry);
  }

  // Check for desired skills that don't exist
  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill) || hermesKeys.has(desiredSkill)) continue;
    warnings.push(
      `Desired skill "${desiredSkill}" is not available in Paperclip or Hermes skills.`,
    );
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail:
        "Cannot find this skill in Paperclip or ~/.hermes/skills/.",
    });
  }

  return {
    adapterType: "hermes_local",
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listHermesSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildHermesSkillSnapshot(ctx.config);
}

// ---------------------------------------------------------------------------
// Skill links inside the agent's skills directory
// ---------------------------------------------------------------------------

type ManagedSkillEntry = Awaited<ReturnType<typeof readPaperclipRuntimeSkillEntries>>[number];

/** Destination a skill link names, resolved but never followed. */
async function readSkillLinkDestination(target: string): Promise<string | null> {
  const linkedPath = await fs.readlink(target).catch(() => null);
  return linkedPath ? path.resolve(path.dirname(target), linkedPath) : null;
}

async function linkDestinationIsReachable(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
}

/**
 * myrmidon(H1): the proof that the desired skills arrived. reconcile() trusts
 * what the shared install helper reported; this pass reads the agent's skills
 * directory again and names every desired skill whose link is absent, broken,
 * foreign or pointed at the wrong source. One readdir plus one readlink per
 * desired skill — no re-scan of the skill sources.
 */
export async function verifyHermesPaperclipSkillLinks(
  config: Record<string, unknown>,
  desiredSkills: string[],
  availableEntries: ManagedSkillEntry[],
): Promise<string[]> {
  const problems: string[] = [];
  if (desiredSkills.length === 0) return problems;

  const { skillsHome } = resolveHermesSkillsHome(config);
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const dirents = await fs
    .readdir(skillsHome, { withFileTypes: true })
    .catch(() => [] as Array<{ name: string; isSymbolicLink(): boolean }>);
  const direntsByName = new Map(dirents.map((dirent) => [dirent.name, dirent]));

  for (const key of desiredSkills) {
    const entry = availableByKey.get(key);
    if (!entry) {
      problems.push(`"${key}" has no Paperclip-managed source to link`);
      continue;
    }
    if (isPaperclipSkillSourceMissing(entry)) {
      problems.push(`"${key}" files are unavailable (${entry.source})`);
      continue;
    }
    const target = path.join(skillsHome, entry.runtimeName);
    const dirent = direntsByName.get(entry.runtimeName);
    if (!dirent) {
      problems.push(`"${key}" is missing from ${skillsHome}`);
      continue;
    }
    if (!dirent.isSymbolicLink()) {
      problems.push(`"${key}" at ${target} is not a Paperclip-managed link`);
      continue;
    }
    const destination = await readSkillLinkDestination(target);
    if (destination !== path.resolve(entry.source)) {
      problems.push(
        `"${key}" at ${target} points at ${destination ?? "an unreadable target"} instead of ${entry.source}`,
      );
      continue;
    }
    if (!(await linkDestinationIsReachable(target))) {
      problems.push(`"${key}" at ${target} is a dangling link`);
    }
  }

  return problems;
}

export async function reconcileHermesPaperclipSkills(
  config: Record<string, unknown>,
  requestedDesiredSkills?: string[],
  // myrmidon(H1): run-log sink for moving a profile's own skill copy aside
  options: { onLog?: (line: string) => Promise<void> | void } = {},
): Promise<string[]> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = requestedDesiredSkills
    ? Array.from(new Set([
        ...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries),
        ...requestedDesiredSkills,
      ]))
    : resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  // myrmidon(H1): install into the agent's own profile when HERMES_HOME is set
  const { skillsHome, backupRoot, vendorSkillsHome } = resolveHermesSkillsHome(config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const entry of availableEntries) {
    if (!desiredSet.has(entry.key) || isPaperclipSkillSourceMissing(entry)) continue;
    const target = path.join(skillsHome, entry.runtimeName);
    // myrmidon(H1): links the early rollout left in a profile. A link into the
    // shared vendor skills home is relinked to the managed source; a link whose
    // destination is gone is moved aside (never deleted) instead of letting the
    // shared helper repair it in place. Only profiles: without HERMES_HOME the
    // agent works in the vendor scope and its links stay as they are.
    if (backupRoot) {
      const occupant = await fs.lstat(target).catch(() => null);
      if (occupant?.isSymbolicLink()) {
        const destination = await readSkillLinkDestination(target);
        if (destination && destination !== path.resolve(entry.source)) {
          if (!(await linkDestinationIsReachable(target))) {
            const movedLink = await moveSkillTargetLinkAside(target, backupRoot);
            if (movedLink) {
              await options.onLog?.(
                `[hermes] Moved the profile's broken "${entry.runtimeName}" skill link to ${SKILL_BACKUP_DIR}/${movedLink} and linked the managed skill.\n`,
              );
            }
          } else if (pointsIntoVendorSkillsHome(destination, vendorSkillsHome)) {
            await fs.unlink(target);
            await options.onLog?.(
              `[hermes] Relinked the profile's "${entry.runtimeName}" skill from the shared Hermes skills home to the managed skill.\n`,
            );
          }
        }
      }
    }
    // myrmidon(H1): a real directory in the profile is kept under a backup name, never deleted
    const movedAside = backupRoot ? await moveOccupiedSkillTargetAside(target, backupRoot) : null;
    if (movedAside) {
      await options.onLog?.(
        `[hermes] Moved the profile's own "${entry.runtimeName}" skill to ${SKILL_BACKUP_DIR}/${movedAside} and linked the managed skill.\n`,
      );
    }
    await ensurePaperclipSkillSymlink(entry.source, target);
    const linkedSource = await fs.readlink(target).catch(() => null);
    const resolvedSource = linkedSource
      ? path.resolve(path.dirname(target), linkedSource)
      : null;
    if (resolvedSource !== path.resolve(entry.source)) {
      throw new Error(
        `Cannot reconcile Hermes skill "${entry.key}" because ${target} is occupied by another installation.`,
      );
    }
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available || desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  // myrmidon(H1): proof of delivery — a linked skill is only "delivered" if the
  // link is really in the agent's skills directory and points at its source.
  // Check the result instead of trusting what the install calls reported.
  const problems = await verifyHermesPaperclipSkillLinks(config, desiredSkills, availableEntries);
  if (problems.length > 0) {
    throw new Error(
      `Hermes skill delivery check failed for ${skillsHome}: ${problems.join("; ")}.`,
    );
  }

  return desiredSkills;
}

export async function syncHermesSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  await reconcileHermesPaperclipSkills(ctx.config, desiredSkills);
  return buildHermesSkillSnapshot(ctx.config);
}

export function resolveHermesDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string[] {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}
