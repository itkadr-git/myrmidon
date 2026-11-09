import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function git(repo, args, options = {}) {
  const r = spawnSync(options.gitBin || "git", ["-C", repo, ...args], {
    encoding: "utf8", input: options.input, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.error || r.status !== 0) throw new Error(`git ${args[0]} failed for ${repo}: ${(r.stderr || r.error?.message || "").slice(0, 300)}`);
  return r.stdout;
}

function copyObjects(source, target) {
  const copyTree = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name === "info") continue; // alternates must not be inherited
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) copyTree(src, dst);
      else if (entry.isFile()) {
        if (fs.existsSync(dst)) {
          // Same pack name must mean the same bytes. Never overwrite a live pack.
          if (fs.statSync(src).size !== fs.statSync(dst).size || !fs.readFileSync(src).equals(fs.readFileSync(dst))) {
            throw new Error(`object collision at ${dst}`);
          }
        } else {
          try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
        }
      }
    }
  };
  copyTree(path.join(source, "objects"), path.join(target, "objects"));
}

/** Idempotent normalization of old mixed-case git-base directories at botd startup.
 * A source is removed only after its refs and *all* objects (including unreachable
 * objects) are available in the canonical base. Linked worktrees keep their base.
 */
export function normalizeGitBases(root, { gitBin = "git", log = () => {} } = {}) {
  const options = { gitBin };
  const results = [];
  if (!fs.existsSync(root)) return results;
  for (const owner of fs.readdirSync(root, { withFileTypes: true })) {
    if (!owner.isDirectory() || owner.isSymbolicLink()) continue;
    const ownerDir = path.join(root, owner.name);
    for (const repo of fs.readdirSync(ownerDir, { withFileTypes: true })) {
      if (!repo.isDirectory() || repo.isSymbolicLink() || !repo.name.endsWith(".git")) continue;
      const source = path.join(ownerDir, repo.name);
      const target = path.join(root, owner.name.toLowerCase(), repo.name.toLowerCase());
      if (source === target || !fs.existsSync(path.join(source, "HEAD"))) continue;
      try {
        // A linked copy has a gitdir pointing into this base; renaming or deleting
        // it would break the copy even when the objects exist elsewhere.
        if (git(source, ["worktree", "list", "--porcelain"], options).split("\n").filter((line) => line.startsWith("worktree ")).length > 1) {
          log(`botd git-base: deferred ${source}: linked worktrees`);
          continue;
        }
        if (!fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(source, target);
        } else {
          if (!fs.existsSync(path.join(target, "HEAD"))) throw new Error("canonical target is not a bare repository");
          // Copy all objects before refs; interruption is harmless and the next
          // startup retries. Retain conflicting refs under the legacy path.
          copyObjects(source, target);
          const refs = git(source, ["for-each-ref", "--format=%(refname) %(objectname)"], options).trim().split("\n").filter(Boolean);
          for (const line of refs) {
            const [ref, oid] = line.split(" ");
            const existing = spawnSync(gitBin, ["-C", target, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf8" });
            if (existing.status === 0 && existing.stdout.trim() !== oid) throw new Error(`conflicting ref ${ref}`);
            if (existing.status !== 0) git(target, ["update-ref", ref, oid], options);
          }
          git(target, ["fsck", "--full", "--connectivity-only"], options);
          const oids = git(source, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"], options);
          const input = oids.trim();
          if (input) {
            const verified = git(target, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { ...options, input: `${input}\n` });
            if (verified.split("\n").some((line) => line.endsWith(" missing"))) throw new Error("canonical target is missing objects");
          }
          fs.rmSync(source, { recursive: true });
        }
        results.push({ source, target });
        log(`botd git-base: normalized ${source} -> ${target}`);
      } catch (err) {
        log(`botd git-base: deferred ${source}: ${err.message}`);
      }
    }
    if (owner.name !== owner.name.toLowerCase() && fs.existsSync(ownerDir) && fs.readdirSync(ownerDir).length === 0) fs.rmdirSync(ownerDir);
  }
  return results;
}
