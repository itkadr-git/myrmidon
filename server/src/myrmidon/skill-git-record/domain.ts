// myrmidon(1.7 KNOWLEDGE-2.0 L-13): pure rules for the git record of verified skills.

import { createHash } from "node:crypto";
import path from "node:path";

export const SKILL_GIT_ENABLED_ENV = "MYRMIDON_SKILL_GIT_ENABLED";
export const SKILL_GIT_REPOSITORY_ENV = "MYRMIDON_SKILL_GIT_REPOSITORY";
export const SKILL_GIT_PUSH_ENV = "MYRMIDON_SKILL_GIT_PUSH";
export const SKILL_GIT_WEBHOOK_SECRET_ENV = "MYRMIDON_SKILL_GIT_WEBHOOK_SECRET";

export type GitSkillFile = { path: string; content: string };
export type GitSkillEntry = { key: string; files: GitSkillFile[] };

export function skillGitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SKILL_GIT_ENABLED_ENV] === "1" && Boolean(env[SKILL_GIT_REPOSITORY_ENV]?.trim());
}

export function normalizeSkillFilePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === ".")) return null;
  const resolved = path.posix.normalize(normalized);
  return resolved === "." || resolved.startsWith("../") || path.posix.isAbsolute(resolved) ? null : resolved;
}

export function skillGitRelativePath(key: string, filePath: string): string | null {
  const safeKey = key
    .split("/")
    .every((part) => part !== "." && part !== ".." && /^[a-zA-Z0-9._-]+$/.test(part))
    ? key
    : null;
  const safeFile = normalizeSkillFilePath(filePath);
  return safeKey && safeFile ? `skills/${safeKey}/${safeFile}` : null;
}

export function skillContentHash(files: readonly GitSkillFile[]): string {
  const canonical = files
    .map((file) => ({ path: normalizeSkillFilePath(file.path), content: file.content }))
    .filter((file): file is { path: string; content: string } => file.path !== null)
    .sort((a, b) => a.path.localeCompare(b.path));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function skillGitDriftReason(input: {
  verified: boolean;
  gitEntry: GitSkillEntry | null;
  versionFiles: GitSkillFile[];
}): "missing" | "content_mismatch" | null {
  if (!input.verified) return null;
  if (!input.gitEntry) return "missing";
  return skillContentHash(input.gitEntry.files) === skillContentHash(input.versionFiles) ? null : "content_mismatch";
}

export function assertSkillGitEntry(entry: GitSkillEntry): GitSkillEntry {
  if (!entry.key || entry.files.length === 0) throw new Error("A git skill entry must contain a key and files.");
  for (const file of entry.files) {
    if (!normalizeSkillFilePath(file.path)) throw new Error(`Invalid skill file path: ${file.path}`);
  }
  return entry;
}
