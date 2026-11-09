#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Roots containing skills. Mirrors SKILL_FRONTMATTER_ROOTS in
 * packages/skills-catalog/src/shipped-catalog.test.ts, plus .claude
 * where agent skills are also mirrored.
 */
export const SKILL_ROOTS = [
  '.agents',
  '.claude',
  'skills',
  'packages/adapters',
  'packages/plugins',
  'packages/skills-catalog/catalog',
  'packages/teams-catalog/catalog',
];

/**
 * Path prefixes checked against PR diff.
 */
export const SKILL_PATH_PREFIXES = [
  '.agents/skills/',
  '.claude/skills/',
  'skills/',
  'packages/skills-catalog/',
  'packages/teams-catalog/',
];

/**
 * Allowlist for skill slugs that are intentionally allowed to diverge across roots
 * (e.g., self-contained catalog-local skills with distinct roles).
 *
 * Each entry must include a comment explaining why divergence is expected.
 *
 * NOTE: 'doc-maintenance' currently diverges (.agents/skills vs packages/skills-catalog)
 * and is intentionally NOT allowlisted here because it must be synchronized
 * as part of epic OPE-12138.
 */
export const ALLOWLIST = new Set([
  // Example:
  // 'sample-catalog-skill', // Rationale: Catalog-local skill with custom agent instructions
]);

/**
 * Check if a skill slug or file pair is exempted by the allowlist.
 */
export function isAllowlisted(slug, fileA, fileB, allowlist = ALLOWLIST) {
  if (!allowlist) return false;
  if (allowlist instanceof Set) {
    if (allowlist.has(slug)) return true;
  }
  if (Array.isArray(allowlist)) {
    for (const item of allowlist) {
      if (typeof item === 'string' && item === slug) return true;
      if (typeof item === 'object' && item !== null) {
        if (item.slug === slug) return true;
        if (Array.isArray(item.pair) && item.pair.length === 2) {
          const matchA = fileA.includes(item.pair[0]) && fileB.includes(item.pair[1]);
          const matchB = fileA.includes(item.pair[1]) && fileB.includes(item.pair[0]);
          if (matchA || matchB) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Recursively find all SKILL.md files under a directory.
 * Safely handles symlinks without infinite recursion.
 */
export function findSkillFiles(dir, ancestors = new Set()) {
  const results = [];
  let realDir;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return results;
  }
  if (ancestors.has(realDir)) return results;
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(realDir);

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(fullPath);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        results.push(...findSkillFiles(fullPath, nextAncestors));
      } else if (isFile && entry.name === 'SKILL.md') {
        results.push(fullPath);
      }
    }
  } catch {
    // Unreadable or nonexistent directory
  }
  return results;
}

/**
 * Check skills across roots for drift between duplicate slugs.
 */
export function checkSkillsDrift({
  rootDir = process.cwd(),
  roots = SKILL_ROOTS,
  allowlist = ALLOWLIST,
} = {}) {
  const skillsBySlug = new Map();

  for (const relRoot of roots) {
    const absRoot = path.isAbsolute(relRoot) ? relRoot : path.join(rootDir, relRoot);
    if (!fs.existsSync(absRoot)) continue;

    const files = findSkillFiles(absRoot);
    for (const file of files) {
      const relPath = path.relative(rootDir, file).replace(/\\/g, '/');
      const slug = path.basename(path.dirname(file));
      let content;
      try {
        content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      } catch {
        content = null;
      }
      if (!skillsBySlug.has(slug)) {
        skillsBySlug.set(slug, []);
      }
      skillsBySlug.get(slug).push({
        path: relPath,
        absPath: file,
        content,
        length: content ? content.length : 0,
      });
    }
  }

  const duplicates = [];
  const drifts = [];
  const allowedDrifts = [];

  for (const [slug, copies] of skillsBySlug.entries()) {
    if (copies.length <= 1) continue;
    duplicates.push({ slug, copies });

    // Compare each copy against the first copy
    const reference = copies[0];
    let hasDrift = false;
    const divergentCopies = [];

    for (let i = 1; i < copies.length; i++) {
      const current = copies[i];
      if (current.content !== reference.content) {
        hasDrift = true;
        divergentCopies.push(current);
      }
    }

    if (hasDrift) {
      if (isAllowlisted(slug, reference.path, divergentCopies[0]?.path, allowlist)) {
        allowedDrifts.push({ slug, copies, reason: 'allowlisted' });
      } else {
        drifts.push({
          slug,
          copies,
        });
      }
    }
  }

  if (drifts.length > 0) {
    const lines = [
      `Skills drift detected: found ${drifts.length} duplicate skill(s) with divergent SKILL.md contents:`,
    ];
    for (const drift of drifts) {
      lines.push(`- slug "${drift.slug}":`);
      for (const copy of drift.copies) {
        lines.push(`    ${copy.path} (${copy.length} bytes)`);
      }
    }
    lines.push(
      '',
      'Rule: skills with the same slug across roots must be identical.',
      'If divergence is intentional (e.g. catalog-local skill with distinct role),',
      'add the slug to ALLOWLIST in .github/scripts/check-skills-drift.mjs with a rationale comment.',
    );

    return {
      passed: false,
      duplicates,
      drifts,
      allowedDrifts,
      message: lines.join('\n'),
    };
  }

  return {
    passed: true,
    duplicates,
    drifts: [],
    allowedDrifts,
    message: `All duplicate skills are identical across roots (${duplicates.length} duplicate slugs checked, ${allowedDrifts.length} allowed drifts).`,
  };
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
      'git',
      ['diff', '--name-only', '-z', `${baseSha}...${headSha}`],
      { encoding: 'utf8' },
    );
    const changedFiles = output.split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'));
    const matched = changedFiles.some((file) =>
      prefixes.some((prefix) => file.startsWith(prefix)),
    );
    return matched;
  } catch {
    // If git diff fails (e.g. SHAs unavailable), fail open by running check
    return true;
  }
}

function escapeWorkflowCommand(message) {
  return message
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
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
      console.log(`No skill paths modified between ${baseSha.slice(0, 7)}...${headSha.slice(0, 7)}. Skipping skills drift check.`);
      process.exit(0);
    }
  }

  const result = checkSkillsDrift();

  if (result.passed) {
    console.log(result.message);
    process.exit(0);
  }

  console.error(
    `::error title=Skills drift detected::${escapeWorkflowCommand(result.message)}`,
  );
  console.error(result.message);
  process.exit(1);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main();
}
