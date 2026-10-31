#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PREFIX = "packages/db/src/migrations/";
const SQL = /(?:^|\/)(\d{4})_[^/]+\.sql$/;

export function migrationNumber(path) {
  if (typeof path !== "string") return null;
  return SQL.exec(path)?.[1] ?? null;
}

export function checkMainCollisions(mainFiles, addedFiles) {
  const occupied = new Map();
  for (const file of mainFiles) {
    const number = migrationNumber(file);
    if (number) occupied.set(number, file);
  }
  const occupiedNumbers = Array.from(occupied.keys(), Number);
  const maximum = Math.max(-1, ...occupiedNumbers);
  const next = String(maximum + 1).padStart(4, "0");
  const errors = [];
  const added = new Map();
  for (const file of addedFiles) {
    const number = migrationNumber(file);
    if (!number) continue;
    if (occupied.has(number)) {
      errors.push(`${file}: migration number ${number} is already occupied in main by ${occupied.get(number)}. Next free number: ${next}. Regenerate the snapshot and journal after renumbering.`);
    }
    if (added.has(number)) {
      errors.push(`${file}: migration number ${number} is also used in this PR by ${added.get(number)}.`);
    }
    added.set(number, file);
  }
  return errors;
}

export function checkGeneratorCollisions(mainFiles, localFiles, journal) {
  const errors = [];
  const occupied = new Map();
  for (const file of mainFiles) {
    const number = migrationNumber(file);
    if (number) occupied.set(number, file);
  }
  const occupiedNumbers = Array.from(occupied.keys(), Number);
  const maxMain = Math.max(-1, ...occupiedNumbers);
  const next = String(maxMain + 1).padStart(4, "0");

  // Check if any local SQL file collides with main under a different name
  for (const file of localFiles) {
    const number = migrationNumber(file);
    if (!number) continue;
    if (occupied.has(number)) {
      const mainFile = occupied.get(number);
      const localBase = file.split("/").pop();
      const mainBase = mainFile.split("/").pop();
      if (localBase !== mainBase) {
        errors.push(`${file}: migration number ${number} is occupied in main by ${mainFile}. Update main before generating.`);
      }
    }
  }

  // Check if local journal is behind main's highest migration number
  const journalEntries = journal?.entries ?? [];
  const journalNumbers = journalEntries
    .map((e) => {
      if (typeof e.idx === "number" && !Number.isNaN(e.idx)) return e.idx;
      const match = /(?:^|\/)(\d{4})_/.exec(e.tag ?? "");
      return match ? Number(match[1]) : null;
    })
    .filter((n) => n !== null);
  const maxJournal = Math.max(-1, ...journalNumbers);

  if (maxMain > maxJournal) {
    const formattedMain = String(maxMain).padStart(4, "0");
    const formattedJournal = String(Math.max(0, maxJournal)).padStart(4, "0");
    errors.push(
      `Cannot generate migrations: origin/main contains migration ${formattedMain}, but local migration journal only goes up to ${formattedJournal}. Generating now would silently create duplicate migration numbers (${String(Math.max(0, maxJournal) + 1).padStart(4, "0")}). Pull or rebase on origin/main first (next free number in main is ${next}).`
    );
  }

  return errors;
}

export function openPrWarnings(addedFiles, pulls) {
  const numbers = new Set(addedFiles.map(migrationNumber).filter(Boolean));
  return pulls.flatMap(({ number, files }) => files
    .filter((file) => numbers.has(migrationNumber(file)))
    .map((file) => `Migration number ${migrationNumber(file)} is also used by open PR #${number}: ${file}. Coordinate renumbering before merge.`));
}

function paths(args) {
  return execFileSync("git", args, { encoding: "utf8" }).split("\0").filter(Boolean);
}

function annotation(kind, message) {
  console.log(`::${kind}::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
}

async function fetchOpenPrFilesGraphQL(repo, currentPrNumber, token) {
  const [owner, name] = repo.split("/");
  const query = `
    query($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(first: 100, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
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

  const pulls = [];
  let cursor = null;
  // Fetch up to 300 open PRs (up to 3 pages) with a 15s timeout
  for (let page = 0; page < 3; page++) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "User-Agent": "migration-guard",
        "Authorization": `bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { owner, repo: name, cursor } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`GraphQL HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data.errors?.length) {
      throw new Error(data.errors[0].message);
    }
    const nodes = data.data?.repository?.pullRequests?.nodes ?? [];
    for (const pr of nodes) {
      if (pr.number === Number(currentPrNumber)) continue;
      const files = (pr.files?.nodes ?? [])
        .map((f) => f.path)
        .filter((p) => migrationNumber(p));
      if (files.length > 0) {
        pulls.push({ number: pr.number, files });
      }
    }
    const pageInfo = data.data?.repository?.pullRequests?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  return pulls;
}

export async function runGuard(mode, args, env = process.env) {
  if (mode !== "pr" && mode !== "generate") {
    throw new Error("Usage: migration-guard.mjs pr <head-sha> <pr-number> | generate");
  }

  // Always compare against current main
  try {
    execFileSync("git", ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], { stdio: "ignore" });
  } catch {}

  const mainFiles = paths(["ls-tree", "-r", "--name-only", "-z", "origin/main", "--", PREFIX]);

  if (mode === "generate") {
    let localFiles = [];
    if (existsSync("packages/db/src/migrations")) {
      localFiles = readdirSync("packages/db/src/migrations")
        .filter((file) => file.endsWith(".sql"))
        .map((file) => `${PREFIX}${file}`);
    }
    let journal = null;
    const journalPath = "packages/db/src/migrations/meta/_journal.json";
    if (existsSync(journalPath)) {
      try {
        journal = JSON.parse(readFileSync(journalPath, "utf8"));
      } catch {}
    }
    const generatorErrors = checkGeneratorCollisions(mainFiles, localFiles, journal);
    for (const error of generatorErrors) {
      annotation("error", error);
      console.error(`Error: ${error}`);
    }
    if (generatorErrors.length) {
      return 1;
    }
    return 0;
  }

  const head = args[0];
  const prNumber = args[1];
  if (!/^[a-f0-9]{40}$/i.test(head ?? "") || !/^\d+$/.test(prNumber ?? "")) {
    throw new Error("Expected a 40-character head SHA and PR number");
  }

  const addedFiles = paths(["diff", "--name-only", "--diff-filter=A", "-z", `origin/main...${head}`, "--", PREFIX]);
  const errors = checkMainCollisions(mainFiles, addedFiles);
  for (const error of errors) {
    annotation("error", error);
    console.error(`Error: ${error}`);
  }

  if (errors.length) {
    return 1;
  }

  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const numbers = new Set(addedFiles.map(migrationNumber).filter(Boolean));
  if (!numbers.size || !token || !/^[^/]+\/[^/]+$/.test(repo ?? "")) {
    return 0;
  }

  try {
    const otherPulls = await fetchOpenPrFilesGraphQL(repo, prNumber, token);
    for (const warning of openPrWarnings(addedFiles, otherPulls)) {
      annotation("warning", warning);
      console.warn(`Warning: ${warning}`);
    }
  } catch (err) {
    annotation("warning", `Could not query open PRs for collision warnings: ${err.message}`);
  }

  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  runGuard(mode, args)
    .then((code) => {
      if (code) process.exit(code);
    })
    .catch((error) => {
      annotation("error", error.message);
      console.error(error.message);
      process.exit(1);
    });
}
