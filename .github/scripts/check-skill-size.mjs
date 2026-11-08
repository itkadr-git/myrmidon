#!/usr/bin/env node
/**
 * check-skill-size.mjs
 * Validates that SKILL.md files across agent and skill directories do not exceed
 * the maximum allowed size cap (16384 bytes) unless explicitly listed in an allowlist
 * with a documented justification.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const SKILL_SIZE_LIMIT = 16384;

// Explicit allowlist of current oversized skills with their justifications.
// When a skill's size is reduced below the limit, its entry MUST be removed.
export const ALLOWLIST = new Map([
  [".agents/skills/create-agent-adapter/SKILL.md", "Complex multi-file adapter generation reference procedure"],
  [".agents/skills/terminal-bench-loop/SKILL.md", "Comprehensive benchmark and failure-diagnosis protocol"],
  [".agents/skills/release-changelog-discord-message/SKILL.md", "Detailed release communication and announcement protocol"],
  ["skills/myrmidon-board/SKILL.md", "Extensive board orchestration and control plane manual"],
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
