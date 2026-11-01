#!/usr/bin/env node
// check-vendor-name.mjs — the vendor-name gate of the 1.7 rebrand (REBRAND F).
//
// Counts the vendor's name in the BUILT interface (ui/dist) and in the recorded
// response snapshots (scripts/myrmidon/vendor-name/snapshots, or a fresh capture
// with --snapshots <dir>) against the policy file next to this script.
//
// Two classes, one policy (see docs/myrmidon/guides/rebrand-vendor-name.md):
//   visible    \bPaperclip\b  — what a person reads; the gated class.
//   identifier (?i)paperclip  — @paperclipai/*, PAPERCLIP_*, headers, paths;
//                               reported, never gated (aliases for one release).
//
// Modes:
//   ratchet (default) — the gate fails when a target's visible count grows
//                       above its baseline recorded in the policy file.
//   strict            — the gate fails on any visible occurrence left outside
//                       the policy exceptions.
// Mode precedence: --mode flag, then MYRMIDON_VENDOR_NAME_CHECK_MODE, then the
// policy file's "mode" field. The baseline: --baseline flag, then
// MYRMIDON_VENDOR_NAME_CHECK_BASELINE, then the per-target policy baseline.
//
// Usage:
//   node scripts/myrmidon/vendor-name/check-vendor-name.mjs
//       [--target bundle|snapshots|all] [--snapshots <dir>]
//       [--mode ratchet|strict] [--baseline <n>] [--json <report-path>]
//
// Exit codes: 0 pass, 1 the vendor name is over its allowance, 2 usage or read
// error (an unreadable policy or a missing target directory is never clean).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const POLICY_PATH = path.join(SCRIPT_DIR, "vendor-name-policy.json");
const DEFAULT_SNAPSHOTS_DIR = path.join(SCRIPT_DIR, "snapshots");

function usage(message) {
  if (message) process.stderr.write(`check-vendor-name: ${message}\n`);
  process.stderr.write(
    [
      "usage: check-vendor-name.mjs",
      "  [--target bundle|snapshots|all]   (default: all)",
      "  [--snapshots <dir>]               (default: scripts/myrmidon/vendor-name/snapshots)",
      "  [--mode ratchet|strict]           (overrides policy and env)",
      "  [--baseline <n>]                  (overrides policy and env for every target)",
      "  [--json <path>]                   (write the machine-readable report there)",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = { target: "all", snapshotsDir: null, mode: null, baseline: null, jsonPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--target") {
      if (next !== "bundle" && next !== "snapshots" && next !== "all") usage(`--target must be bundle, snapshots or all`);
      out.target = next;
      i += 1;
    } else if (arg === "--snapshots") {
      if (!next) usage("--snapshots needs a directory");
      out.snapshotsDir = next;
      i += 1;
    } else if (arg === "--mode") {
      if (next !== "ratchet" && next !== "strict") usage(`--mode must be ratchet or strict`);
      out.mode = next;
      i += 1;
    } else if (arg === "--baseline") {
      const parsed = Number.parseInt(next ?? "", 10);
      if (!Number.isFinite(parsed) || parsed < 0) usage("--baseline needs a non-negative integer");
      out.baseline = parsed;
      i += 1;
    } else if (arg === "--json") {
      if (!next) usage("--json needs a path");
      out.jsonPath = next;
      i += 1;
    } else {
      usage(`unknown argument ${arg}`);
    }
  }
  return out;
}

function readPolicy(policyPath) {
  let raw;
  try {
    raw = fs.readFileSync(policyPath, "utf8");
  } catch (error) {
    usage(`cannot read the policy file ${policyPath}: ${error.message}`);
  }
  let policy;
  try {
    policy = JSON.parse(raw);
  } catch (error) {
    usage(`the policy file ${policyPath} is not valid JSON: ${error.message}`);
  }
  return policy;
}

/** Compiles the policy exception list into matchers. */
function compileExceptions(policy) {
  const pathGlobs = [];
  for (const pattern of policy.exceptions?.paths ?? []) {
    const re = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`,
    );
    pathGlobs.push(re);
  }
  const spans = (policy.exceptions?.contentPatterns ?? []).map((source) => new RegExp(source, "g"));
  return { pathGlobs, spans };
}

/** Blank out the allowlisted spans, then count both token classes. */
function countText(text, tokens, spans) {
  let rest = text;
  for (const span of spans) {
    rest = rest.replace(span, "");
    span.lastIndex = 0;
  }
  return {
    visible: [...rest.matchAll(tokens.visible)].length,
    identifier: [...rest.matchAll(tokens.identifier)].length,
  };
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out.sort();
}

function scanTarget(name, dir, policy, tokens, exceptions, resolvedMode, modeSource, baselineOverride) {
  const configured = policy.targets?.[name];
  if (!fs.existsSync(dir)) {
    return {
      name,
      dir,
      status: "missing",
      visible: 0,
      identifier: 0,
      baseline: 0,
      mode: resolvedMode,
      modeSource,
      files: 0,
      detail: [],
    };
  }
  const baseline = baselineOverride ?? configured?.baseline ?? 0;
  const files = walkFiles(dir);
  let visible = 0;
  let identifier = 0;
  const detail = [];
  for (const file of files) {
    const relative = path.relative(REPO_ROOT, file);
    if (exceptions.pathGlobs.some((re) => re.test(relative))) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const counted = countText(text, tokens, exceptions.spans);
    visible += counted.visible;
    identifier += counted.identifier;
    if (counted.visible > 0 || counted.identifier > 0) {
      // First line that carries a mention, so a person can jump to it.
      const lines = text.split("\n");
      let line = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const inLine = countText(lines[i], tokens, exceptions.spans);
        if (inLine.visible > 0 || inLine.identifier > 0) {
          line = i + 1;
          break;
        }
      }
      detail.push({ file: relative, visible: counted.visible, identifier: counted.identifier, line });
    }
  }
  const over =
    resolvedMode === "strict" ? visible > 0 : visible > baseline;
  return {
    name,
    dir,
    status: over ? "violation" : "ok",
    visible,
    identifier,
    baseline,
    mode: resolvedMode,
    modeSource,
    files: files.length,
    detail: detail.slice(0, 20),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = readPolicy(POLICY_PATH);
  const tokens = {
    visible: new RegExp(policy.tokens?.visible ?? "\\bPaperclip\\b", "g"),
    identifier: new RegExp((policy.tokens?.identifier ?? "paperclip").replace(/^\(\?i\)/, ""), "gi"),
  };

  // Mode: flag > env > policy file.
  const envMode = process.env.MYRMIDON_VENDOR_NAME_CHECK_MODE;
  let modeSource = "policy";
  let mode = policy.mode === "strict" ? "strict" : "ratchet";
  if (envMode === "ratchet" || envMode === "strict") {
    mode = envMode;
    modeSource = "env";
  }
  if (args.mode) {
    mode = args.mode;
    modeSource = "flag";
  }

  // Baseline: flag > env > policy per-target value.
  let baselineOverride = args.baseline;
  if (baselineOverride === null || baselineOverride === undefined) {
    const envBaseline = Number.parseInt(process.env.MYRMIDON_VENDOR_NAME_CHECK_BASELINE ?? "", 10);
    if (Number.isFinite(envBaseline) && envBaseline >= 0) baselineOverride = envBaseline;
  }

  const exceptions = compileExceptions(policy);
  const targets = [];
  if (args.target === "all" || args.target === "bundle") {
    targets.push(
      scanTarget(
        "bundle",
        path.resolve(REPO_ROOT, policy.targets?.bundle?.path ?? "ui/dist"),
        policy,
        tokens,
        exceptions,
        mode,
        modeSource,
        baselineOverride,
      ),
    );
  }
  if (args.target === "all" || args.target === "snapshots") {
    targets.push(
      scanTarget(
        "snapshots",
        path.resolve(args.snapshotsDir ?? DEFAULT_SNAPSHOTS_DIR),
        policy,
        tokens,
        exceptions,
        mode,
        modeSource,
        baselineOverride,
      ),
    );
  }

  const totals = targets.reduce(
    (acc, target) => ({ visible: acc.visible + target.visible, identifier: acc.identifier + target.identifier }),
    { visible: 0, identifier: 0 },
  );
  const violations = targets.filter((target) => target.status === "violation");
  const status = violations.length > 0 ? "violation" : "ok";
  const exitCode = violations.length > 0 ? 1 : 0;

  const report = {
    mode,
    modeSource,
    exitCode,
    status,
    totals,
    targets,
  };
  if (args.jsonPath) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(args.jsonPath)), { recursive: true });
      fs.writeFileSync(args.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      usage(`cannot write the report to ${args.jsonPath}: ${error.message}`);
    }
  }

  for (const target of targets) {
    if (target.status === "missing") {
      process.stdout.write(`${target.name}: missing (${target.dir}) — build or capture it first; never reported clean\n`);
      continue;
    }
    const allowance =
      target.mode === "strict" ? "strict: no occurrence outside the exceptions" : `baseline ${target.baseline}`;
    process.stdout.write(
      `${target.name}: ${target.visible} visible / ${target.identifier} identifier over ${target.files} file(s) — ${target.status} (${allowance})\n`,
    );
    for (const row of target.detail) {
      process.stdout.write(`  ${row.file}:${row.line} visible=${row.visible} identifier=${row.identifier}\n`);
    }
  }
  process.stdout.write(
    `vendor-name gate: ${status} — totals ${totals.visible} visible / ${totals.identifier} identifier, mode ${mode} (${modeSource})\n`,
  );
  return exitCode === 1 ? 1 : 0;
}

process.exit(main());
