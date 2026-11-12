import { describe, expect, it } from "vitest";
import { shouldExcludePath } from "./exclude-patterns.js";
import {
  SSH_WORKSPACE_REPRODUCIBLE_DIR_NAMES,
  dropTrackedSshWorkspaceExcludeNames,
  parseSshWorkspaceExcludeSetting,
  resolveSshWorkspaceExcludeNames,
  sshWorkspaceExcludePatterns,
} from "./ssh-workspace-excludes.js";

// myrmidon(OPE-12809)
describe("ssh workspace excludes", () => {
  it("excludes package manager output, caches and build output by default", () => {
    expect(resolveSshWorkspaceExcludeNames({ setting: null })).toEqual([
      "node_modules",
      ".pnpm-store",
      ".npm",
      ".cache",
      ".turbo",
      "dist",
      "build",
      ".next",
      "coverage",
    ]);
    expect(resolveSshWorkspaceExcludeNames({ setting: null })).toEqual([...SSH_WORKSPACE_REPRODUCIBLE_DIR_NAMES]);
  });

  it("matches the excluded names at any depth and leaves sources alone", () => {
    const patterns = sshWorkspaceExcludePatterns(resolveSshWorkspaceExcludeNames({ setting: null }));
    for (const excluded of [
      "node_modules",
      "node_modules/vitest/package.json",
      "repo/node_modules",
      "repo/node_modules/.pnpm/a/index.js",
      ".scratch/wt/packages/db/node_modules/drizzle-orm/index.js",
      ".pnpm-store/v10/files/00/aa",
      "ui/dist/assets/index.js",
      "server/coverage/lcov.info",
      "ui/.next/cache/x",
    ]) {
      expect(shouldExcludePath(excluded, patterns), excluded).toBe(true);
    }
    for (const kept of [
      "package.json",
      "pnpm-lock.yaml",
      "server/src/services/heartbeat.ts",
      "server/src/new-file.ts",
      "packages/adapter-utils/src/ssh.ts",
      "docs/distribution.md",
      "scripts/build.mjs",
      "server/src/vendor/lib.ts",
      ".scratch/notes.md",
    ]) {
      expect(shouldExcludePath(kept, patterns), kept).toBe(false);
    }
  });

  it("extends and narrows the list through the setting", () => {
    expect(parseSshWorkspaceExcludeSetting(" .scratch, target\n-build ")).toEqual({
      add: [".scratch", "target"],
      remove: ["build"],
      rejected: [],
    });
    const names = resolveSshWorkspaceExcludeNames({ setting: ".scratch,target,-build,node_modules" });
    expect(names).toContain(".scratch");
    expect(names).toContain("target");
    expect(names).not.toContain("build");
    expect(names.filter((name) => name === "node_modules")).toHaveLength(1);
  });

  it("rejects names that are paths, globs or the transfer's own directories", () => {
    const parsed = parseSshWorkspaceExcludeSetting("src/generated ../x *.log .git -.paperclip-runtime ok");
    expect(parsed.add).toEqual(["ok"]);
    expect(parsed.remove).toEqual([]);
    expect(parsed.rejected).toEqual(["src/generated", "../x", "*.log", ".git", "-.paperclip-runtime"]);
  });

  it("keeps a name in the transfer when git tracks files under it", () => {
    const names = resolveSshWorkspaceExcludeNames({ setting: null });
    const kept = dropTrackedSshWorkspaceExcludeNames(names, [
      "package.json",
      "tools/build/plugin.ts",
      "site/dist/index.html",
      "server/src/rebuild/dist.ts",
    ]);
    expect(kept).not.toContain("build");
    expect(kept).not.toContain("dist");
    expect(kept).toContain("node_modules");
    expect(kept).toContain("coverage");
  });
});
