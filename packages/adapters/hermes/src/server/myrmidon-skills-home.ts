import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// myrmidon(H1): install Paperclip-managed skills into the agent's own Hermes
// profile. Hermes isolates a profile through HERMES_HOME and keeps HOME shared,
// so agents sharing HOME must not share (and prune) one skills directory.

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function configEnv(config: Record<string, unknown>): Record<string, unknown> {
  return typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
    ? (config.env as Record<string, unknown>)
    : {};
}

/** Profile subdirectory that keeps skill copies moved aside by the adapter. */
export const SKILL_BACKUP_DIR = "skills.pre-myrmidon";

export interface HermesSkillsHome {
  /** Absolute directory Hermes reads skills from for this agent. */
  skillsHome: string;
  /** Path shown to operators, relative to the profile root. */
  locationLabel: string;
  /** True when the agent has its own HERMES_HOME profile. */
  profileScoped: boolean;
  /**
   * Where a profile's own copy of a managed skill is moved. It sits outside the
   * skills directory: Hermes discovers every SKILL.md below it by frontmatter
   * name, so a backup left there would collide with the managed skill.
   */
  backupRoot: string | null;
  /**
   * myrmidon(H1): the shared vendor-scope skills directory
   * (`<HOME>/.hermes/skills`) Hermes falls back to without HERMES_HOME. A
   * profile link that resolves into it is a leftover of the early rollout: the
   * profile pointed at the one shared copy instead of the managed source.
   */
  vendorSkillsHome: string;
}

/**
 * `<HERMES_HOME>/skills` when the agent configures HERMES_HOME, otherwise the
 * vendor default `<HOME>/.hermes/skills`.
 */
export function resolveHermesSkillsHome(config: Record<string, unknown>): HermesSkillsHome {
  const env = configEnv(config);
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  const hermesHome = asString(env.HERMES_HOME);
  if (!hermesHome) {
    const vendorSkillsHome = path.join(home, ".hermes", "skills");
    return {
      skillsHome: vendorSkillsHome,
      locationLabel: "~/.hermes/skills",
      profileScoped: false,
      backupRoot: null,
      vendorSkillsHome,
    };
  }
  const expanded =
    hermesHome === "~"
      ? home
      : hermesHome.startsWith("~/")
        ? path.join(home, hermesHome.slice(2))
        : hermesHome;
  const profileRoot = path.resolve(expanded);
  return {
    skillsHome: path.join(profileRoot, "skills"),
    locationLabel: "$HERMES_HOME/skills",
    profileScoped: true,
    backupRoot: path.join(profileRoot, SKILL_BACKUP_DIR),
    vendorSkillsHome: path.join(home, ".hermes", "skills"),
  };
}

function backupStamp(now: Date): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/**
 * Moves a real directory or file that occupies a managed skill's link target to
 * `<backupRoot>/<name>.pre-myrmidon-<YYYYMMDD>` (with a numeric suffix when that
 * name is taken) so the managed link can be created. Nothing is ever deleted.
 * Returns the backup's base name, or null when the target is absent or a
 * symlink.
 */
export async function moveOccupiedSkillTargetAside(
  target: string,
  backupRoot: string,
  now: Date = new Date(),
): Promise<string | null> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing || existing.isSymbolicLink()) return null;
  await fs.mkdir(backupRoot, { recursive: true });
  const base = `${path.basename(target)}.pre-myrmidon-${backupStamp(now)}`;
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const name = attempt === 1 ? base : `${base}-${attempt}`;
    const destination = path.join(backupRoot, name);
    if (await fs.lstat(destination).catch(() => null)) continue;
    await fs.rename(target, destination);
    return name;
  }
  throw new Error(`Cannot move the existing "${path.basename(target)}" skill aside: too many backups.`);
}

/**
 * myrmidon(H1): true when a skill link's destination lives inside the shared
 * vendor skills home. Such a link was made by hand during the early rollout —
 * it points at the one shared copy of the skill instead of the managed source —
 * so reconcile relinks it to the managed source it belongs to.
 */
export function pointsIntoVendorSkillsHome(
  destination: string,
  vendorSkillsHome: string,
): boolean {
  const resolvedDestination = path.resolve(destination);
  const resolvedVendor = path.resolve(vendorSkillsHome);
  return (
    resolvedDestination === resolvedVendor ||
    resolvedDestination.startsWith(`${resolvedVendor}${path.sep}`)
  );
}

/**
 * myrmidon(H1): moves a symlink whose destination is gone — it can never
 * deliver a skill — to `<backupRoot>/<name>.pre-myrmidon-<YYYYMMDD>` (with a
 * numeric suffix when that name is taken) so the managed link can take its
 * place. The old link is kept as evidence; nothing is deleted. Returns the
 * backup's base name, or null when the target is absent or is not a symlink
 * (a real directory is left to moveOccupiedSkillTargetAside).
 */
export async function moveSkillTargetLinkAside(
  target: string,
  backupRoot: string,
  now: Date = new Date(),
): Promise<string | null> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing || !existing.isSymbolicLink()) return null;
  await fs.mkdir(backupRoot, { recursive: true });
  const base = `${path.basename(target)}.pre-myrmidon-${backupStamp(now)}`;
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const name = attempt === 1 ? base : `${base}-${attempt}`;
    const destination = path.join(backupRoot, name);
    if (await fs.lstat(destination).catch(() => null)) continue;
    await fs.rename(target, destination);
    return name;
  }
  throw new Error(
    `Cannot move the existing "${path.basename(target)}" skill link aside: too many backups.`,
  );
}
