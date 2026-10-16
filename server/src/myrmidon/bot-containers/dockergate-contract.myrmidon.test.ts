// myrmidon(1.6.4-BOT-CONTAINER-CARD): board <-> dockergate contract for the Docker API.
//
// Every Docker API call the board's driver can make (every `path:` of a request
// in docker-driver.ts) must be a call dockergate's route table allows. The table
// is read from tools/dockergate/contract/allowed-routes.json, which the
// Go route tests keep equal to route.Parse (tools/dockergate/internal/route/
// allowed_table_test.go). The defect this guards against: the driver listed
// containers (`GET /containers/json?...`), dockergate keeps that call on its
// closed list, and so every clone-hygiene sweep answered 403 route_not_allowed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APPLIED_MARKER_CONTAINER_PATH, BOT_STOP_TIMEOUT_SEC } from "./docker-driver.js";
import { CLONE_HYGIENE_REPORT_PATH } from "./clone-hygiene.js";
import { BOT_ROOT_MOUNT, LEGACY_BOT_REAL_ROOT } from "./template.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const driverSource = fs.readFileSync(path.join(here, "docker-driver.ts"), "utf8");
const table = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "tools/dockergate/contract/allowed-routes.json"), "utf8"),
) as { apiPrefix: string; routes: AllowedRoute[] };

interface AllowedRoute {
  id: string;
  method: string;
  template: string;
  suffixes?: string[];
  mounts?: string[];
}

interface DriverCall {
  method: string;
  /** The path expression as written, e.g. `/containers/${nameSegment(name)}/json`. */
  expression: string;
}

const KEY = "0a1b2c3d-1111-2222-3333-444455556666";
const SUFFIXES = ["", ".next", ".helper"];
const IMAGE = "IMAGE_REF";

/** Reads a JS template literal or string starting at `start` (a quote or backtick);
 *  returns its raw body and the index after it. Handles nested `${ ... `...` ... }`. */
function readLiteral(src: string, start: number): { body: string; end: number } {
  const quote = src[start];
  let i = start + 1;
  if (quote !== "`") {
    while (src[i] !== quote) i += 1;
    return { body: src.slice(start + 1, i), end: i + 1 };
  }
  let depth = 0;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (depth === 0 && ch === "`") return { body: src.slice(start + 1, i), end: i + 1 };
    if (ch === "$" && src[i + 1] === "{") {
      depth += 1;
      i += 1;
    } else if (depth > 0 && ch === "{") {
      depth += 1;
    } else if (depth > 0 && ch === "}") {
      depth -= 1;
    } else if (depth > 0 && ch === "`") {
      i = readLiteral(src, i).end - 1;
    }
  }
  throw new Error("unterminated template literal in docker-driver.ts");
}

/** Every request the driver makes: a `method: "X"` followed by `path: <literal>`. */
function driverCalls(source: string): DriverCall[] {
  const calls: DriverCall[] = [];
  const re = /method:\s*"(GET|POST|PUT|DELETE)",\s*path:\s*(?=[`"])/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const { body } = readLiteral(source, m.index + m[0].length);
    calls.push({ method: m[1]!, expression: body });
  }
  return calls;
}

/** The concrete paths (without the API prefix) a call expression can produce. */
function expand(expression: string): string[] {
  const out: string[] = [];
  const pieces = expression.split(/(\$\{(?:[^{}`]|`(?:[^`$]|\$\{[^}]*\})*`)*\})/g).filter((p) => p !== "");
  const choices: string[][] = pieces.map((piece) => {
    if (!piece.startsWith("${")) return [piece];
    const expr = piece.slice(2, -1).trim();
    if (/^nameSegment\((name|containerName|replacement)\)$/.test(expr)) return SUFFIXES.map((s) => `myrmidon-bot-${KEY}${s}`);
    if (/^nameSegment\(image\)$/.test(expr)) return [IMAGE];
    if (expr === "encodeURIComponent(name)") return SUFFIXES.map((s) => `myrmidon-bot-${KEY}${s}`);
    if (expr === "encodeURIComponent(mountPath)") return table.routes.flatMap((r) => r.mounts ?? []);
    if (expr === "encodeURIComponent(APPLIED_MARKER_CONTAINER_PATH)") return [encodeURIComponent(APPLIED_MARKER_CONTAINER_PATH)];
    if (expr === "encodeURIComponent(`${root}/hermes/${CLONE_HYGIENE_REPORT_PATH}`)") {
      return [`/bot-scope/${KEY}`, BOT_ROOT_MOUNT, LEGACY_BOT_REAL_ROOT].map((root) => encodeURIComponent(`${root}/hermes/${CLONE_HYGIENE_REPORT_PATH}`));
    }
    if (expr === "encodeURIComponent(markerPath)") {
      // The marker of an isolated bot (/bot), of a shared scope member
      // (/bot-scope/<botKey>) and of a LEGACY-layout bot (/data, contract "1").
      return [`/bot-scope/${KEY}`, BOT_ROOT_MOUNT, LEGACY_BOT_REAL_ROOT].map((root) => encodeURIComponent(`${root}/hermes/.myrmidon/applied.json`));
    }
    if (expr === "encodeURIComponent(`${root}/hermes/skills`)") {
      // myrmidon(1.6.5-BOT-SKILL-BACKIMPORT, OPE-6401): the bot's own skills
      // directory, in the same three root shapes as the marker above.
      return [`/bot-scope/${KEY}`, BOT_ROOT_MOUNT, LEGACY_BOT_REAL_ROOT].map((root) => encodeURIComponent(`${root}/hermes/skills`));
    }
    if (expr === "BOT_STOP_TIMEOUT_SEC") return [String(BOT_STOP_TIMEOUT_SEC)];
    if (expr === "filters") return ["%7B%22label%22%3A%5B%22myrmidon.bot%22%5D%7D"];
    throw new Error(
      `docker-driver.ts builds a Docker path with an expression this contract test does not know: \${${expr}}. ` +
        "Teach dockergate-contract.myrmidon.test.ts how to expand it and check the call against the route table.",
    );
  });
  const walk = (index: number, acc: string): void => {
    if (index === choices.length) {
      out.push(acc);
      return;
    }
    for (const choice of choices[index]!) walk(index + 1, acc + choice);
  };
  walk(0, "");
  return out;
}

/** The paths one allowed-table row produces, with the same placeholders as expand(). */
function allowedPaths(route: AllowedRoute): string[] {
  const suffixes = route.suffixes ?? [""];
  const mounts = route.mounts ?? [""];
  const paths: string[] = [];
  for (const suffix of suffixes) {
    for (const mount of mounts) {
      paths.push(
        route.template
          .replaceAll("{name}", `myrmidon-bot-${KEY}${suffix}`)
          .replaceAll("{mainName}", `myrmidon-bot-${KEY}`)
          .replaceAll("{mount}", mount)
          .replaceAll("{image}", IMAGE),
      );
    }
  }
  return paths;
}

/** The allowed routes that accept this request, by id. */
function allowedBy(method: string, candidate: string): string[] {
  const hits: string[] = [];
  for (const route of table.routes) {
    if (route.method !== method) continue;
    if (allowedPaths(route).includes(candidate.replace(/^\//, ""))) hits.push(route.id);
  }
  return hits;
}

/** A call is allowed when at least one of the paths it can produce is. */
function callAllowedBy(call: DriverCall): string[] {
  return expand(call.expression).flatMap((candidate) => allowedBy(call.method, candidate));
}

describe("board driver <-> dockergate route table", () => {
  const calls = driverCalls(driverSource);

  it("finds every Docker call site of the driver", () => {
    // Each request(...) with a path literal is found; a call built another way
    // (a variable path) would not be, so count the literal `path:` forms too.
    const literalPaths = driverSource.match(/\bpath:\s*[`"]\/(?:containers|images)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(10);
    expect(calls.length).toBe(literalPaths.length);
  });

  it("every Docker call the driver can make is allowed by dockergate", () => {
    const refused = calls.filter((call) => callAllowedBy(call).length === 0).map((c) => `${c.method} ${c.expression}`);
    expect(refused).toEqual([]);
  });

  it("the driver never lists containers (containers/json is on dockergate's closed list)", () => {
    expect(calls.filter((c) => /^\/containers\/json/.test(c.expression))).toEqual([]);
  });

  it("covers every route of the table the driver uses", () => {
    const used = new Set(calls.flatMap((c) => callAllowedBy(c)));
    // A1 image labels, A2 inspect, A3 marker, A13 report, A4 create, A5 upload, A6 start,
    // A7 wait, A8 logs, A9 delete, A10 stop, A11 restart, A12 rename, A16 skills read.
    expect([...used].sort()).toEqual(
      ["A1", "A10", "A11", "A12", "A13", "A16", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"].sort(),
    );
  });

  it("the matcher refuses the old container listing", () => {
    const old: DriverCall = { method: "GET", expression: "/containers/json?all=true&filters=${filters}" };
    expect(callAllowedBy(old)).toEqual([]);
    const sources = driverSource.replace(
      /(async function status\()/,
      'const oldCall = { method: "GET", path: `/containers/json?all=true&filters=${filters}` };\n$1',
    );
    const injected = driverCalls(sources);
    expect(injected.some((call) => callAllowedBy(call).length === 0)).toBe(true);
  });

  it("the table carries the API prefix the driver sends", () => {
    expect(table.apiPrefix).toBe(`/${/const DOCKER_API_VERSION = "([^"]+)"/.exec(driverSource)![1]}`);
  });
});
