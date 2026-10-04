#!/usr/bin/env node
// Vendor share metric: which files of the repository are still inherited from
// the vendor base commit. A file counts as vendor-derived when it exists in
// the base commit and its content similarity is at or above the threshold.
// Dependency-free ES module; run from the repository root.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_THRESHOLD = 0.5;
export const VENDOR_BASE_FILE = 'scripts/myrmidon/vendor-base.txt';

export const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/target/**',
  '**/.next/**',
  '**/vendor/**',
  '**/third_party/**',
  '**/*.log',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/.idea/**',
  '**/.vscode/**',
  VENDOR_BASE_FILE,
  'docs/myrmidon/DIVERGENCE.md',
];

const TEST_PATH_RE = /(\.(test|spec)\.|\/test\/|\/__tests__\/)/;

function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export function isExcluded(filePath, excludePatterns = DEFAULT_EXCLUDE_PATTERNS) {
  return excludePatterns.some((pattern) => globToRegExp(pattern).test(filePath));
}

// Ratio of common lines to the longer file's line count, on normalized text
// (CRLF folded, trimmed lines, empty lines dropped).
export function calculateSimilarity(a, b) {
  if (a == null && b == null) return 1;
  if (a == null || b == null) return 0;
  const lines = (s) =>
    s
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  const la = lines(a);
  const lb = lines(b);
  if (la.length === 0 && lb.length === 0) return 1;
  const counts = new Map();
  for (const l of lb) counts.set(l, (counts.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of la) {
    const n = counts.get(l) ?? 0;
    if (n > 0) {
      common += 1;
      counts.set(l, n - 1);
    }
  }
  return common / Math.max(la.length, lb.length);
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// The first whitespace-separated token of the base file is the commit.
export function readVendorBaseCommit(cwd = process.cwd()) {
  const file = path.join(cwd, VENDOR_BASE_FILE);
  if (!existsSync(file)) throw new Error(`Vendor base file does not exist: ${VENDOR_BASE_FILE}`);
  const token = readFileSync(file, 'utf8').trim().split(/\s+/)[0];
  if (!token) throw new Error(`Vendor base file is empty: ${VENDOR_BASE_FILE}`);
  return token;
}

function groupBy(files, keyOf) {
  const groups = {};
  for (const f of files) (groups[keyOf(f)] ??= []).push(f);
  return groups;
}

const topLevelDir = (f) => f.split('/')[0];

export function analyzeVendorShare({
  threshold = DEFAULT_THRESHOLD,
  excludePatterns = DEFAULT_EXCLUDE_PATTERNS,
  includeTests = false,
  cwd = process.cwd(),
  baseCommit = readVendorBaseCommit(cwd),
} = {}) {
  const ls = git(['ls-files'], cwd);
  if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr}`);
  let files = ls.stdout.split('\n').filter(Boolean).filter((f) => !isExcluded(f, excludePatterns));
  if (!includeTests) files = files.filter((f) => !TEST_PATH_RE.test(f.toLowerCase()));

  const vendorFiles = [];
  const nonVendorFiles = [];
  for (const file of files) {
    let current;
    try {
      current = readFileSync(path.join(cwd, file), 'utf8');
    } catch {
      continue; // deleted in the working tree or unreadable
    }
    const base = git(['show', `${baseCommit}:${file}`], cwd);
    if (base.status !== 0) {
      nonVendorFiles.push(file);
      continue;
    }
    const similarity = calculateSimilarity(current, base.stdout);
    if (similarity >= threshold) vendorFiles.push({ path: file, similarity });
    else nonVendorFiles.push(file);
  }

  const vendorPaths = vendorFiles.map((f) => f.path);
  const totalFiles = vendorFiles.length + nonVendorFiles.length;
  return {
    summary: {
      totalFiles,
      vendorFiles: vendorFiles.length,
      nonVendorFiles: nonVendorFiles.length,
      vendorRatio: totalFiles > 0 ? vendorFiles.length / totalFiles : 0,
      thresholdUsed: threshold,
      vendorBaseCommit: baseCommit,
    },
    details: { vendorFiles, nonVendorFiles },
    grouped: {
      byDirectory: {
        vendor: groupBy(vendorPaths, topLevelDir),
        nonVendor: groupBy(nonVendorFiles, topLevelDir),
      },
    },
  };
}

export function formatAsMarkdown({ summary, grouped }) {
  const rows = (groups) =>
    Object.entries(groups)
      .map(([dir, list]) => `| ${dir} | ${list.length} |`)
      .join('\n');
  return [
    '# Vendor Share Analysis Report',
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total Files Analyzed | ${summary.totalFiles} |`,
    `| Vendor Files | ${summary.vendorFiles} |`,
    `| Non-Vendor Files | ${summary.nonVendorFiles} |`,
    `| Vendor Share | ${(summary.vendorRatio * 100).toFixed(2)}% |`,
    `| Threshold Used | ${(summary.thresholdUsed * 100).toFixed(2)}% |`,
    `| Base Commit | ${summary.vendorBaseCommit.substring(0, 12)} |`,
    '',
    '## Breakdown by Top-Level Directory',
    '',
    '### Vendor Files by Directory',
    '| Directory | Count |',
    '|-----------|-------|',
    rows(grouped.byDirectory.vendor),
    '',
    '### Non-Vendor Files by Directory',
    '| Directory | Count |',
    '|-----------|-------|',
    rows(grouped.byDirectory.nonVendor),
    '',
  ].join('\n');
}

function main(argv) {
  let threshold = DEFAULT_THRESHOLD;
  let json = false;
  let includeTests = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--threshold' || a === '-t') {
      threshold = Number.parseFloat(argv[++i]);
      if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
        console.error('Error: threshold must be a number between 0 and 1');
        return 1;
      }
    } else if (a === '--json') json = true;
    else if (a === '--include-tests') includeTests = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/myrmidon/vendor-share.mjs [--threshold N] [--json] [--include-tests]',
      );
      return 0;
    }
  }
  try {
    const results = analyzeVendorShare({ threshold, includeTests });
    console.log(json ? JSON.stringify(results, null, 2) : formatAsMarkdown(results));
    return 0;
  } catch (error) {
    console.error(`Error during analysis: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
