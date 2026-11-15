#!/usr/bin/env node
// FETCH-RELEASE-VERDICT (OPE-13017): obtain the SIGNED release-verification
// verdict from the production board so the publish gate
// (scripts/myrmidon/release/publish-github-release.sh) can bind the GitHub
// Release to the immutable verified candidate.
//
// The board route POST /issues/:id/release-verify (OPE-13014) aggregates the
// release candidate set, checks every member against the deployed build
// commit, persists a system comment, and — when MYRMIDON_RELEASE_VERIFICATION_KEY
// is configured on the board — signs the verdict
// (HMAC-SHA256 over verdict|deployedVersion|checkedAt|issueId, field `signature`).
// The publish script refuses any verdict without a valid signature, so this
// CLI is the only supported way to produce the verification file inside CI:
//
//   node scripts/myrmidon/release/fetch-release-verdict.mjs \
//     --version 1.8.0 --out verification.json
//
// The release issue is located by the release label "X.Y" (derived from
// --version unless --board-label / --issue is given), then the route is
// invoked against that issue. The full signed JSON response is written to
// --out (or stdout when --out is omitted) and is consumed verbatim by the
// publisher (MYRMIDON_RELEASE_VERIFICATION_RESULT / --verification-result).
//
// Board API: PAPERCLIP_API_URL (default http://127.0.0.1:3100),
// PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID (default: this company).
//
// Exit codes: 0 = verdict written, 1 = lookup/transport/verdict failure,
// 2 = usage error. Tests: fetch-release-verdict.test.mjs (fake boardFetch).

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { boardFromEnv, listReleaseIssues } from "./cut-rc.mjs";

function usage() {
  console.error(`usage:
  node scripts/myrmidon/release/fetch-release-verdict.mjs --version X.Y.Z [options]

required:
  --version X.Y.Z        release version (label "X.Y" is derived from it)

options:
  --board-label NAME     release label name (default: "<major>.<minor>" of --version)
  --issue ID             board issue UUID — skip the label lookup and verify this issue
  --out FILE             write the signed verdict JSON here (default: stdout)
  --api-url URL          board API URL (default: PAPERCLIP_API_URL or http://127.0.0.1:3100)
  --api-key KEY          board API key (default: PAPERCLIP_API_KEY)
  --company-id ID        board company ID (default: PAPERCLIP_COMPANY_ID)
  -h | --help`);
}

export function parseArgs(argv) {
  const args = {
    version: null, boardLabel: null, issue: null, out: null,
    apiUrl: null, apiKey: null, companyId: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "--version": args.version = argv[++i]; break;
      case "--board-label": args.boardLabel = argv[++i]; break;
      case "--issue": args.issue = argv[++i]; break;
      case "--out": args.out = argv[++i]; break;
      case "--api-url": args.apiUrl = argv[++i]; break;
      case "--api-key": args.apiKey = argv[++i]; break;
      case "--company-id": args.companyId = argv[++i]; break;
      case "-h": case "--help": args.help = true; break;
      default: throw new UsageError(`unknown argument: ${a}`);
    }
  }
  return args;
}

export class UsageError extends Error {}

export function validateArgs(args) {
  if (!args.version || !/^\d+\.\d+\.\d+$/.test(args.version)) {
    throw new UsageError("--version X.Y.Z is required");
  }
}

// "1.8.0" -> "1.8"; mirrors normaliseReleasePrefix on the board side.
export function labelFromVersion(version) {
  return version.split(".").slice(0, 2).join(".");
}

async function boardFetch(api, pathname, init) {
  let res;
  try {
    res = await fetch(`${api.apiUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${api.apiKey}`,
        "Content-Type": "application/json",
        ...(init && init.headers ? init.headers : {}),
      },
    });
  } catch (err) {
    throw new Error(`board API ${pathname} unreachable: ${err.message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`board API ${pathname} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function postReleaseVerify(api, issueId, fetchBoard) {
  return fetchBoard(api, `/api/issues/${encodeURIComponent(issueId)}/release-verify`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function run(args, deps = {}, fetchBoard = boardFetch) {
  const log = deps.log || ((m) => console.error(m));
  const env = deps.env || process.env;

  const api = boardFromEnv(env);
  if (args.apiUrl) api.apiUrl = args.apiUrl.replace(/\/+$/, "");
  if (args.apiKey) api.apiKey = args.apiKey;
  if (args.companyId) api.companyId = args.companyId;
  if (!api.apiKey) {
    log("FETCH-VERDICT REFUSED: PAPERCLIP_API_KEY is not set (or pass --api-key)");
    return 1;
  }

  let issueId = args.issue;
  if (!issueId) {
    const label = args.boardLabel || labelFromVersion(args.version);
    let issues;
    try {
      issues = await listReleaseIssues(api, label, log, fetchBoard);
    } catch (e) {
      log(`FETCH-VERDICT REFUSED: ${e.message}`);
      return 1;
    }
    if (issues.length === 0) {
      log(`FETCH-VERDICT REFUSED: no issue carries the release label "${label}"`);
      return 1;
    }
    if (issues.length > 1) {
      log(`FETCH-VERDICT REFUSED: release label "${label}" is on ${issues.length} issues (${issues.map((i) => i.identifier).join(", ")}) — pass --issue to disambiguate`);
      return 1;
    }
    issueId = issues[0].id;
    log(`fetch-verdict: release label "${label}" -> ${issues[0].identifier} (${issueId})`);
  }

  let verdict;
  try {
    verdict = await postReleaseVerify(api, issueId, fetchBoard);
  } catch (e) {
    log(`FETCH-VERDICT REFUSED: ${e.message}`);
    return 1;
  }
  if (!verdict || typeof verdict !== "object" || !verdict.verdict) {
    log("FETCH-VERDICT REFUSED: the release-verify route returned no verdict JSON");
    return 1;
  }
  log(`fetch-verdict: verdict=${verdict.verdict} deployedVersion=${verdict.deployedVersion ?? "n/a"} checkedAt=${verdict.checkedAt ?? "n/a"} signature=${verdict.signature ? "present" : "ABSENT"}`);

  const payload = `${JSON.stringify(verdict, null, 2)}\n`;
  if (args.out) {
    fs.writeFileSync(args.out, payload);
    log(`fetch-verdict: wrote ${args.out}`);
  } else {
    process.stdout.write(payload);
  }
  return 0;
}

export function mainSync(argv, deps = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    usage();
    return 2;
  }
  if (args.help) {
    usage();
    return 0;
  }
  try {
    validateArgs(args);
  } catch (e) {
    console.error(String(e.message || e));
    usage();
    return 2;
  }
  return run(args, deps);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await mainSync(process.argv.slice(2)));
}
