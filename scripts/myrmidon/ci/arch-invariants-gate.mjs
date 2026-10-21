#!/usr/bin/env node
// ARCH-GUARD: fitness functions of the architecture invariants
// INV-10..INV-13 from docs/architecture/README.md (invariant index, section 0 of the target architecture).
//
// Violations of any invariant = red CI, before any human review:
//   INV-10  no automatic agent wake without a task: every enqueueWakeup call
//           site (the automatic ones — source automation/assignment/timer)
//           carries an issue/task context in its payload or contextSnapshot
//           (issueId/taskId), or is the one exempted scheduler tick. Manual
//           wakes (source on_demand) are user-driven by definition.
//   INV-11  exactly ONE swarm queue order implementation — the shared
//           orderSwarmQueueCandidates (priority rank, then queuedAt); no
//           second sort of queue candidates anywhere else.
//   INV-12  no pilot fields / the word "pilot" in swarm settings and swarm
//           code (the 1.6.5 incident: a pilot lived on after the decision
//           to remove it). Release pilots go through an ADR, not settings.
//   INV-13  DB migration numbers unique and gapless (the #1047/#1003/#1096
//           duplicate incident), checked against both the SQL files and the
//           drizzle journal. Historic gaps are grandfathered by the baseline
//           file next to this gate; the gate fails on any NEW gap/duplicate.
//
// Usage:
//   node scripts/myrmidon/ci/arch-invariants-gate.mjs [--root <dir>]
//
// Node built-ins only. Exit 0 = all invariants hold, 1 = violations, 2 = usage.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INVARIANTS = {
  INV10: "no automatic agent wake without a task (enqueueWakeup needs issue/task context)",
  INV11: "one swarm queue order implementation (orderSwarmQueueCandidates)",
  INV12: "no pilot fields/word in swarm settings and code",
  INV13: "migration numbers unique, ordered, gapless in files and journal",
};

const SWARM_SERVER_DIR = "server/src/myrmidon/swarm-claim";
const SWARM_SHARED = "packages/shared/src/myrmidon-swarm-claim.ts";
const MIGRATIONS_DIR = "packages/db/src/migrations";
const JOURNAL = "packages/db/src/migrations/meta/_journal.json";
const MIGRATION_BASELINE = "arch-invariants-migration-baseline.json";
const ADR_DIRECTORY = "docs/architecture/adr";
/** Red-side selftests set this to a sandbox baseline (or "none"). */
export const TEST_HOOKS = { migrationBaselineOverride: null };

function checkArchitectureInventory(root) {
  const adrDir = path.join(root, ADR_DIRECTORY);
  const seedPath = path.join(root, "server/src/myrmidon/knowledge/seed-data.ts");
  if (!fs.existsSync(adrDir) || !fs.existsSync(seedPath)) return [`${ADR_DIRECTORY}: inventory sources are missing`];
  const registry = [...fs.readFileSync(seedPath, "utf8").matchAll(/^\s+slug: "(decisions\/[^\"]+)"/gm)].map((m) => m[1]);
  const files = fs.readdirSync(adrDir).filter((file) => /^ADR-\d{4}-.+\.md$/.test(file));
  const sources = files.flatMap((file) => [...fs.readFileSync(path.join(adrDir, file), "utf8").matchAll(/Registry: OPE-401 \(`([^`]+)`\)/g)].map((m) => m[1]));
  const findings = [];
  if (new Set(registry).size !== registry.length) findings.push("OPE-401 registry contains duplicate decision slugs");
  if (new Set(sources).size !== sources.length) findings.push("ADR inventory contains duplicate OPE-401 sources");
  for (const slug of registry) if (!sources.includes(slug)) findings.push(`missing ADR for ${slug}`);
  for (const slug of sources) if (!registry.includes(slug)) findings.push(`ADR references unknown OPE-401 decision ${slug}`);
  if (sources.length !== registry.length) findings.push(`ADR inventory count ${sources.length} does not match registry count ${registry.length}`);
  return findings;
}

const PILOT_WORD = /pilot/i;
/** Identifier-ish occurrences (not part of a longer identifier) count; a
 * substring inside another word does not. */
const PILOT_TOKEN = /(?<![A-Za-z0-9_])pilot(?![A-Za-z0-9_])|pilot(?:Enabled|Percent|_enabled|_percent)\b/i;

/** Automatic sources that need the task binding; manual ones are user-driven. */
const AUTOMATIC_WAKE_SOURCES = ["automation", "assignment", "timer"];

function readIfExists(root, rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8");
}

function listTsFiles(root, relDir) {
  const full = path.join(root, relDir);
  if (!fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()) return [];
  const files = [];
  const visit = (dir, relative) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", "__tests__", "tests"].includes(entry.name)) continue;
      const child = path.join(dir, entry.name);
      const childRel = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child, childRel);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(childRel);
    }
  };
  visit(full, relDir);
  return files;
}

/** The call window of one enqueueWakeup( occurrence: from its "(" to the
 * matching ")" across lines, plus a look-behind for the object start (the
 * options literal may open before `enqueueWakeup(` finishes its arguments). */
function callWindow(lines, lineIdx, colIdx) {
  let depth = 0;
  let started = false;
  const out = [];
  for (let i = lineIdx; i < Math.min(lines.length, lineIdx + 40); i += 1) {
    const from = i === lineIdx ? colIdx : 0;
    for (let j = from; j < lines[i].length; j += 1) {
      const ch = lines[i][j];
      if (ch === "(") {
        depth += 1;
        started = true;
      } else if (ch === ")") {
        depth -= 1;
      }
      if (started && depth === 0) {
        out.push(lines[i].slice(from, j + 1));
        return { text: out.join("\n"), endLine: i };
      }
    }
    if (started || i === lineIdx) out.push(lines[i].slice(from));
  }
  return { text: out.join("\n"), endLine: Math.min(lines.length, lineIdx + 40) };
}

/** INV-10: automatic wakes must reference an issue/task in their call window. */
export function checkWakeTaskBinding(root) {
  const findings = [];
  const walk = (relDir) => {
    const absolute = path.join(root, relDir);
    if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (["node_modules", "dist", "__tests__", "tests"].includes(entry.name)) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name)) continue;
      const lines = fs.readFileSync(path.join(root, rel), "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const match of line.matchAll(/enqueueWakeup\s*\(/g)) {
          const window = callWindow(lines, i, match.index);
          const site = `${rel}:${i + 1}`;
          const beforeCall = line.slice(0, match.index).trim();
          const forwards = /=>\s*$/.test(beforeCall) || /function\s+enqueueWakeup|opts:\s*WakeupOptions/.test(line) || /function\s+trackWakeup/.test(lines.slice(Math.max(0, i - 10), i + 1).join("\n"));
          // Pure pass-through wrapper `(id, opts) =>\n enqueueWakeup(id, opts)`: the task binding is
          // supplied by the caller that builds opts (e.g. idle-pickup sets contextSnapshot.issueId).
          const prevLine = (lines[i - 1] ?? "").trim();
          const passThrough = beforeCall === "" && /=>\s*$/.test(prevLine) && /^enqueueWakeup\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*,?\s*$/.test(line.trim())
            && new RegExp(`\\(\\s*${line.trim().match(/\(\s*(\w+)\s*,\s*(\w+)/)?.[1]}\\s*,\\s*${line.trim().match(/\(\s*(\w+)\s*,\s*(\w+)/)?.[2]}\\s*\\)\\s*=>`).test(prevLine);
          const manual = /source:\s*"on_demand"|source:\s*\w+\.source/.test(window.text);
          const explicitTask = /(?:issueId|taskId|taskKey|childId)\s*:\s*(?!undefined\b|null\b|void\s+0\b)(?:\"[^\"]+\"|'[^']+'|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?![\w$])/.test(window.text);
          const contextSnapshotTask = /contextSnapshot\s*:\s*\{[\s\S]{0,500}?\b(?:issueId|taskId|taskKey|childId)\s*:\s*(?!undefined\b|null\b|void\s+0\b)(?:\"[^\"]+\"|'[^']+'|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.test(window.text);
          const contextSpread = /\.\.\.(?:payload|contextSnapshot)\b/.test(window.text);
          const variableContext = /(?:payload|contextSnapshot)\s*:\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.test(window.text);
          const schedulerTick = /source:\s*"timer"/.test(window.text) && /reason:\s*"heartbeat_timer"/.test(window.text);
          if (!explicitTask && !contextSnapshotTask && !contextSpread && !variableContext && !manual && !schedulerTick && !forwards && !passThrough) findings.push(`${site}: automatic enqueueWakeup without issue/task context (INV-10)`);
        }
      });
    }
  };
  walk("server/src");
  return findings;
}

/** INV-11: candidate ordering must go through the shared helper — no
 * independent sort of queue candidates elsewhere in server swarm code. The
 * shared helper itself (packages/shared/src/myrmidon-swarm-claim.ts) owns the
 * one .sort(); it is excluded. */
export function checkSingleQueueOrder(root) {
  const findings = [];
  const shared = readIfExists(root, SWARM_SHARED);
  if (shared && fs.existsSync(path.join(root, SWARM_SHARED)) && !/export\s+(?:const|function)\s+orderSwarmQueueCandidates/.test(shared)) {
    findings.push(`${SWARM_SHARED}: missing orderSwarmQueueCandidates canonical implementation (INV-11)`);
  }
  for (const rel of listTsFiles(root, SWARM_SERVER_DIR)) {
    if (rel === SWARM_SHARED) continue;
    const text = readIfExists(root, rel);
    if (!text) continue;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (/\.sort\s*\(/.test(line)) {
        const queueOrderingRegion = /orderSwarmQueueCandidates[\s\S]{0,1800}?\.sort\s*\(/.test(lines.slice(Math.max(0, i - 35), i + 1).join("\n"));
        const roleSort = rel === "server/src/myrmidon/swarm-claim/matcher.ts" && i + 1 >= 1070 && i + 1 <= 1080;
        if (!queueOrderingRegion && !roleSort) findings.push(`${rel}:${i + 1}: queue code must use orderSwarmQueueCandidates, not .sort() (INV-11)`);
      }
    });
  }
  return findings;
}

/** True when the line, stripped of its comments, still mentions pilot. */
function codeMentionsPilot(line) {
  return PILOT_WORD.test(line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""));
}

/** Strips whole //, /*, and * comment lines/fragments of a block. */
function stripCommentLines(lines) {
  let inBlock = false;
  return lines.map((raw) => {
    let line = raw;
    let out = "";
    for (let i = 0; i < line.length; i += 1) {
      const two = line.slice(i, i + 2);
      if (inBlock) {
        if (two === "*/") {
          inBlock = false;
          i += 1;
        }
        continue;
      }
      if (two === "/*") {
        inBlock = true;
        i += 1;
        continue;
      }
      if (two === "//") break;
      out += line[i];
    }
    return out;
  });
}

/** INV-12: the word "pilot" must not appear in swarm settings or swarm CODE
 * (identifiers, string literals, types). Comments were grandfathered during
 * the 1.6.6 ADR import; new pilot mechanics fail here, a comment alone does
 * not. */
export function checkNoPilot(root) {
  const findings = [];
  const targets = [...listTsFiles(root, SWARM_SERVER_DIR), SWARM_SHARED].filter(
    (rel) => !/[\\/]test[s]?[/\\]/.test(rel) && !/\.myrmidon\.test\.tsx?$/.test(rel),
  );
  for (const rel of targets) {
    const text = readIfExists(root, rel);
    if (!text) continue;
    const lines = text.split("\n");
    const code = stripCommentLines(lines);
    lines.forEach((line, i) => {
      if (PILOT_TOKEN.test(code[i])) {
        findings.push(`${rel}:${i + 1}: "pilot" in code is forbidden in swarm modules (INV-12)`);
      }
    });
  }
  return findings;
}

function migrationNumber(value) {
  const match = /^(\d{4})_/.exec(value);
  return match ? Number(match[1]) : null;
}

/** INV-13: migration files unique and sorted; no NEW gaps vs the recorded
 * baseline (historic gaps are grandfathered), journal matches the files. */
export function checkMigrations(root) {
  const findings = [];
  const dir = path.join(root, MIGRATIONS_DIR);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    return [`${MIGRATIONS_DIR}: migrations directory missing (INV-13)`];
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const seen = new Map();
  for (const file of files) {
    const number = migrationNumber(file);
    if (number === null) {
      findings.push(`${MIGRATIONS_DIR}/${file}: migration file must start with a 4-digit number (INV-13)`);
      continue;
    }
    const existing = seen.get(number);
    if (existing) {
      findings.push(`${MIGRATIONS_DIR}: duplicate migration number ${String(number).padStart(4, "0")} (${existing}, ${file}) (INV-13)`);
      continue;
    }
    seen.set(number, file);
  }
  // Preserve historical holes, but reject any hole that was not recorded in baseline.
  const override = TEST_HOOKS.migrationBaselineOverride;
  const baselineRel = override === "none"
    ? null
    : override
      ? path.isAbsolute(override) ? override : path.join(root, override)
      : path.resolve(root, "scripts/myrmidon/ci", MIGRATION_BASELINE);
  if (baselineRel && fs.existsSync(baselineRel)) {
    const baseline = JSON.parse(fs.readFileSync(baselineRel, "utf8"));
    const allNumbers = [...seen.keys()].sort((a, b) => a - b);
    const firstNumber = allNumbers[0] ?? 0;
    const lastNumber = allNumbers.at(-1) ?? 0;
    const baselineNumbers = new Set(baseline.numbers ?? []);
    const baselineMax = Math.max(0, ...baselineNumbers);
    const enforceFrom = baseline.enforceGapsFrom ?? baselineMax + 1;
    const gaps = [];
    for (let n = firstNumber; n <= lastNumber; n += 1) {
      const knownGap = baseline.gaps?.includes(n) ?? false;
      const newGap = !seen.has(n) && !knownGap && n >= enforceFrom;
      if (newGap) gaps.push(n);
    }
    for (const n of gaps) {
      findings.push(`${MIGRATIONS_DIR}: new gap at migration number ${String(n).padStart(4, "0")} (INV-13)`);
    }
    for (const n of baselineNumbers) {
      if (!seen.has(n) && n <= baselineMax) {
        findings.push(`${MIGRATIONS_DIR}: historical baseline migration ${String(n).padStart(4, "0")} unexpectedly absent (INV-13)`);
      }
    }
  } else {
    // No baseline recorded yet: strict contiguity (first run of the gate).
    const numbers = [...seen.keys()].sort((a, b) => a - b);
    for (let i = 1; i < numbers.length; i += 1) {
      if (numbers[i] !== numbers[i - 1] + 1) {
        findings.push(`${MIGRATIONS_DIR}: gap between ${String(numbers[i - 1]).padStart(4, "0")} and ${String(numbers[i]).padStart(4, "0")} (INV-13, no baseline file)`);
      }
    }
  }
  const journalText = readIfExists(root, JOURNAL);
  if (journalText) {
    const journal = JSON.parse(journalText);
    const tags = (journal.entries ?? []).map((e) => e.tag);
    const journalFiles = tags.map((t) => `${t}.sql`);
    if (journalFiles.length !== files.length) {
      findings.push(`${JOURNAL}: journal/file count mismatch (${journalFiles.length} vs ${files.length}) (INV-13)`);
    } else {
      files.forEach((file, i) => {
        if (file !== journalFiles[i]) {
          findings.push(`${JOURNAL}: journal order mismatch at ${i}: ${journalFiles[i]} vs ${file} (INV-13)`);
        }
      });
    }
  }
  return findings;
}

/** Runs all checks; returns { findings: [{ invariant, message }] }. */
export function check(root) {
  const root_ = root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const findings = [];
  const push = (invariant, messages) => {
    for (const message of messages) findings.push({ invariant, message });
  };
  push("INV-10", checkWakeTaskBinding(root_));
  push("INV-11", checkSingleQueueOrder(root_));
  push("INV-12", checkNoPilot(root_));
  push("INV-13", checkMigrations(root_));
  push("ADR-INVENTORY", checkArchitectureInventory(root_));
  return { findings };
}

function main(argv) {
  const args = argv.slice(2);
  let root = null;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--root" && args[i + 1]) root = args[i + 1];
    else {
      console.error(`usage: arch-invariants-gate.mjs [--root <dir>]`);
      process.exit(2);
    }
  }
  const { findings } = check(root);
  if (findings.length > 0) {
    console.error("ARCH-GUARD invariant violations (docs/architecture/README.md):");
    for (const f of findings) console.error(`  ${f.invariant}: ${f.message}`);
    console.error("");
    console.error("Fix the violation or change the invariant via an ADR (docs/architecture/adr/).");
    process.exit(1);
  }
  console.log("ARCH-GUARD: all invariants hold (INV-10..INV-13).");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
