// server/src/myrmidon/bot-containers/scope-migration.ts
//
// myrmidon(BOT-DISK-F): moves one bot's three directories (hermes, workspace,
// scratch) between host layouts when its isolation scope changes: from
// `<volumeRoot>/<botKey>/...` to `<scopeRoot>/<instance>/<botKey>/...` or back
// (or between two instances). The decision of WHAT moves is the pure planner in
// packages/shared (planScopeMigration); this file reads the host paths, runs the
// plan, and undoes it when a step fails.
//
// Rules, all enforced by the planner and the runner:
//   - nothing is ever deleted and nothing is overwritten: a directory is renamed
//     onto an absent or empty target; anything else is a conflict and the whole
//     plan is refused before the first step runs;
//   - rename only: the source and the target must be on one filesystem. A
//     cross-filesystem move (EXDEV) fails without a copy and is undone;
//   - a failed step undoes the steps already done, in reverse order;
//   - the caller (the driver's recreate) has stopped the container first, so
//     nothing writes while the directories move.
//
// The board process needs the host paths for this. When it cannot see the bot
// volume root, `check` refuses and says so: the move is then done by hand
// (docs/myrmidon/bot-disk-cache.md, "Changing an isolation scope").

import { lstat, mkdir, readdir, rename, rmdir } from "node:fs/promises";
import {
  planScopeMigration,
  type HostPathState,
  type ScopeLayout,
  type ScopeMigrationConflict,
  type ScopeMigrationStep,
  type ScopeRoots,
} from "@paperclipai/shared";

/** The host operations the migration needs; tests inject an in-memory one. */
export interface ScopeMigrationHost {
  state(path: string): Promise<HostPathState>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a directory the migration itself created and that is still empty. */
  rmdirEmpty(path: string): Promise<void>;
}

export class ScopeMigrationRefused extends Error {
  constructor(
    message: string,
    readonly conflicts: ScopeMigrationConflict[] = [],
  ) {
    super(message);
    this.name = "ScopeMigrationRefused";
  }
}

export function localScopeMigrationHost(): ScopeMigrationHost {
  return {
    async state(path) {
      try {
        const info = await lstat(path);
        if (!info.isDirectory()) return "other";
        return (await readdir(path)).length === 0 ? "empty-dir" : "dir";
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
        throw err;
      }
    },
    async mkdir(path) {
      await mkdir(path, { recursive: false, mode: 0o755 });
    },
    async rename(from, to) {
      await rename(from, to);
    },
    async rmdirEmpty(path) {
      await rmdir(path);
    },
  };
}

interface MigrationArgs {
  botKey: string;
  from: ScopeLayout;
  to: ScopeLayout;
}

/** The paths a plan reads: the three directories of each layout and the parents it may create. */
function pathsOf(roots: ScopeRoots, botKey: string, layout: ScopeLayout): string[] {
  const base = layout.kind === "isolated" ? `${roots.volumeRoot}/${botKey}` : `${roots.scopeRoot}/${layout.dirName}`;
  const bot = layout.kind === "isolated" ? base : `${base}/${botKey}`;
  return [...new Set([base, bot, `${bot}/hermes`, `${bot}/workspace`, `${bot}/scratch`])];
}

export function scopeMigrator(roots: ScopeRoots, host: ScopeMigrationHost = localScopeMigrationHost()) {
  async function plan(args: MigrationArgs) {
    const states = new Map<string, HostPathState>();
    for (const path of [...pathsOf(roots, args.botKey, args.from), ...pathsOf(roots, args.botKey, args.to)]) {
      states.set(path, await host.state(path));
    }
    const volumeRootState = await host.state(roots.volumeRoot);
    if (volumeRootState === "absent" || volumeRootState === "other") {
      throw new ScopeMigrationRefused(
        `the board cannot see the bot volume root ${roots.volumeRoot}; move the directories by hand (see the bot-disk-cache guide) and restart the bot`,
      );
    }
    return planScopeMigration({ roots, botKey: args.botKey, from: args.from, to: args.to, state: (path) => states.get(path) ?? "absent" });
  }

  return {
    /** Throws ScopeMigrationRefused when the move cannot run; changes nothing. */
    async check(args: MigrationArgs): Promise<void> {
      const result = await plan(args);
      if (!result.ok) {
        throw new ScopeMigrationRefused(
          `refusing to change the disk layout of bot ${args.botKey}: ${result.conflicts.map((c) => `${c.path} ${c.reason}`).join("; ")}`,
          result.conflicts,
        );
      }
    },

    /** Runs the plan; a failing step undoes the ones before it and rethrows. */
    async run(args: MigrationArgs): Promise<void> {
      const result = await plan(args);
      if (!result.ok) {
        throw new ScopeMigrationRefused(
          `refusing to change the disk layout of bot ${args.botKey}: ${result.conflicts.map((c) => `${c.path} ${c.reason}`).join("; ")}`,
          result.conflicts,
        );
      }
      const done: ScopeMigrationStep[] = [];
      try {
        for (const step of result.steps) {
          if (step.op === "mkdir") await host.mkdir(step.path);
          else await host.rename(step.from, step.to);
          done.push(step);
        }
      } catch (err) {
        for (const step of done.reverse()) {
          try {
            if (step.op === "move") await host.rename(step.to, step.from);
            else await host.rmdirEmpty(step.path);
          } catch {
            // Best effort: whatever could not be undone is reported by the original error and stays on disk.
          }
        }
        throw err;
      }
    },
  };
}
