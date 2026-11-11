#!/usr/bin/env node
/**
 * check-skill-size.mjs
 * Validates that SKILL.md files across agent and skill directories do not exceed
 * the maximum allowed size cap (16384 bytes) unless explicitly listed in an allowlist
 * with a documented justification.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const SKILL_SIZE_LIMIT = 16384;

/**
 * Path prefixes checked against PR diff (matches check-skills-drift).
 */
export const SKILL_PATH_PREFIXES = [
  ".agents/skills/",
  ".claude/skills/",
  "skills/",
  "packages/skills-catalog/",
  "packages/teams-catalog/",
];

// Explicit allowlist of current oversized skills with their justifications.
// When a skill's size is reduced below the limit, its entry MUST be removed.
export const ALLOWLIST = new Map([
  [".agents/skills/create-agent-adapter/SKILL.md", "Complex multi-file adapter generation reference procedure"],
  [".agents/skills/terminal-bench-loop/SKILL.md", "Comprehensive benchmark and failure-diagnosis protocol"],
  [".agents/skills/release-changelog-discord-message/SKILL.md", "Detailed release communication and announcement protocol"],
  ["skills/myrmidon-board/SKILL.md", "Extensive board orchestration and control plane manual"],
  ["skills/paperclip-board/SKILL.md", "Alias / legacy board skill bundle (symlinked to myrmidon-board)"],
  [".agents/skills/paperclip-dev-workspace-run-verify-fix/SKILL.md", "Complete isolated dev workspace setup and repair runbook"],
  ["skills-releases/paperclip/v0/SKILL.md", "Archived historical release skill bundle"],
  ["skills-releases/paperclip/v7-roster/SKILL.md", "Archived historical release skill roster bundle"],
]);

function normalizedRelative(from, to) {
  return relative(from, to).split(sep).join("/");
}

export function findSkillFiles(root) {
  const skillFiles = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        skillFiles.push(entryPath);
      }
    }
  };
  walk(root);
  return skillFiles.sort();
}

export function checkSkillSizes({ root = repoRoot, limit = SKILL_SIZE_LIMIT, allowlist = ALLOWLIST } = {}) {
  const files = findSkillFiles(root);
  const violations = [];

  for (const filePath of files) {
    const relPath = normalizedRelative(root, filePath);
    const stats = statSync(filePath);
    const size = stats.size;

    if (size > limit) {
      if (!allowlist.has(relPath)) {
        violations.push({
          path: relPath,
          size,
          limit,
          reason: `SKILL.md size (${size} bytes) exceeds the ${limit} bytes limit and is not in the ALLOWLIST.`,
        });
      }
    } else {
      if (allowlist.has(relPath)) {
        violations.push({
          path: relPath,
          size,
          limit,
          reason: `SKILL.md size (${size} bytes) is now within the ${limit} bytes limit. Please remove it from the ALLOWLIST in .github/scripts/check-skill-size.mjs.`,
        });
      }
    }
  }

  return { passed: violations.length === 0, violations, checkedCount: files.length };
}

/**
 * Check whether PR diff touches any skill paths.
 */
export function shouldCheckSkills(baseSha, headSha, {
  prefixes = SKILL_PATH_PREFIXES,
  gitExec = execFileSync,
} = {}) {
  if (!baseSha || !headSha) return true;

  try {
    const output = gitExec(
      "git",
      ["diff", "--name-only", "-z", `${baseSha}...${headSha}`],
      { encoding: "utf8" },
    );
    const changedFiles = output.split("\0").filter(Boolean).map((f) => f.replace(/\\/g, "/"));
    const matched = changedFiles.some((file) =>
      prefixes.some((prefix) => file.startsWith(prefix)),
    );
    return matched;
  } catch {
    // If git diff fails (e.g. SHAs unavailable), fail open by running check
    return true;
  }
}

export function main() {
  const args = process.argv.slice(2);
  let baseSha = null;
  let headSha = null;

  const shaPattern = /^[0-9a-f]{40}$/i;
  if (args.length >= 2 && shaPattern.test(args[0]) && shaPattern.test(args[1])) {
    baseSha = args[0];
    headSha = args[1];
  }

  if (baseSha && headSha) {
    const shouldRun = shouldCheckSkills(baseSha, headSha);
    if (!shouldRun) {
      console.log(`No skill paths modified between ${baseSha.slice(0, 7)}...${headSha.slice(0, 7)}. Skipping SKILL.md size check.`);
      process.exit(0);
    }
  }

  const result = checkSkillSizes();
  if (!result.passed) {
    console.error("❌ SKILL.md size check failed:\n");
    for (const v of result.violations) {
      console.error(`  - ${v.path}: ${v.reason}`);
    }
    console.error(`\nChecked ${result.checkedCount} SKILL.md files. Limit: ${SKILL_SIZE_LIMIT} bytes.`);
    process.exit(1);
  } else {
    console.log(`✅ SKILL.md size check passed across ${result.checkedCount} skills.`);
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main();
}

