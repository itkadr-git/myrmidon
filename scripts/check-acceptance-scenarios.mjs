#!/usr/bin/env node
/**
 * check-acceptance-scenarios.mjs (PLAN-COVERAGE-C / 1.7)
 *
 * Validates acceptance-scenarios documents and cross-checks each scenario's
 * testRefs against tests that exist in the repository.
 *
 * Input: one or more JSON documents in the PLAN-COVERAGE-B contract format
 * (packages/shared/src/myrmidon/acceptance-scenarios.ts):
 *   { version, scenarios: [ { id, title, falsifiedWhen, testRefs, ... } ] }
 * or a bare array of scenarios.
 *
 * Checks:
 *   - document and every scenario validate against the contract
 *     (falsifiedWhen is required, ids are non-empty, ...);
 *   - scenario ids are unique within a document (duplicates are a failure);
 *   - every testRef (string form or {path, testName?|suite?} form) points at
 *     a test that EXISTS in the selected repository tree.
 *
 * Branch scoping (acceptance criterion: the check must read ONLY the branch
 * it was given — in CI that is main/base — and must not read the PR branch or
 * reach the network): when --ref is passed, files are read with
 * `git show <ref>:<path>` from the CURRENT repository checkout, so the check
 * sees exactly that ref's tree and never a worktree mixture. Without --ref,
 * the working tree is read directly. The script never runs git fetch, clone,
 * push or any other network operation; the ref must already exist locally.
 *
 * "Exists in the repository" means the referenced file is present in the
 * selected tree and, when a testName/suite is given, that the name occurs in
 * that file's text. Files are matched as written in testRefs, and also with
 * common test-name suffixes (*.test.ts, *.test.tsx, *.test.mjs, *.test.js,
 * *.spec.ts, *.spec.tsx, *.spec.mjs, *.spec.js) so a plain source-path
 * reference (e.g. server/src/services/heartbeat.ts) is not a false "broken
 * ref" when the actual test lives next to it as heartbeat.test.ts.
 *
 * Exit code: 1 on any problem (invalid document, missing falsifiedWhen,
 * duplicate id, broken testRef); 0 otherwise. Problems are listed on stdout
 * in a human-readable report.
 *
 * Usage:
 *   node scripts/check-acceptance-scenarios.mjs <document.json> [...]
 *   cat doc.json | node scripts/check-acceptance-scenarios.mjs -
 *   node scripts/check-acceptance-scenarios.mjs doc.json --ref origin/main
 *   node scripts/check-acceptance-scenarios.mjs doc.json --repo-root /path/to/checkout
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

// Suffixes tried when the literal ref path is not in the tree: a testRef may
// name the tested module while the test lives in a sibling *.test.* file.
export const TEST_SUFFIXES = [
  "",
  ".test.ts",
  ".test.tsx",
  ".test.mjs",
  ".test.js",
  ".spec.ts",
  ".spec.tsx",
  ".spec.mjs",
  ".spec.js",
];

// ── Git tree access ──────────────────────────────────────────────────────

/**
 * Read a file from a git ref WITHOUT touching the worktree.
 * Returns { ok, content } or { ok: false, missing: true } when the path is
 * absent from the ref, { ok: false, error } on other git failures.
 */
export function readRefFile(repoRoot, ref, filePath) {
  const result = spawnSync("git", ["-C", repoRoot, "show", `${ref}:${filePath}`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status === 0) return { ok: true, content: result.stdout };
  const stderr = `${result.stderr ?? ""}`;
  if (stderr.includes("does not exist") || stderr.includes("No such file or directory") || stderr.includes("exists on disk, but not in")) {
    return { ok: false, missing: true };
  }
  return { ok: false, error: stderr.trim() || `git show ${ref}:${filePath} failed with code ${result.status}` };
}

/**
 * Does the path exist in the ref's tree? (Fast: git cat-file -e, no content.)
 */
export function refFileExists(repoRoot, ref, filePath) {
  const result = spawnSync("git", ["-C", repoRoot, "cat-file", "-e", `${ref}:${filePath}`], {
    encoding: "utf8",
  });
  return result.status === 0;
}

/**
 * Read a file from the working tree. Returns { ok, content } or { ok: false }.
 */
export function readWorktreeFile(repoRoot, filePath) {
  const full = path.resolve(repoRoot, filePath);
  if (!existsSync(full) || !statSync(full).isFile()) return { ok: false };
  try {
    return { ok: true, content: readFileSync(full, "utf8") };
  } catch {
    return { ok: false };
  }
}

// ── testRef resolution ───────────────────────────────────────────────────

/**
 * Resolve one string testRef against a file reader.
 * reader(refPath) -> { ok, content } | { ok: false }
 * Returns { ok: true, path, content } on success,
 *         { ok: false, tried: [...] } when no candidate exists.
 */
export function resolveTestRefFile(testRefPath, reader) {
  const tried = [];
  for (const suffix of TEST_SUFFIXES) {
    const candidate = `${testRefPath}${suffix}`;
    tried.push(candidate);
    const result = reader(candidate);
    if (result.ok) return { ok: true, path: candidate, content: result.content };
  }
  return { ok: false, tried };
}

/**
 * Check a single testRef entry (string or structured object).
 * reader and isDirLike are injectable for tests.
 * Returns { ok: true } or { ok: false, reason }.
 */
export function checkTestRef(ref, reader) {
  const spec = typeof ref === "string" ? { path: ref } : ref;
  const refPath = spec.path;
  const nameHint = spec.testName ?? spec.suite;

  const resolved = resolveTestRefFile(refPath, reader);
  if (!resolved.ok) {
    return { ok: false, reason: `test file not found in the selected tree (tried: ${resolved.tried.join(", ")})` };
  }

  if (nameHint) {
    const content = resolved.content ?? "";
    if (!content.includes(nameHint)) {
      return { ok: false, reason: `test name "${nameHint}" not found in ${resolved.path}` };
    }
  }
  return { ok: true, path: resolved.path };
}

// ── Scenario / document validation ───────────────────────────────────────

const SCENARIO_REQUIRED_FIELDS = ["id", "title", "falsifiedWhen"];
const KNOWN_SCENARIO_FIELDS = new Set([
  "id",
  "title",
  "description",
  "given",
  "when",
  "then",
  "falsifiedWhen",
  "testRefs",
  "tags",
]);
const KNOWN_DOC_FIELDS = new Set([
  "version",
  "scenarios",
  "epicKey",
  "epicIdentifier",
  "issueIdentifier",
  "updatedAt",
  "notes",
]);

function describeTextOrArray(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0);
  return false;
}

/**
 * Structural validation of one scenario. Deliberately mirrors the zod
 * contract (falsifiedWhen required and non-empty; testRefs array of string
 * or {path, testName?, suite?}; no unknown fields) without importing the
 * TypeScript package, so the check runs as plain node.
 * Returns a list of problem strings (empty = valid).
 */
export function validateScenario(scenario, index) {
  const problems = [];
  const at = `scenario[${index}]`;
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
    return [`${at}: not an object`];
  }

  for (const field of SCENARIO_REQUIRED_FIELDS) {
    if (!(field in scenario) || !describeTextOrArray(scenario[field])) {
      problems.push(`${at}: missing or empty required field "${field}"`);
    }
  }
  if (scenario.id !== undefined && (typeof scenario.id !== "string" || scenario.id.trim().length === 0)) {
    problems.push(`${at}: "id" must be a non-empty string`);
  }
  for (const field of ["description"]) {
    if (scenario[field] !== undefined && typeof scenario[field] !== "string") {
      problems.push(`${at}: "${field}" must be a string`);
    }
  }
  for (const field of ["given", "when", "then"]) {
    if (scenario[field] !== undefined && !describeTextOrArray(scenario[field])) {
      problems.push(`${at}: "${field}" must be a non-empty string or a non-empty array of strings`);
    }
  }
  if (scenario.tags !== undefined) {
    if (!Array.isArray(scenario.tags) || !scenario.tags.every((tag) => typeof tag === "string" && tag.trim().length > 0)) {
      problems.push(`${at}: "tags" must be an array of non-empty strings`);
    }
  }
  if (scenario.testRefs !== undefined) {
    if (!Array.isArray(scenario.testRefs)) {
      problems.push(`${at}: "testRefs" must be an array`);
    } else {
      scenario.testRefs.forEach((ref, refIndex) => {
        const refAt = `${at}.testRefs[${refIndex}]`;
        if (typeof ref === "string") {
          if (ref.trim().length === 0) problems.push(`${refAt}: must be a non-empty string`);
        } else if (ref && typeof ref === "object" && !Array.isArray(ref)) {
          if (typeof ref.path !== "string" || ref.path.trim().length === 0) {
            problems.push(`${refAt}: "path" must be a non-empty string`);
          }
          for (const field of ["testName", "suite"]) {
            if (ref[field] !== undefined && (typeof ref[field] !== "string" || ref[field].trim().length === 0)) {
              problems.push(`${refAt}: "${field}" must be a non-empty string`);
            }
          }
          if (ref.line !== undefined && (typeof ref.line !== "number" || !Number.isInteger(ref.line) || ref.line <= 0)) {
            problems.push(`${refAt}: "line" must be a positive integer`);
          }
          const known = ["path", "testName", "suite", "line"];
          for (const key of Object.keys(ref)) {
            if (!known.includes(key)) problems.push(`${refAt}: unknown field "${key}"`);
          }
        } else {
          problems.push(`${refAt}: must be a string or an object with "path"`);
        }
      });
    }
  }
  for (const key of Object.keys(scenario)) {
    if (!KNOWN_SCENARIO_FIELDS.has(key)) problems.push(`${at}: unknown field "${key}"`);
  }
  return problems;
}

/**
 * Structural validation of a document (or bare array). Returns
 * { scenarios, problems } — scenarios may be partially filled when the
 * container itself is broken.
 */
export function validateDocument(doc) {
  const problems = [];
  let scenarios = [];

  if (Array.isArray(doc)) {
    scenarios = doc;
  } else if (doc && typeof doc === "object") {
    for (const key of Object.keys(doc)) {
      if (!KNOWN_DOC_FIELDS.has(key)) problems.push(`document: unknown field "${key}"`);
    }
    if (doc.version !== undefined && (typeof doc.version !== "number" || !Number.isInteger(doc.version) || doc.version <= 0)) {
      problems.push(`document: "version" must be a positive integer`);
    }
    if (!Array.isArray(doc.scenarios)) {
      problems.push(`document: "scenarios" must be an array`);
    } else {
      scenarios = doc.scenarios;
    }
  } else {
    problems.push(`document: expected an object with a "scenarios" array or a bare scenario array`);
  }

  return { scenarios, problems };
}

// ── Core check ───────────────────────────────────────────────────────────

function parseScenarioId(scenario, index) {
  return scenario && typeof scenario === "object" && typeof scenario.id === "string" ? scenario.id : null;
}

/**
 * Check one document against a repo-tree reader.
 * reader(refPath) -> { ok, content } | { ok: false }
 * Returns { problems: string[], scenarioCount, testRefCount }.
 */
export function checkDocument(doc, reader) {
  const { scenarios, problems } = validateDocument(doc);

  const seenIds = new Map();
  scenarios.forEach((scenario, index) => {
    const at = `scenario[${index}]`;
    problems.push(...validateScenario(scenario, index).map((p) => (p.startsWith(at) ? p : p)));

    const id = parseScenarioId(scenario, index);
    if (id !== null) {
      if (seenIds.has(id)) {
        problems.push(`${at}: duplicate scenario id "${id}" (first seen at scenario[${seenIds.get(id)}])`);
      } else {
        seenIds.set(id, index);
      }
    }

    const testRefs = scenario && typeof scenario === "object" && Array.isArray(scenario.testRefs) ? scenario.testRefs : [];
    for (const ref of testRefs) {
      const refPath = typeof ref === "string" ? ref : ref && typeof ref === "object" ? ref.path : undefined;
      const result = checkTestRef(ref, reader);
      if (!result.ok) {
        problems.push(`${at}: broken testRef "${refPath ?? String(ref)}" — ${result.reason}`);
      }
    }
  });

  return { problems, scenarioCount: scenarios.length, testRefCount: scenarios.reduce((sum, s) => sum + (Array.isArray(s?.testRefs) ? s.testRefs.length : 0), 0) };
}

/** Build the tree reader for a ref (git show) or the working tree. */
export function makeReader({ repoRoot = REPO_ROOT, ref = null } = {}) {
  if (ref) {
    return (filePath) => readRefFile(repoRoot, ref, filePath);
  }
  return (filePath) => readWorktreeFile(repoRoot, filePath);
}

function parseArgs(argv) {
  const docPaths = [];
  let ref = null;
  let repoRoot = REPO_ROOT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ref") {
      ref = argv[++i];
      if (!ref) throw new Error("--ref requires a value");
    } else if (arg === "--repo-root") {
      repoRoot = argv[++i];
      if (!repoRoot) throw new Error("--repo-root requires a value");
    } else if (arg === "--help" || arg === "-h") {
      return { docPaths, ref, repoRoot, help: true };
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      docPaths.push(arg);
    }
  }
  return { docPaths, ref, repoRoot };
}

function readDocumentFile(docPath, repoRoot) {
  if (docPath === "-") {
    return readFileSync(0, "utf8");
  }
  const full = path.resolve(repoRoot, docPath);
  if (!existsSync(full)) throw new Error(`document not found: ${docPath}`);
  return readFileSync(full, "utf8");
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exitCode = 2;
    return;
  }
  if (args.help || args.docPaths.length === 0) {
    console.log("Usage: node scripts/check-acceptance-scenarios.mjs <document.json> [...] [--ref <git-ref>] [--repo-root <path>]");
    console.log("  Validates acceptance-scenarios documents (PLAN-COVERAGE-B format) and checks that");
    console.log("  every testRef points at a test existing in the selected tree. --ref reads files");
    console.log("  from that git ref only (e.g. origin/main); without it the working tree is used.");
    process.exitCode = args.help ? 0 : 2;
    return;
  }

  const reader = makeReader({ repoRoot: args.repoRoot, ref: args.ref });
  let allProblems = [];
  let totalScenarios = 0;
  let totalTestRefs = 0;

  for (const docPath of args.docPaths) {
    let raw;
    let doc;
    try {
      raw = readDocumentFile(docPath, args.repoRoot);
      doc = JSON.parse(raw);
    } catch (error) {
      allProblems.push(`${docPath}: cannot read/parse document — ${error.message}`);
      continue;
    }

    const { problems, scenarioCount, testRefCount } = checkDocument(doc, reader);
    totalScenarios += scenarioCount;
    totalTestRefs += testRefCount;
    if (problems.length > 0) {
      console.log(`── ${docPath} ──`);
      for (const problem of problems) console.log(`  ${problem}`);
      allProblems.push(...problems.map((p) => `${docPath}: ${p}`));
    }
  }

  console.log("check-acceptance-scenarios summary");
  console.log(`  Documents checked:  ${args.docPaths.length}`);
  console.log(`  Scenarios checked:  ${totalScenarios}`);
  console.log(`  Test refs resolved: ${totalTestRefs}`);
  console.log(`  Tree mode:          ${args.ref ? `git ref ${args.ref}` : "working tree"}`);
  console.log(`  Problems:           ${allProblems.length === 0 ? "none" : allProblems.length}`);

  if (allProblems.length > 0) {
    console.log("\ncheck-acceptance-scenarios FAILED");
    process.exitCode = 1;
    return;
  }
  console.log("\ncheck-acceptance-scenarios OK");
  process.exitCode = 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
