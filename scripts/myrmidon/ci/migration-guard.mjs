#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PREFIX = "packages/db/src/migrations/";
const SQL = /(?:^|\/)(\d{4})_[^/]+\.sql$/;

export function migrationNumber(filePath) {
  if (typeof filePath !== "string") return null;
  return SQL.exec(filePath)?.[1] ?? null;
}

export const parseMigrationNumber = migrationNumber;

export function calculateNextAvailableNumber(occupiedNumbers) {
  const nums = Array.from(occupiedNumbers).map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return "0000";
  const max = Math.max(...nums);
  return String(max + 1).padStart(4, "0");
}

export function checkMainCollisions(mainFiles, addedFiles) {
  const occupied = new Map();
  for (const file of mainFiles) {
    const number = migrationNumber(file);
    if (number) occupied.set(number, file);
  }

  const errors = [];
  const addedNumbers = new Set();
  for (const file of addedFiles) {
    const number = migrationNumber(file);
    if (!number) continue;

    if (addedNumbers.has(number)) {
      errors.push(`${file}: duplicate migration number ${number} within the same PR`);
      continue;
    }
    addedNumbers.add(number);

    if (occupied.has(number)) {
      const next = calculateNextAvailableNumber(occupied.keys());
      errors.push(
        `${file}: migration number ${number} is already occupied in main by ${occupied.get(number)}. Next free number: ${next}. Regenerate the snapshot and journal after renumbering.`
      );
    }
  }
  return errors;
}

export function openPrWarnings(addedFiles, pulls) {
  const numbers = new Set(addedFiles.map(migrationNumber).filter(Boolean));
  return pulls.flatMap(({ number, files }) => files
    .filter((file) => numbers.has(migrationNumber(file)))
    .map((file) => `Migration number ${migrationNumber(file)} is also used by open PR #${number}: ${file}. Coordinate renumbering before merge.`));
}

export function checkOpenPrCollisions(addedFiles, pulls, currentPrNumber) {
  const currentNum = currentPrNumber ? parseInt(currentPrNumber, 10) : null;
  const numbers = new Set(addedFiles.map(migrationNumber).filter(Boolean));
  const errors = [];

  const allOccupied = new Set();
  for (const p of pulls) {
    for (const f of p.files || []) {
      const n = migrationNumber(f);
      if (n) allOccupied.add(n);
    }
  }

  for (const pull of pulls) {
    if (currentNum && pull.number === currentNum) continue;
    for (const file of pull.files || []) {
      const num = migrationNumber(file);
      if (num && numbers.has(num)) {
        if (!currentNum || pull.number < currentNum) {
          const next = calculateNextAvailableNumber(allOccupied);
          errors.push(
            `Migration number ${num} is already reserved in open PR #${pull.number}: ${file}. Next free number: ${next}. Renumber using: pnpm db:renumber ${num} ${next}`
          );
        }
      }
    }
  }
  return errors;
}

export function checkGeneratorCollisions(repoRoot = process.cwd()) {
  const migrationsDir = path.join(repoRoot, PREFIX);
  const journalPath = path.join(migrationsDir, "meta", "_journal.json");

  if (!existsSync(journalPath)) return [];

  let mainJournalRaw;
  try {
    mainJournalRaw = execFileSync("git", ["show", "origin/main:" + PREFIX + "meta/_journal.json"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch {
    return [];
  }

  let mainEntries = [];
  try {
    mainEntries = JSON.parse(mainJournalRaw)?.entries ?? [];
  } catch {
    return [];
  }

  let localEntries = [];
  try {
    localEntries = JSON.parse(readFileSync(journalPath, "utf8"))?.entries ?? [];
  } catch {
    return [];
  }

  const errors = [];
  if (localEntries.length < mainEntries.length) {
    errors.push(
      `Local journal (${localEntries.length} entries) is behind origin/main (${mainEntries.length} entries). Run: git fetch origin main && git merge origin/main before generating migrations.`
    );
  }

  for (let i = 0; i < Math.min(localEntries.length, mainEntries.length); i++) {
    const local = localEntries[i];
    const main = mainEntries[i];
    if (local?.tag !== main?.tag) {
      errors.push(
        `Journal entry ${i} tag mismatch: local has "${local?.tag}", origin/main has "${main?.tag}". Rebase/merge main before generating migrations.`
      );
    }
  }

  let mainFiles = [];
  try {
    const raw = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", "origin/main", "--", PREFIX], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });
    mainFiles = raw.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return errors;
  }

  const mainSqlMap = new Map();
  for (const f of mainFiles) {
    const num = migrationNumber(f);
    if (num) mainSqlMap.set(num, path.basename(f));
  }

  const localFiles = readdirSync(migrationsDir);
  for (const f of localFiles) {
    const num = migrationNumber(f);
    if (num && mainSqlMap.has(num)) {
      const mainBase = mainSqlMap.get(num);
      if (f !== mainBase) {
        errors.push(
          `Local migration ${f} conflicts with origin/main ${mainBase} (same number ${num}). Rebase/merge main before generating migrations.`
        );
      }
    }
  }

  return errors;
}

export function getMainMigrationNumbers(repoRoot = process.cwd()) {
  try {
    const raw = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", "origin/main", "--", PREFIX], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const paths = raw.toString("utf8").split("\0").filter(Boolean);
    const set = new Set();
    for (const p of paths) {
      const n = migrationNumber(p);
      if (n) set.add(n);
    }
    return set;
  } catch {
    return new Set();
  }
}

export function getAddedMigrationsFromGit(baseRef = "origin/main", repoRoot = process.cwd()) {
  try {
    const raw = execFileSync("git", ["diff", "--name-only", "--diff-filter=A", "-z", `${baseRef}...HEAD`, "--", PREFIX], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return raw.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

export function checkCollisions({ addedMigrations, mainNumbers = new Set(), openPrMigrations = [] }) {
  const collisions = [];
  const occupiedInMain = new Set(mainNumbers);
  const occupiedInPrs = new Map();

  for (const pr of openPrMigrations) {
    for (const mig of pr.migrations || []) {
      const num = migrationNumber(mig);
      if (num) occupiedInPrs.set(num, { prNumber: pr.prNumber, file: mig });
    }
  }

  const allOccupied = new Set([...occupiedInMain, ...occupiedInPrs.keys()]);
  const seenNumbers = new Set();

  for (const mig of addedMigrations) {
    const num = migrationNumber(mig);
    if (!num) continue;

    if (seenNumbers.has(num)) {
      collisions.push({
        type: "duplicate_in_pr",
        file: mig,
        number: num,
        message: `Duplicate migration number ${num} within the current PR: ${mig}`
      });
      continue;
    }
    seenNumbers.add(num);

    if (occupiedInMain.has(num)) {
      const nextFree = calculateNextAvailableNumber(allOccupied);
      collisions.push({
        type: "main_collision",
        file: mig,
        number: num,
        nextFree,
        message: `Migration number ${num} is already occupied in main. Next free number is ${nextFree}. Renumber using: pnpm db:renumber ${num} ${nextFree}`
      });
    } else if (occupiedInPrs.has(num)) {
      const other = occupiedInPrs.get(num);
      const nextFree = calculateNextAvailableNumber(allOccupied);
      collisions.push({
        type: "open_pr_collision",
        file: mig,
        number: num,
        conflictingPr: other.prNumber,
        conflictingFile: other.file,
        nextFree,
        message: `Migration number ${num} is already reserved in open PR #${other.prNumber} (${other.file}). Next free number is ${nextFree}. Renumber using: pnpm db:renumber ${num} ${nextFree}`
      });
    }
  }

  return collisions;
}

export async function fetchOpenPrMigrations({ repo, token, currentPrNumber }) {
  if (!token) return [];
  const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: ASC}) {
          nodes {
            number
            files(first: 100) {
              nodes {
                path
              }
            }
          }
        }
      }
    }
  `;
  const [owner, name] = (repo || "").split("/");
  if (!owner || !name) return [];

  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "myrmidon-migration-guard"
    },
    body: JSON.stringify({ query, variables: { owner, name } })
  });

  if (!res.ok) return [];
  const data = await res.json();
  const pulls = data?.data?.repository?.pullRequests?.nodes || [];

  return pulls
    .filter((p) => !currentPrNumber || String(p.number) !== String(currentPrNumber))
    .map((p) => ({
      prNumber: p.number,
      number: p.number,
      files: (p.files?.nodes || []).map((f) => f.path).filter((f) => SQL.test(f)),
      migrations: (p.files?.nodes || []).map((f) => f.path).filter((f) => SQL.test(f))
    }))
    .filter((p) => p.files.length > 0);
}

function annotation(level, message) {
  console.log(`::${level}::${message}`);
}

export async function runGuard(modeOrOptions, args = [], env = process.env) {
  if (typeof modeOrOptions === "object" && modeOrOptions !== null) {
    const opts = modeOrOptions;
    const addedMigrations = opts.addedMigrations ?? getAddedMigrationsFromGit(opts.baseRef, opts.repoRoot);
    if (addedMigrations.length === 0) return { ok: true, collisions: [] };

    const mainNumbers = opts.mainNumbers ?? getMainMigrationNumbers(opts.repoRoot);
    const openPrMigrations = opts.openPrMigrations ?? (await fetchOpenPrMigrations({
      repo: opts.repo || env.GITHUB_REPOSITORY,
      token: opts.token || env.GITHUB_TOKEN,
      currentPrNumber: opts.prNumber || env.PR_NUMBER
    }));

    const collisions = checkCollisions({ addedMigrations, mainNumbers, openPrMigrations });
    return { ok: collisions.length === 0, collisions };
  }

  const mode = modeOrOptions;
  if (mode === "generate") {
    const errors = checkGeneratorCollisions();
    if (errors.length > 0) {
      for (const err of errors) console.error(`Error: ${err}`);
      return 1;
    }
    console.log("Migration generator check: journal and migrations aligned with origin/main.");
    return 0;
  }

  if (mode === "pr") {
    const [head, prNumber] = args;
    if (!head || !prNumber) {
      console.error("Usage: migration-guard.mjs pr <head-sha> <pr-number>");
      return 2;
    }

    const paths = (gitArgs) => {
      try {
        const out = execFileSync("git", gitArgs, { stdio: ["pipe", "pipe", "pipe"] });
        return out.toString("utf8").split("\0").filter(Boolean);
      } catch {
        return [];
      }
    };

    const mainFiles = paths(["ls-tree", "-r", "--name-only", "-z", "origin/main", "--", PREFIX]);
    const addedFiles = paths(["diff", "--name-only", "--diff-filter=A", "-z", `origin/main...${head}`, "--", PREFIX]);

    if (addedFiles.length === 0) {
      console.log("Migration guard: no new migrations added in this PR.");
      return 0;
    }

    const mainErrors = checkMainCollisions(mainFiles, addedFiles);
    if (mainErrors.length > 0) {
      for (const err of mainErrors) {
        annotation("error", err);
        console.error(`Error: ${err}`);
      }
      return 1;
    }

    const repo = env.GITHUB_REPOSITORY || "itkadr-git/myrmidon";
    const token = env.GITHUB_TOKEN;
    if (token) {
      try {
        const otherPulls = await fetchOpenPrMigrations({ repo, token, currentPrNumber: prNumber });
        for (const warning of openPrWarnings(addedFiles, otherPulls)) {
          annotation("warning", warning);
          console.warn(`Warning: ${warning}`);
        }
        const prErrors = checkOpenPrCollisions(addedFiles, otherPulls, prNumber);
        if (prErrors.length > 0) {
          for (const err of prErrors) {
            annotation("error", err);
            console.error(`Error: ${err}`);
          }
          return 1;
        }
      } catch (err) {
        annotation("warning", `Could not query open PRs for collision warnings: ${err.message}`);
      }
    }

    console.log(`Migration guard: all ${addedFiles.length} new migrations have unique, reserved numbers.`);
    return 0;
  }

  console.error(`Unknown mode: ${mode}. Expected "generate" or "pr".`);
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [,, mode = "pr", ...args] = process.argv;
  const exitCode = await runGuard(mode, args);
  process.exit(exitCode);
}
