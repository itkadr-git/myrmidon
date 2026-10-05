#!/usr/bin/env node
// myrmidon(VENDOR-SHARE-METRIC): share of files inherited from the vendor base.
//
// A file counts as inherited when its path existed in the base vendor commit
// (a git rename is followed through the rename detection of `git diff -M`) AND
// the share of matching lines against the base version is at or above the
// threshold (default 0.5). New files, files whose text was rewritten below the
// threshold, and excluded paths (lock files, generated output, this metric's own
// bookkeeping) are not inherited.
//
// Output: JSON (--json) or a short Markdown table. Pure Node, no dependencies.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_THRESHOLD = 0.5;
export const THRESHOLD_ENV = "MYRMIDON_VENDOR_SHARE_THRESHOLD";
export const BASE_FILE = "scripts/myrmidon/vendor-base.txt";

// Exclusions are a list in the code, as the ticket asks: lock files and
// generated/binary-ish output never take part in the share. Patterns are
// glob-like: `**` crosses path separators, `*` and `?` do not.
export const DEFAULT_EXCLUDE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.next/**",
  "**/__snapshots__/**",
  "**/*.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.snap",
  "**/*.generated.*",
  `**/${BASE_FILE}`,
  "docs/myrmidon/DIVERGENCE.md",
];

export function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` also matches zero directories, so `**/x` matches `x`.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export function isExcluded(filePath, patterns = DEFAULT_EXCLUDE_PATTERNS) {
  const normalized = filePath.replace(/^\.\//, "");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

// Share of matching lines between two texts: the multiset intersection of lines
// over the longer side, so an unchanged file scores 1 and a full rewrite 0.
export function normalizeLines(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
}

export function lineSimilarity(left, right) {
  const a = normalizeLines(left);
  const b = normalizeLines(right);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of b) {
    const left2 = counts.get(line);
    if (left2) {
      common += 1;
      counts.set(line, left2 - 1);
    }
  }
  return common / Math.max(a.length, b.length);
}

function git(repoDir, args, { input, encoding = "utf8" } = {}) {
  const res = spawnSync("git", ["-C", repoDir, ...args], {
    encoding,
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) throw new Error(`git ${args.join(" ")} failed: ${res.error.message}`);
  if (res.status !== 0) {
    const err = Buffer.isBuffer(res.stderr) ? res.stderr.toString("utf8") : res.stderr;
    throw new Error(`git ${args.join(" ")} failed: ${(err || "").trim()}`);
  }
  return res.stdout;
}

export function readBaseCommit(repoDir, override) {
  if (override) return { sha: override, source: "option" };
  const file = path.join(repoDir, BASE_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`vendor base file not found: ${BASE_FILE} (pass --base <sha>)`);
  }
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const token = line.trim();
    if (/^[0-9a-f]{7,40}$/.test(token)) return { sha: token, source: BASE_FILE };
  }
  throw new Error(`no commit sha found in ${BASE_FILE}`);
}

// path -> blob sha for a tree-ish, in one git call.
export function treeBlobShas(repoDir, ref) {
  const raw = git(repoDir, ["ls-tree", "-r", "-z", "--format=%(objectname) %(path)", ref]);
  const map = new Map();
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const sep = entry.indexOf(" ");
    if (sep < 0) continue;
    map.set(entry.slice(sep + 1), entry.slice(0, sep));
  }
  return map;
}

export function detectRenames(repoDir, baseRef, headRef) {
  const raw = git(repoDir, ["diff", "-M", "--name-status", "--diff-filter=R", baseRef, headRef]);
  const renames = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length >= 3 && parts[0].startsWith("R")) renames.set(parts[2], parts[1]);
  }
  return renames;
}

// Fetch base blobs in bounded batches through a single `git cat-file --batch`
// process per batch, keyed back by input order.
export function readBaseBlobs(repoDir, baseRef, paths, batchSize = 200) {
  const out = new Map();
  for (let i = 0; i < paths.length; i += batchSize) {
    const chunk = paths.slice(i, i + batchSize);
    const input = chunk.map((p) => `${baseRef}:${p}`).join("\n") + "\n";
    const buf = git(repoDir, ["cat-file", "--batch"], { input, encoding: null });
    let offset = 0;
    for (const requested of chunk) {
      if (offset >= buf.length) break;
      const nl = buf.indexOf(0x0a, offset);
      if (nl < 0) break;
      const header = buf.toString("utf8", offset, nl);
      offset = nl + 1;
      if (header.endsWith(" missing")) {
        out.set(requested, null);
        continue;
      }
      const [, , sizeStr] = header.split(" ");
      const size = Number(sizeStr);
      if (!Number.isFinite(size)) {
        out.set(requested, null);
        continue;
      }
      const content = buf.subarray(offset, offset + size);
      offset += size + 1;
      out.set(requested, content);
    }
  }
  return out;
}

function isBinary(buf) {
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i += 1) if (buf[i] === 0) return true;
  return false;
}

export function resolveThreshold(flagValue) {
  if (flagValue !== undefined && flagValue !== null && flagValue !== "") {
    const value = Number(flagValue);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`threshold must be a number between 0 and 1, got ${flagValue}`);
    }
    return { value, source: "flag" };
  }
  const env = process.env[THRESHOLD_ENV];
  if (env !== undefined && env !== "") {
    const value = Number(env);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${THRESHOLD_ENV} must be a number between 0 and 1, got ${env}`);
    }
    return { value, source: "env" };
  }
  return { value: DEFAULT_THRESHOLD, source: "default" };
}

function groupBy(filePaths, filesByPath, keyOf) {
  const groups = new Map();
  for (const filePath of filePaths) {
    const key = keyOf(filePath);
    if (!groups.has(key)) groups.set(key, { total: 0, inherited: 0 });
    const bucket = groups.get(key);
    bucket.total += 1;
    if (filesByPath.get(filePath)?.kind === "inherited") bucket.inherited += 1;
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([key, bucket]) => [
        key,
        { ...bucket, share: bucket.total ? bucket.inherited / bucket.total : 0 },
      ]),
  );
}

const topLevelDir = (p) => (p.includes("/") ? p.split("/")[0] : "(root)");
function packageOf(filePath) {
  const parts = filePath.split("/");
  if (parts[0] === "packages" && parts.length > 2) return `packages/${parts[1]}`;
  if (parts.length > 1) return parts[0];
  return "(root)";
}

export function analyzeVendorShare(options = {}) {
  const repoDir = path.resolve(options.repoDir ?? process.cwd());
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const excludePatterns = options.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS;
  const base = readBaseCommit(repoDir, options.base);

  const baseShas = treeBlobShas(repoDir, base.sha);
  const headShas = treeBlobShas(repoDir, "HEAD");
  const renames = detectRenames(repoDir, base.sha, "HEAD");

  const allFiles = git(repoDir, ["ls-files"]).split("\n").filter(Boolean);
  const files = [];
  const pending = [];

  for (const filePath of allFiles) {
    if (isExcluded(filePath, excludePatterns)) {
      files.push({ path: filePath, basePath: null, kind: "excluded", similarity: null });
      continue;
    }
    const basePath = baseShas.has(filePath) ? filePath : renames.get(filePath) ?? null;
    if (basePath === null || !baseShas.has(basePath)) {
      files.push({ path: filePath, basePath: null, kind: "new", similarity: 0 });
      continue;
    }
    const headSha = headShas.get(filePath);
    if (headSha && headSha === baseShas.get(basePath)) {
      files.push({ path: filePath, basePath, kind: "inherited", similarity: 1 });
      continue;
    }
    const record = { path: filePath, basePath, kind: "pending", similarity: null };
    files.push(record);
    pending.push(record);
  }

  const blobs = readBaseBlobs(repoDir, base.sha, pending.map((r) => r.basePath));
  for (const record of pending) {
    const baseBlob = blobs.get(record.basePath);
    let currentBlob = null;
    try {
      currentBlob = fs.readFileSync(path.join(repoDir, record.path));
    } catch {
      currentBlob = null;
    }
    if (baseBlob === null || baseBlob === undefined || currentBlob === null) {
      record.kind = "new";
      record.similarity = 0;
      continue;
    }
    if (isBinary(baseBlob) || isBinary(currentBlob)) {
      record.kind = "binary";
      record.similarity = 0;
      continue;
    }
    const similarity = lineSimilarity(baseBlob.toString("utf8"), currentBlob.toString("utf8"));
    record.similarity = similarity;
    record.kind = similarity >= threshold ? "inherited" : "modified";
  }

  const byPath = new Map(files.map((f) => [f.path, f]));
  const counted = files.filter((f) => f.kind !== "excluded");
  const inherited = counted.filter((f) => f.kind === "inherited");
  const counts = {};
  for (const f of files) counts[f.kind] = (counts[f.kind] ?? 0) + 1;

  return {
    summary: {
      totalFiles: counted.length,
      inherited: inherited.length,
      modified: counts.modified ?? 0,
      newFiles: counts.new ?? 0,
      binary: counts.binary ?? 0,
      excluded: counts.excluded ?? 0,
      share: counted.length ? inherited.length / counted.length : 0,
      threshold,
      thresholdSource: options.thresholdSource ?? "default",
      baseCommit: base.sha,
      baseSource: base.source,
    },
    byDirectory: groupBy(counted.map((f) => f.path), byPath, topLevelDir),
    byPackage: groupBy(counted.map((f) => f.path), byPath, packageOf),
    files: files
      .map((f) => ({
        path: f.path,
        basePath: f.basePath,
        kind: f.kind,
        similarity: f.similarity === null ? null : Number(f.similarity.toFixed(4)),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

const pct = (value) => `${(value * 100).toFixed(2)}%`;

export function formatMarkdown(result) {
  const { summary, byDirectory, byPackage } = result;
  const lines = [];
  lines.push("# Vendor share");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Files measured | ${summary.totalFiles} |`);
  lines.push(`| Inherited from the vendor | ${summary.inherited} (${pct(summary.share)}) |`);
  lines.push(`| Rewritten below the threshold | ${summary.modified} |`);
  lines.push(`| New (absent in the base) | ${summary.newFiles} |`);
  lines.push(`| Binary/skipped | ${summary.binary} |`);
  lines.push(`| Excluded by pattern | ${summary.excluded} |`);
  lines.push(`| Threshold | ${pct(summary.threshold)} (${summary.thresholdSource}) |`);
  lines.push(`| Vendor base commit | \`${summary.baseCommit.slice(0, 12)}\` |`);
  lines.push("");
  lines.push("| Top-level directory | Files | Inherited | Share |");
  lines.push("| --- | --- | --- | --- |");
  for (const [dir, bucket] of Object.entries(byDirectory)) {
    lines.push(`| ${dir} | ${bucket.total} | ${bucket.inherited} | ${pct(bucket.share)} |`);
  }
  lines.push("");
  lines.push("| Package | Files | Inherited | Share |");
  lines.push("| --- | --- | --- | --- |");
  for (const [pkg, bucket] of Object.entries(byPackage)) {
    lines.push(`| ${pkg} | ${bucket.total} | ${bucket.inherited} | ${pct(bucket.share)} |`);
  }
  return lines.join("\n");
}

const HELP = `Usage: node scripts/myrmidon/vendor-share.mjs [options]

  --threshold, -t <0..1>  Similarity threshold (default 0.5; env ${THRESHOLD_ENV})
  --base <sha|ref>        Vendor base commit (default: ${BASE_FILE})
  --repo <dir>            Repository to analyse (default: current directory)
  --json                  Print JSON instead of the Markdown table
  --help, -h              Show this help`;

export function main(argv = process.argv.slice(2)) {
  const opts = { repoDir: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--threshold" || arg === "-t") opts.threshold = argv[++i];
    else if (arg === "--base") opts.base = argv[++i];
    else if (arg === "--repo") opts.repoDir = argv[++i];
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      return 0;
    } else {
      console.error(`unknown option: ${arg}\n\n${HELP}`);
      return 2;
    }
  }
  const threshold = resolveThreshold(opts.threshold);
  const result = analyzeVendorShare({
    repoDir: opts.repoDir,
    base: opts.base,
    threshold: threshold.value,
    thresholdSource: threshold.source,
  });
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatMarkdown(result));
  return 0;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`vendor-share: ${error.message}`);
    process.exitCode = 1;
  }
}