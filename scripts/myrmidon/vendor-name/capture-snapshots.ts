// Captures the response bodies of the main endpoints into the vendor-name
// snapshot set (myrmidon 1.7 REBRAND F).
//
// The gate on the vendor name has two targets: the built UI bundle and the
// recorded answers of the server (scripts/myrmidon/vendor-name/snapshots). This
// script produces the second one, from the same artifacts the server serves —
// no running instance, no database, no network:
//
//   GET /                    the branded index.html the server hands a browser
//   GET /site.webmanifest    the web app manifest (the name a home-screen icon gets)
//   GET /api/openapi.json    the API document (the descriptions an integration reads)
//
// All three are produced by the server's own functions, so the snapshot is the
// real body and not a copy of it. The capture is deterministic: sorted keys, no
// timestamps, no release version (the version belongs to the release, not to the
// text under check).
//
// Committed snapshots must never carry a secret or an internal address, so every
// body goes through the built-in rules of scan-text.mjs first: a finding refuses
// the write (exit 1) instead of committing the value.
//
// Usage (from the repository root, with the workspace installed):
//   pnpm --filter @paperclipai/server exec tsx \
//     ../scripts/myrmidon/vendor-name/capture-snapshots.ts [--out <dir>] [--ui-dist <dir>]
//
// Exit code: 0 written, 1 refused (a body carried a secret or an internal
// address), 2 usage/read error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Relative imports: this file lives outside the server package.
import { buildOpenApiSpec } from "../../../server/src/routes/openapi.js";
import {
  readBrandedStaticIndexHtml,
  readVersionedWebManifest,
} from "../../../server/src/static-index-html.js";
import { builtinRules, scanText, summarizeFindings } from "../scan-text.mjs";

/**
 * Rules that are heuristics over human-written prose and misfire on a generated
 * document: the API document names its schema properties on hundreds of lines
 * ("apiKey", "password", "token"), and every one of them looks like a
 * secret-like assignment. The document is built from the route definitions, so
 * it cannot carry a runtime value; the remaining rules (real token prefixes,
 * private key headers, private address ranges, credential URLs, secret file
 * paths) still guard the committed snapshot.
 */
const PROSE_ONLY_RULES = new Set(["secret-like assignment"]);

/** The rules a committed snapshot must survive. */
export function snapshotRules() {
  return builtinRules().filter((rule) => !PROSE_ONLY_RULES.has(rule.name));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const DEFAULT_OUT = path.join(HERE, "snapshots");
const DEFAULT_UI_DIST = path.join(ROOT, "ui/dist");

export interface ParsedArgs {
  out: string;
  uiDist: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { out: DEFAULT_OUT, uiDist: DEFAULT_UI_DIST };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case "--out":
        args.out = path.resolve(ROOT, value());
        break;
      case "--ui-dist":
        args.uiDist = path.resolve(ROOT, value());
        break;
      case "--help":
      case "-h":
        args.out = "help";
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

export interface CapturedSnapshot {
  /** File name inside the snapshot set. */
  file: string;
  /** The endpoint whose body this is. */
  endpoint: string;
  method: string;
  contentType: string;
  /** The body as served, as a string (JSON bodies are re-indented, see below). */
  body: string;
}

/**
 * Every string the API document carries, deduplicated and sorted.
 *
 * The document itself is megabytes of structure — one repeated header parameter
 * per operation, every schema spelled out — and it is generated, so committing
 * it whole would dwarf the repository and go stale on any route change. The
 * gate reads text, and this is exactly the text: the title, the description,
 * every operation summary and description, every parameter and field
 * description, every enum label. Nothing that a reader of the document can see
 * is dropped, and the projection is deterministic.
 */
export function apiDocumentText(document: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.trim() !== "") found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item);
    }
  };
  walk(document);
  return [...found].sort();
}

/**
 * Collects the three bodies. `uiDist` must hold the built UI (index.html and
 * site.webmanifest); the API document is built in memory.
 */
export function capture(uiDist: string): CapturedSnapshot[] {
  const indexHtml = path.join(uiDist, "index.html");
  const manifest = path.join(uiDist, "site.webmanifest");
  for (const file of [indexHtml, manifest]) {
    if (!fs.existsSync(file)) {
      throw new Error(`the built UI is not there: ${file} (build it with pnpm --filter @paperclipai/ui build)`);
    }
  }
  const apiDocument = buildOpenApiSpec();
  return [
    {
      file: "index.json",
      endpoint: "/",
      method: "GET",
      contentType: "text/html",
      // The exact HTML the server serves: the same two wrappers it applies.
      body: readBrandedStaticIndexHtml(uiDist),
    },
    {
      file: "site.webmanifest.json",
      endpoint: "/site.webmanifest",
      method: "GET",
      contentType: "application/manifest+json",
      // No release version on purpose: versioned icon URLs change with every
      // release and say nothing about the text under check.
      body: readVersionedWebManifest(uiDist, null),
    },
    {
      file: "openapi.json",
      endpoint: "/api/openapi.json",
      method: "GET",
      contentType: "application/json",
      // The text of the document, not its structure: see apiDocumentText.
      body: `${JSON.stringify(apiDocumentText(apiDocument), null, 1)}\n`,
    },
  ];
}

/**
 * Writes the snapshot set. A body that carries a secret or an internal address
 * refuses the write: the snapshot is committed, so it must be publishable.
 */
export function writeSnapshots(
  snapshots: CapturedSnapshot[],
  outDir: string,
  { log = console.log, error = console.error }: { log?: (message: string) => void; error?: (message: string) => void } = {},
): number {
  for (const snapshot of snapshots) {
    const findings = scanText(snapshot.body, snapshotRules(), []);
    if (findings.length > 0) {
      error(
        `capture-snapshots: refusing to write ${snapshot.file} — the body matches ` +
          `${summarizeFindings(findings).map(({ rule, count }) => `${rule} x${count}`).join(", ")}. ` +
          "The snapshot is committed, so it must carry no secret and no internal address.",
      );
      return 1;
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const snapshot of snapshots) {
    const payload = {
      endpoint: snapshot.endpoint,
      method: snapshot.method,
      status: 200,
      contentType: snapshot.contentType,
      body: snapshot.body,
    };
    fs.writeFileSync(path.join(outDir, snapshot.file), `${JSON.stringify(payload, null, 2)}\n`);
    log(`capture-snapshots: wrote ${path.join(path.relative(ROOT, outDir), snapshot.file)}`);
  }
  return 0;
}

export function main(
  argv: string[] = process.argv.slice(2),
  log: (message: string) => void = console.log,
  error: (message: string) => void = console.error,
): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (problem) {
    error(`capture-snapshots: ${(problem as Error).message}`);
    return 2;
  }
  if (args.out === "help") {
    log("usage: capture-snapshots.ts [--out <dir>] [--ui-dist <dir>]");
    return 0;
  }
  try {
    return writeSnapshots(capture(args.uiDist), args.out, { log, error });
  } catch (problem) {
    error(`capture-snapshots: ${(problem as Error).message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}