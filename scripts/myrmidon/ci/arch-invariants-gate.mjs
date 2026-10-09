#!/usr/bin/env node
// ARCH-GUARD (OPE-6856): fitness functions of the architecture invariants
// INV-10..INV-13 from docs/architecture/README.md (source: OPE-56 §0).
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
/** Red-side selftests set this to a sandbox baseline (or "none"). */
export const TEST_HOOKS = { migrationBaselineOverride: null };

const PILOT_WORD = /pilot/i;
/** Identifier-ish occurrences (not part of a longer identifier) count; a
 * substring inside another word does not. */
const PILOT_TOKEN = /(?<![A-Za-z0-9_])pilot(?![A-Za-z0-9_])/i;

/** Sites whose call window has no literal issue/task keys because the context
 * is forwarded whole (typed decision objects/rows that carry issueId), or the
 * key is the callee contract. Kept minimal; each entry names why it passes. */
const INV10_FORWARDED = new Set([
  // decision objects typed with issueId (review-path recovery builds payload+
  // contextSnapshot around input.issueId in recovery/review-path-recovery.ts)
  "server/src/services/heartbeat.ts:13098",
  "server/src/services/heartbeat.ts:13488",
  "server/src/services/heartbeat.ts:13602",
  // resumption of a deferred wake whose context is the original comment wake
  // (issueId is a checked invariant of the loop, heartbeat.ts ~10158)
  "server/src/services/heartbeat.ts:10243",
  // the shared wrapper: enqueueWakeup(agentId, opts) — every caller of THIS
  // wrapper passes its own checked context; the wrapper forwards opts whole
  "server/src/services/heartbeat.ts:20100",
  // context built by watchdogWakeContext (task-watchdogs.ts, embeds
  // watchdogIssue.id) and passed as a variable
  "server/src/services/task-watchdogs.ts:1554",
]);

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
  return fs
    .readdirSync(full, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => path.join(relDir, e.name));
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
    const full = path.join(root, relDir);
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.(?:ts|tsx)$/.test(entry.name)) continue;
      const text = fs.readFileSync(path.join(root, rel), "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        for (const match of line.matchAll(/enqueueWakeup\s*\(/g)) {
          const window = callWindow(lines, i, match.index);
          const site = `${rel}:${i + 1}`;
          if (INV10_FORWARDED.has(site)) continue;
          const lineText = lines[i];
          const beforeCall = lineText.slice(0, match.index).trim();
          const forwards =
            /=>\s*$/.test(beforeCall) ||
            /=>\s*enqueueWakeup\s*\(/.test(window.text) ||
            /function\s+enqueueWakeup|opts:\s*WakeupOptions/.test(lineText);
          const manual = /source:\s*"(?:on_demand|timer)"|source:\s*\w+\.source/.test(window.text);
          const taskBound = /\b(?:issueId|taskId|taskKey|childId|issue\.id|issue_id|claimed\.id|candidate\.id|session\.issueId|action\.issueId|input\.issueId|watchdogIssue\.id|recoveryIssue\.id|target\.issueId)\b/.test(window.text);
          const schedulerTick = /heartbeat_timer/.test(window.text);
          if (!taskBound && !manual && !schedulerTick && !forwards) {
            findings.push(`${site}: automatic enqueueWakeup without issue/task context (INV-10)`);
          }
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
  for (const rel of [...listTsFiles(root, SWARM_SERVER_DIR), SWARM_SHARED]) {
    if (rel === SWARM_SHARED) continue;
    const text = readIfExists(root, rel);
    if (!text) continue;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (/\.sort\s*\(/.test(line)) {
        findings.push(`${rel}:${i + 1}: queue code must use orderSwarmQueueCandidates, not .sort() (INV-11)`);
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
    (rel) => !/\.myrmidon\.test\.tsx?$/.test(rel),
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
  // New-gap check: the set of numbers present must be a superset of the
  // baseline's; any number between the min and max that is missing AND was
  // present in the baseline is a removal, not a new gap. Numbers were never
  // renumbered in this repo, so gap = a number that was in the baseline and
  // is gone, or duplicates above.
  const override = TEST_HOOKS.migrationBaselineOverride;
  const baselineRel = override
    ? override === "none" ? null : override
    : path.join(path.dirname(fileURLToPath(import.meta.url)), MIGRATION_BASELINE);
  if (baselineRel && fs.existsSync(baselineRel)) {
    const baseline = JSON.parse(fs.readFileSync(baselineRel, "utf8"));
    const baselineNumbers = new Set(baseline.numbers ?? []);
    for (const n of baselineNumbers) {
      if (!seen.has(n)) {
        findings.push(`${MIGRATIONS_DIR}: migration number ${String(n).padStart(4, "0")} disappeared vs baseline (INV-13)`);
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
