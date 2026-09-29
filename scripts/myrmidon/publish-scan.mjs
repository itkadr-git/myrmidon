#!/usr/bin/env node
// Publish gate for bot-generated PR descriptions and issue text.
// gitleaks scans commits; this wrapper scans the prose that surrounds them
// before it is published. Bots must call this wrapper instead of posting
// directly: exit 0 means the text may be published, exit 1 means refuse.
//
// Usage:
//   node scripts/myrmidon/publish-scan.mjs [--file <path>] [--patterns-file <path>]
//   cat body.md | node scripts/myrmidon/publish-scan.mjs
//
// Applies the same two rule sets as the diff scanner (scan-diff.mjs): the
// built-in rules of scan-text.mjs (secrets, private addresses, secret file
// paths) and the forbidden patterns from MYRMIDON_FORBIDDEN_PATTERNS, one
// regular expression per line, "#" comments allowed. --patterns-file adds
// patterns from a local file in the same format. Neither the patterns nor the
// matched text are ever printed: stdout holds a short report with the number
// of lines scanned and the findings counted by rule name.
//
// Fail closed: an unreadable input or pattern file is exit 2, never "clean".
// Exit code: 0 publish allowed, 1 publish refused, 2 usage/read error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileForbiddenPatterns } from "./scan-diff.mjs";
import { builtinRules, scanText, summarizeFindings } from "./scan-text.mjs";

function parseArgs(argv) {
  const args = { file: null, patternsFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" || a === "--patterns-file") {
      const value = argv[++i];
      if (!value) throw new Error(`${a} requires a path`);
      if (a === "--file") args.file = value;
      else args.patternsFile = value;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

// Read errors are not caught: a failed read must never look like an empty,
// clean text. main() turns them into exit code 2.
function readInput(args) {
  if (args.file !== null) {
    if (!fs.existsSync(args.file)) throw new Error(`File not found: ${args.file}`);
    return { text: fs.readFileSync(args.file, "utf8"), source: args.file };
  }
  return { text: fs.readFileSync(0, "utf8"), source: "stdin" };
}

/**
 * Builds the forbidden-pattern rules the way scan-diff does: one rule per
 * pattern, named by its line number in the list, never by its content.
 * Patterns from the environment come first, then those from --patterns-file
 * (their names carry a "file" suffix so the two lists cannot be mixed up).
 */
function forbiddenRules(args, env) {
  const rules = [];
  for (const { number, regex } of compileForbiddenPatterns(env.MYRMIDON_FORBIDDEN_PATTERNS)) {
    rules.push({ name: `forbidden pattern #${number}`, regex });
  }
  if (args.patternsFile !== null) {
    const text = fs.readFileSync(args.patternsFile, "utf8");
    for (const { number, regex } of compileForbiddenPatterns(text)) {
      rules.push({ name: `forbidden pattern #${number} (file)`, regex });
    }
  }
  return rules;
}

/**
 * Scans one publishable text and returns a decision.
 * extraRules are the forbidden-pattern rules; they run next to the built-in
 * ones. The result is data only: the wrapper prints it, the matched text
 * stays inside this module.
 */
export function scanForPublication(text, extraRules = []) {
  const findings = scanText(text, [...builtinRules(), ...extraRules]);
  return {
    allowed: findings.length === 0,
    lines: String(text ?? "").length === 0 ? 0 : String(text).split(/\r?\n/).length,
    findingCount: findings.length,
    byRule: summarizeFindings(findings),
  };
}

/**
 * CLI entry point. Returns the exit code:
 * 0 publish allowed, 1 publish refused, 2 usage/read error.
 */
export function main(argv = process.argv.slice(2), env = process.env, log = console) {
  let input;
  let extraRules;
  try {
    const args = parseArgs(argv);
    input = readInput(args);
    extraRules = forbiddenRules(args, env);
  } catch (error) {
    log.error(String(error.message ?? error));
    return 2;
  }
  if (extraRules.length === 0) {
    log.log("::warning title=publish scan::no forbidden patterns configured (MYRMIDON_FORBIDDEN_PATTERNS or --patterns-file); the check for internal names and task numbers is skipped");
  }
  const result = scanForPublication(input.text, extraRules);
  const parts = result.byRule.map(({ rule, count }) => `${rule} x${count}`);
  const summary = parts.length === 0 ? "no findings" : `${result.findingCount} finding(s): ${parts.join(", ")}`;
  log.log(`publish-scan: scanned ${result.lines} line(s) from ${input.source} — ${summary}.`);
  if (result.allowed) {
    log.log("publish-scan: text is clean; publication allowed.");
    return 0;
  }
  log.error("publish-scan: publication refused — remove secrets, internal addresses and names from the text (docs/myrmidon/CONVENTIONS.md, section 9).");
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
