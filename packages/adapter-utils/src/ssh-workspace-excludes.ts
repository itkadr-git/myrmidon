import { readProductEnv } from "@myrmidon/shared/env-alias";

// myrmidon(OPE-12809): the single list of directories that never travel
// between the board and an SSH execution host with the run workspace.
//
// Every entry is reproducible from the sources: package manager output and
// caches, and build output. An agent that ran `pnpm install` inside the
// workspace on the runner brought 3.3 GB of such files back to the board
// (run 8a1023a8: 563 MB went out, 3839 MB came back). The project workspace
// on the board is shared by all engineers, so every later run of every
// engineer uploaded and downloaded the same files again.
//
// A name matches a directory (or file) with that exact name at any depth. The
// names are skipped in both directions: they are not uploaded, not downloaded,
// and a copy that already exists on the board is left untouched.
export const SSH_WORKSPACE_REPRODUCIBLE_DIR_NAMES = [
  "node_modules",
  ".pnpm-store",
  ".npm",
  ".cache",
  ".turbo",
  "dist",
  "build",
  ".next",
  "coverage",
] as const;

// MYRMIDON_SSH_WORKSPACE_EXCLUDE extends or narrows the list without a code
// change. Names are separated by commas or whitespace; a leading "-" removes a
// default. Example: ".scratch,target,-build" adds .scratch and target and
// puts build back into the transfer.
export const SSH_WORKSPACE_EXCLUDE_ENV = "SSH_WORKSPACE_EXCLUDE";

// The transfer itself depends on these two; a setting can neither add nor
// remove them.
const RESERVED_NAMES = new Set([".git", ".paperclip-runtime"]);

function isPlainEntryName(value: string): boolean {
  if (value.length === 0 || value === "." || value === "..") return false;
  if (RESERVED_NAMES.has(value)) return false;
  // A single path segment without glob characters: the same string must mean
  // the same thing to tar on both hosts and to the baseline snapshot matcher.
  return !/[\\/*?[\]{}'"`$\s,]/.test(value);
}

export interface SshWorkspaceExcludeSetting {
  add: string[];
  remove: string[];
  rejected: string[];
}

export function parseSshWorkspaceExcludeSetting(raw: string | null | undefined): SshWorkspaceExcludeSetting {
  const add: string[] = [];
  const remove: string[] = [];
  const rejected: string[] = [];
  for (const token of (raw ?? "").split(/[\s,]+/)) {
    if (token.length === 0) continue;
    const negated = token.startsWith("-");
    const name = negated ? token.slice(1) : token;
    if (!isPlainEntryName(name)) {
      rejected.push(token);
      continue;
    }
    const bucket = negated ? remove : add;
    if (!bucket.includes(name)) bucket.push(name);
  }
  return { add, remove, rejected };
}

/**
 * The effective list of excluded names: the defaults, plus and minus the
 * MYRMIDON_SSH_WORKSPACE_EXCLUDE setting. `setting` overrides the environment
 * (tests pass it explicitly; `null` means "no setting").
 */
export function resolveSshWorkspaceExcludeNames(
  input: { setting?: string | null } = {},
): string[] {
  const raw = input.setting === undefined ? readProductEnv(SSH_WORKSPACE_EXCLUDE_ENV) : input.setting;
  const parsed = parseSshWorkspaceExcludeSetting(raw);
  const names: string[] = [];
  for (const name of [...SSH_WORKSPACE_REPRODUCIBLE_DIR_NAMES, ...parsed.add]) {
    if (parsed.remove.includes(name)) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Drops every name that is a path segment of a file git tracks. A repository
 * that keeps sources under `build/` or commits a `dist/` must still get the
 * agent's edits to those files back, so such a name is not excluded there.
 */
export function dropTrackedSshWorkspaceExcludeNames(
  names: readonly string[],
  trackedPaths: Iterable<string>,
): string[] {
  if (names.length === 0) return [];
  const wanted = new Set(names);
  const tracked = new Set<string>();
  for (const trackedPath of trackedPaths) {
    if (tracked.size === wanted.size) break;
    for (const segment of trackedPath.split("/")) {
      if (wanted.has(segment)) tracked.add(segment);
    }
  }
  return names.filter((name) => !tracked.has(name));
}

/**
 * Expands names into the pattern forms shared by tar `--exclude` and by the
 * baseline snapshot matcher (exclude-patterns.ts): the entry at the root, its
 * contents, and the same at any depth.
 */
export function sshWorkspaceExcludePatterns(names: readonly string[]): string[] {
  return names.flatMap((name) => [name, `${name}/*`, `*/${name}`, `*/${name}/*`]);
}
