// Bot disk settings (myrmidon BOT-DISK A and B): GET/PATCH /api/myrmidon/bot-disk.
//
// One instance setting, `general.botDisk`: the draft-directory lifecycle
// (part A) and the shared package cache path of development bots (part B).
// GET reports the values in force; PATCH (instance admins only) changes them
// without restarting the server. This client edits the cache path, the
// mirrored repositories (1.6.2-BOT-DISK-C) and the shared bot runtime
// (1.6.5-BOT-DISK-H11).
import { api } from "@/api/client";

export interface BotDiskView {
  settings: {
    enabled: boolean;
    idleTtlMs: number;
    /** Absent: no shared package cache. */
    sharedPackageCachePath?: string;
    /** `owner/repo` names with a host-side git mirror; absent: none. */
    gitMirrorRepos?: string[];
    gitMirrorRefreshMs?: number;
    pnpmStore?: "workspace" | "shared";
    /** pnpm store inside the bot's single mount; absent: /workspace/.pnpm-store. */
    pnpmStoreDir?: string;
    /** Absent: hardlink. */
    pnpmImportMethod?: "hardlink" | "clone-or-copy" | "copy";
    /**
     * The host directory of the shared bot runtime (1.6.5-BOT-DISK-H11):
     * every bot on the default host mounts its bin, lazy-packages and lsp
     * read-only over its own runtime paths. Absent: one copy per bot.
     */
    sharedBotRuntimePath?: string;
  };
  sources: Record<"enabled" | "idleTtlMs", "settings" | "env" | "default">;
}

export const botDiskQueryKey = ["myrmidon", "bot-disk"] as const;

export const botDiskApi = {
  get: () => api.get<BotDiskView>("/myrmidon/bot-disk"),
  /** null turns the shared package cache off. */
  setSharedPackageCachePath: (path: string | null) =>
    api.patch<BotDiskView>("/myrmidon/bot-disk", { sharedPackageCachePath: path }),
  /** null turns the shared bot runtime off (every bot keeps its own copy). */
  setSharedBotRuntimePath: (path: string | null) =>
    api.patch<BotDiskView>("/myrmidon/bot-disk", { sharedBotRuntimePath: path }),
  /** [] (or null) turns the git mirrors off. */
  setGitMirrorRepos: (repos: string[] | null) =>
    api.patch<BotDiskView>("/myrmidon/bot-disk", { gitMirrorRepos: repos }),
  /** null returns either value to its default. */
  setPnpm: (change: { pnpmStoreDir?: string | null; pnpmImportMethod?: "hardlink" | "clone-or-copy" | "copy" | null }) =>
    api.patch<BotDiskView>("/myrmidon/bot-disk", change),
};
