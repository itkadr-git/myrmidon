// myrmidon(1.7 KNOWLEDGE-2.0 L-13): the small git-backed record used by
// skill promotion and reconciliation. It deliberately uses git's executable
// rather than a shell, and never places credentials in arguments or logs.

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { GitSkillEntry, GitSkillFile } from "./domain.js";
import { assertSkillGitEntry, skillGitRelativePath, skillGitEnabled } from "./domain.js";
import type { SkillGitRecordPort } from "../skill-lifecycle/service.js";

const execFileAsync = promisify(execFile);

async function git(repository: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repository, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(root, absolute)));
    else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
  }
  return files;
}

export function createGitSkillRecordPort(input: {
  repository: string;
  push?: boolean;
  env?: NodeJS.ProcessEnv;
  onRefresh?: () => Promise<void>;
}): SkillGitRecordPort {
  const root = path.resolve(input.repository);
  const push = input.push ?? input.env?.MYRMIDON_SKILL_GIT_PUSH === "1";
  return {
    async refresh() {
      await git(root, ["pull", "--ff-only"]);
      await input.onRefresh?.();
    },
    async listEntries() {
      const skillsRoot = path.join(root, "skills");
      const files = await walk(skillsRoot).catch(() => []);
      const skillRoots = new Set(
        files
          .filter((file) => path.posix.basename(file).toLowerCase() === "skill.md")
          .map((file) => path.posix.dirname(file)),
      );
      const entries: GitSkillEntry[] = [];
      for (const key of skillRoots) {
        const skillRoot = path.join(skillsRoot, key);
        const entryFiles: GitSkillFile[] = [];
        for (const relative of await walk(skillRoot)) {
          entryFiles.push({ path: relative, content: await fs.readFile(path.join(skillRoot, relative), "utf8") });
        }
        if (entryFiles.length > 0) entries.push({ key, files: entryFiles });
      }
      return entries;
    },
    async recordVerified({ key, files, revisionNumber }) {
      const entry = assertSkillGitEntry({ key, files });
      await fs.mkdir(root, { recursive: true });
      await fs.rm(path.join(root, "skills", ...entry.key.split("/")), { recursive: true, force: true });
      for (const file of entry.files) {
        const relative = skillGitRelativePath(entry.key, file.path);
        if (!relative) throw new Error(`Invalid git skill path for ${entry.key}`);
        const destination = path.join(root, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, file.content, "utf8");
      }
      await git(root, ["add", "--", `skills/${entry.key}`]);
      const status = await git(root, ["status", "--porcelain", "--", `skills/${entry.key}`]);
      if (!status.trim()) return;
      await git(root, ["-c", "user.name=Myrmidon skill recorder", "-c", "user.email=skill-recorder@localhost", "commit", "-m", `Record verified skill ${entry.key} revision ${revisionNumber}`]);
      if (push) await git(root, ["push"]);
    },
  };
}

export function configuredGitSkillRecord(env: NodeJS.ProcessEnv = process.env): SkillGitRecordPort | null {
  const repository = env.MYRMIDON_SKILL_GIT_REPOSITORY?.trim();
  return skillGitEnabled(env) && repository ? createGitSkillRecordPort({ repository, env }) : null;
}
