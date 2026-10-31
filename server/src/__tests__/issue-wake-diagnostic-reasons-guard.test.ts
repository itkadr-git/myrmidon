import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static guard keeping ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS in sync with the
 * wake reasons the engine actually writes (OPE-2769).
 *
 * The diagnostics projection `projectWakeDiagnosticReason` masks any reason
 * outside the whitelist as "other", so a reason the wake engine itself writes
 * (e.g. `execution_reconciliation_required` on an execution hold) used to show
 * up as `reason=other failureClass=failed`. This test re-derives the set of
 * literal reasons reachable from wake-enqueue sites — `.wakeup(...)` calls,
 * `insert/update(agentWakeupRequests)`, and `writeSkipped*Request(...)` — by
 * scanning the server and shared sources, and fails when a discovered reason
 * is missing from the whitelist. Reasons built dynamically (variables,
 * template literals) cannot be checked statically and are skipped; a dynamic
 * reason still has to be added to the whitelist by hand when introduced.
 */

const SERVER_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_SRC = join(SERVER_SRC, "..", "..", "packages", "shared", "src");

const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__"]);
const ANCHOR_OBJECT_LOOKAHEAD = 400;
const INSERT_OBJECT_LOOKAHEAD = 60;

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
      out.push(join(dir, entry.name));
    }
  };
  walk(root);
  return out;
}

/** name -> value for every `const NAME = "value"` in the scanned sources. */
function collectStringConsts(files: string[]): Map<string, string> {
  const consts = new Map<string, string>();
  const pattern = /(?:^|\n)\s*(?:export )?const ([A-Z0-9_]+) = "([A-Za-z0-9_.-]+)"/g;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      consts.set(match[1], match[2]);
    }
  }
  return consts;
}

function balancedBraces(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

/** Top-level `reason: <token>` entries of an object literal (depth 1 only). */
function topLevelReasonTokens(objectLiteral: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  for (let i = 0; i < objectLiteral.length; i += 1) {
    const ch = objectLiteral[i];
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    if (depth !== 1) continue;
    const rest = objectLiteral.slice(i);
    const key = /^reason\s*:/.exec(rest);
    if (!key) continue;
    const value = /^\s*("[A-Za-z0-9_.-]+"|[A-Za-z0-9_]+|`[^`]*`)/.exec(rest.slice(key[0].length));
    if (value) tokens.push(value[1]);
    i += key[0].length - 1;
  }
  return tokens;
}

function resolveReasonToken(token: string, consts: Map<string, string>): string | null {
  if (token.startsWith('"')) return token.slice(1, -1);
  return consts.get(token) ?? null;
}

/** Literal wake reasons reachable from enqueue sites, e.g. ["issue_commented"]. */
function collectWrittenReasons(): { literal: Set<string>; dynamic: Set<string> } {
  const files = [...listTsFiles(SERVER_SRC), ...listTsFiles(SHARED_SRC)];
  const enqueueAnchors = /\.wakeup\(|enqueueWakeup\(/g;
  const skippedRequestAnchors = /writeSkipped(?:Heartbeat)?Request\(\s*("[A-Za-z0-9_.-]+"|[A-Z0-9_]+)/g;
  const tableAnchors = /(?:insert|update)\(agentWakeupRequests\)/g;
  const literal = new Set<string>();
  const dynamic = new Set<string>();

  const add = (token: string) => {
    const resolved = resolveReasonToken(token, consts);
    if (resolved) literal.add(resolved);
    else dynamic.add(token);
  };

  const consts = collectStringConsts(files);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(enqueueAnchors)) {
      const brace = source.indexOf("{", match.index + match[0].length);
      if (brace < 0 || brace - (match.index + match[0].length) > ANCHOR_OBJECT_LOOKAHEAD) continue;
      for (const token of topLevelReasonTokens(balancedBraces(source, brace))) add(token);
    }
    for (const match of source.matchAll(skippedRequestAnchors)) add(match[1]);
    for (const match of source.matchAll(tableAnchors)) {
      const brace = source.indexOf("{", match.index + match[0].length);
      if (brace < 0 || brace - (match.index + match[0].length) > INSERT_OBJECT_LOOKAHEAD) continue;
      for (const token of topLevelReasonTokens(balancedBraces(source, brace))) add(token);
    }
  }
  return { literal, dynamic };
}

const issuesRouteSource = readFileSync(join(SERVER_SRC, "routes", "issues.ts"), "utf8");
const whitelistBlock =
  /const ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS = new Set\(\[([\s\S]*?)\]\)/.exec(issuesRouteSource);
if (!whitelistBlock) throw new Error("ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS not found in routes/issues.ts");
const whitelist = new Set(
  [...whitelistBlock[1].matchAll(/"([A-Za-z0-9_.-]+)"/g)].map((match) => match[1]),
);

describe("issue wake diagnostic reason whitelist", () => {
  it("knows the reason this issue was filed for", () => {
    expect(whitelist.has("execution_reconciliation_required")).toBe(true);
  });

  it("lists every wake reason a writer can enqueue", () => {
    const { literal, dynamic } = collectWrittenReasons();
    expect(literal.size, "no literal wake reasons discovered — scan is broken").toBeGreaterThan(0);
    const missing = [...literal].filter((reason) => !whitelist.has(reason)).sort();
    expect(
      missing,
      `wake reasons written by the engine but masked as "other": ${missing.join(", ")}; ` +
        `dynamic (unresolvable) sites to check by hand: ${[...dynamic].sort().join(", ") || "none"}`,
    ).toEqual([]);
  });
});
