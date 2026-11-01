#!/usr/bin/env node
/**
 * Update packages/db/src/migrations/.deployed.json during release deployment.
 *
 * Usage:
 *   node scripts/myrmidon/ci/update-deployed-migrations.mjs \
 *     --branch rel/1.6.6-rc.19 \
 *     --tag myr-v1.6.6-rc.19
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseMigrationNumber } from "./check-deployed-migrations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const DEFAULT_OUT = path.join(ROOT, "packages/db/src/migrations/.deployed.json");

function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function findMigrationsInTree(ref, cwd = ROOT) {
  try {
    const output = git(["ls-tree", "-r", "--name-only", ref, "--", "packages/db/src/migrations"], cwd);
    return output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith(".sql"));
  } catch {
    return [];
  }
}

export function extractPrNumberFromLog(ref, filePath, cwd = ROOT, num = null, existingMap = null) {
  if (num && existingMap && existingMap.has(num) && existingMap.get(num).pr) {
    return existingMap.get(num).pr;
  }
  try {
    const fileLog = git(["log", "-n", "10", "--format=%s %b", ref, "--", filePath], cwd);
    const branchMatches = fileLog.match(/bot\/(OPE-\d+)/g) || [];
    for (const b of branchMatches) {
      const mergeLog = git(["log", "-n", "5", "--format=%s", `--grep=${b}`, ref], cwd);
      const prMatch = mergeLog.match(/\(#(\d+)\)/) || mergeLog.match(/#(\d+)/);
      if (prMatch) return Number(prMatch[1]);
    }
    const directPr = fileLog.match(/\(#(\d+)\)/) || fileLog.match(/#(\d+)/);
    if (directPr) return Number(directPr[1]);
  } catch {
    // ignore git log lookup errors
  }
  return null;
}

export function generateDeployedConfig({
  branch = "rel/1.6.6-rc.19",
  tag = "myr-v1.6.6-rc.19",
  baseRef = "origin/main",
  cwd = ROOT,
} = {}) {
  const relBranchRef = branch.startsWith("origin/") ? branch : `origin/${branch}`;
  // Try remote branch ref first, fallback to local branch ref
  let targetRef = relBranchRef;
  try {
    git(["rev-parse", "--verify", targetRef], cwd);
  } catch {
    targetRef = branch;
  }

  const baseFiles = new Set(findMigrationsInTree(baseRef, cwd).map((f) => path.basename(f)));
  const branchFiles = findMigrationsInTree(targetRef, cwd).map((f) => path.basename(f));

  let existingMap = new Map();
  if (fs.existsSync(DEFAULT_OUT)) {
    try {
      const existingData = JSON.parse(fs.readFileSync(DEFAULT_OUT, "utf8"));
      for (const m of existingData.migrations ?? []) {
        if (m.number) existingMap.set(String(m.number).padStart(4, "0"), m);
      }
    } catch {
      // ignore
    }
  }

  const extraFiles = branchFiles.filter((f) => !baseFiles.has(f));
  const migrations = [];

  for (const file of extraFiles) {
    const num = parseMigrationNumber(file);
    if (!num) continue;
    const pr = extractPrNumberFromLog(targetRef, `packages/db/src/migrations/${file}`, cwd, num, existingMap);
    migrations.push({
      number: num,
      file,
      pr,
    });
  }

  // Sort by migration number
  migrations.sort((a, b) => Number(a.number) - Number(b.number));

  const lastMigration = migrations.length > 0 ? migrations.at(-1).file : null;

  return {
    releaseBranch: branch.replace(/^origin\//, ""),
    releaseTag: tag,
    deployedAt: new Date().toISOString(),
    lastMigration,
    migrations,
  };
}

function parseCliArgs(args) {
  const parsed = {
    branch: "rel/1.6.6-rc.19",
    tag: "myr-v1.6.6-rc.19",
    baseRef: "origin/main",
    out: DEFAULT_OUT,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--branch" && args[i + 1]) {
      parsed.branch = args[++i];
    } else if (arg === "--tag" && args[i + 1]) {
      parsed.tag = args[++i];
    } else if (arg === "--base" && args[i + 1]) {
      parsed.baseRef = args[++i];
    } else if (arg === "--out" && args[i + 1]) {
      parsed.out = path.resolve(args[++i]);
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(`Usage: node update-deployed-migrations.mjs [options]

Options:
  --branch <branch>   Deployed release branch (e.g. rel/1.6.6-rc.19)
  --tag <tag>         Deployed release tag (e.g. myr-v1.6.6-rc.19)
  --base <baseRef>    Base branch to diff against (default: origin/main)
  --out <file>        Output file (default: packages/db/src/migrations/.deployed.json)
  --dry-run           Print generated JSON without writing to file
  -h, --help          Show this help message
`);
      process.exit(0);
    }
  }

  return parsed;
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const config = generateDeployedConfig({
    branch: options.branch,
    tag: options.tag,
    baseRef: options.baseRef,
  });

  const jsonStr = `${JSON.stringify(config, null, 2)}\n`;

  if (options.dryRun) {
    console.log(jsonStr);
    return;
  }

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, jsonStr, "utf8");
  console.log(`Updated ${options.out} from ${options.branch} (${config.migrations.length} migrations ahead of ${options.baseRef}).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
