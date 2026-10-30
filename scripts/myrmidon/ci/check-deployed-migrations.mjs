#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const DEFAULT_MIGRATIONS_DIR = path.join(ROOT, "packages/db/src/migrations");
const DEFAULT_DEPLOYED_FILE = path.join(DEFAULT_MIGRATIONS_DIR, ".deployed.json");

export const MIGRATION_FILE_PATTERN = /^(\d{4})_[^/]+\.sql$/;

export function parseMigrationNumber(filename) {
  const base = path.basename(filename);
  const match = base.match(MIGRATION_FILE_PATTERN);
  return match ? match[1] : null;
}

export function normalizeDeployedMigrations(data) {
  const map = new Map();
  if (!data) return map;

  const rawList = Array.isArray(data.migrations)
    ? data.migrations
    : Array.isArray(data.deployedMigrations)
      ? data.deployedMigrations
      : typeof data.migrations === "object" && data.migrations !== null
        ? Object.entries(data.migrations).map(([num, val]) => {
            if (typeof val === "string") return { number: num, file: val };
            return { number: num, ...val };
          })
        : [];

  for (const entry of rawList) {
    if (!entry) continue;
    const num = entry.number ? String(entry.number).padStart(4, "0") : parseMigrationNumber(entry.file ?? entry.name ?? "");
    const file = entry.file ?? entry.name ?? (entry.tag ? `${entry.tag}.sql` : null);
    if (!num || !file) continue;

    map.set(num, {
      number: num,
      file: path.basename(file),
      pr: entry.pr ? Number(entry.pr) : null,
      tag: entry.tag ?? null,
    });
  }

  return map;
}

export function checkDeployedMigrations({
  root = ROOT,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  deployedFile = DEFAULT_DEPLOYED_FILE,
  deployedConfig = null,
  filesToCheck = null,
  baseSha = null,
  headSha = null,
} = {}) {
  let config = deployedConfig;
  if (!config) {
    const configPath = deployedFile ? (path.isAbsolute(deployedFile) ? deployedFile : path.resolve(root, deployedFile)) : DEFAULT_DEPLOYED_FILE;
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch (err) {
        return {
          passed: false,
          errors: [`Failed to parse deployed migrations file (${configPath}): ${err.message}`],
          checkedCount: 0,
        };
      }
    }
  }

  if (!config || !Array.isArray(config.migrations)) {
    return {
      passed: false,
      errors: ["Production migration manifest is missing or invalid"],
      checkedCount: 0,
    };
  }
  const deployedMap = normalizeDeployedMigrations(config);
  if (deployedMap.size !== config.migrations.length || deployedMap.size === 0 ||
      (config.lastMigration && ![...deployedMap.values()].some((entry) => entry.file === config.lastMigration)) ||
      config.migrations.some((entry) => parseMigrationNumber(entry.file ?? "") !== String(entry.number).padStart(4, "0"))) {
    return {
      passed: false,
      errors: ["Production migration manifest has inconsistent or duplicate entries"],
      checkedCount: 0,
    };
  }

  let candidates = filesToCheck;
  if (!candidates) {
    if (baseSha && headSha) {
      try {
        const diffRelPath = path.relative(root, migrationsDir);
        const diffOut = execFileSync(
          "git",
          ["diff", "--name-only", "--diff-filter=ACMR", "-z", `${baseSha}...${headSha}`, "--", diffRelPath],
          { cwd: root, encoding: "utf8" },
        );
        candidates = diffOut.split("\0").filter((f) => f.endsWith(".sql"));
        const manifestDiff = execFileSync("git", ["diff", "--name-only", `${baseSha}...${headSha}`, "--", path.relative(root, deployedFile)], { cwd: root, encoding: "utf8" }).trim();
        if (manifestDiff) candidates = null;
      } catch (err) {
        return {
          passed: false,
          errors: [`Cannot determine migration changes for ${baseSha}...${headSha}: ${err.message}`],
          checkedCount: 0,
        };
      }
    }
  }

  if (!candidates) {
    if (fs.existsSync(migrationsDir)) {
      candidates = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .map((f) => path.join(migrationsDir, f));
    } else {
      candidates = [];
    }
  }

  const errors = [];
  let checkedCount = 0;

  for (const file of candidates) {
    const filename = path.basename(file);
    const num = parseMigrationNumber(filename);
    if (!num) continue;
    checkedCount += 1;

    const deployed = deployedMap.get(num);
    if (deployed && deployed.file !== filename) {
      const prSuffix = deployed.pr ? ` после вливания #${deployed.pr}` : "";
      errors.push(`номер ${num} занят на бою миграцией ${deployed.file} — перенумеруй${prSuffix}`);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    checkedCount,
    deployedCount: deployedMap.size,
  };
}

function parseCliArgs(args) {
  const parsed = {
    root: ROOT,
    migrationsDir: DEFAULT_MIGRATIONS_DIR,
    deployedFile: DEFAULT_DEPLOYED_FILE,
    baseSha: null,
    headSha: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--root" && args[i + 1]) {
      parsed.root = path.resolve(args[++i]);
      parsed.migrationsDir = path.join(parsed.root, "packages/db/src/migrations");
      parsed.deployedFile = path.join(parsed.migrationsDir, ".deployed.json");
    } else if (arg === "--migrations" && args[i + 1]) {
      parsed.migrationsDir = path.resolve(args[++i]);
    } else if (arg === "--deployed" && args[i + 1]) {
      parsed.deployedFile = path.resolve(args[++i]);
    } else if (arg === "--base" && args[i + 1]) {
      parsed.baseSha = args[++i];
    } else if (arg === "--head" && args[i + 1]) {
      parsed.headSha = args[++i];
    } else if (arg === "-h" || arg === "--help") {
      console.log(`Usage: node check-deployed-migrations.mjs [options]

Options:
  --base <sha>        Base commit SHA (PR base)
  --head <sha>        Head commit SHA (PR head)
  --root <dir>        Repository root directory
  --deployed <file>   Path to .deployed.json
  --migrations <dir>  Path to migrations directory
  -h, --help          Show this help message
`);
      process.exit(0);
    }
  }

  return parsed;
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const result = checkDeployedMigrations(options);

  if (!result.passed) {
    for (const err of result.errors) {
      if (process.env.GITHUB_ACTIONS) {
        console.error(`::error title=Migration number collision with production::${err}`);
      }
      console.error(err);
    }
    process.exit(1);
  }

  console.log(
    result.message ??
      `✔ Все номера миграций согласованы с применёнными на бою (${result.deployedCount} миграций на бою, проверено: ${result.checkedCount}).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
