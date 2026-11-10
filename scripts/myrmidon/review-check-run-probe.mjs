#!/usr/bin/env node
// REVIEW-CHECKS-NATIVE D1 (OPE-12184): probe whether the current GitHub token
// may create check runs (`checks:write`) on a repository, before anything
// depends on it.
//
// The board's formal review writes a "Board review" check run on the PR head
// (server/src/services/pull-request-approval-propagation.ts). That call needs
// the App installation / token to hold `checks:write`; without it GitHub
// answers 403 and the board only degrades to a warn. This probe answers the
// question up front, from a human or operator terminal:
//
//   node scripts/myrmidon/review-check-run-probe.mjs --repo itkadr-git/myrmidon --ref <branch-or-sha> [--json]
//
// It reads GH_TOKEN / GITHUB_TOKEN, resolves the branch head commit, and
// creates ONE check run named "Board review probe" (never the production
// "Board review" name) immediately `completed` with conclusion `neutral`, so
// no lane and no merge gate can read it as a verdict.
//
// Outcomes (exit 0 only on ok):
//   ok                       -> prints ok, the check run id and the head sha
//   403                      -> "нет права checks:write — нужна задача оператору доски"
//   404                      -> "репозиторий или ветка не найдены"
//   401                      -> "токен не принят"
//   missing token / usage    -> usage error, exit 2
//
// The token is never printed: not to stdout, not to stderr, not inside error
// text (fetch errors are reduced to the HTTP status).

import { fileURLToPath } from "node:url";

export const PROBE_CHECK_NAME = "Board review probe";
export const API_BASE = "https://api.github.com";

/** The error the probe reports, keyed by what actually happened. */
export class ProbeError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "ProbeError";
    this.kind = kind; // "forbidden" | "not-found" | "unauthorized" | "http" | "network"
    this.status = null;
  }
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "myrmidon-review-check-run-probe",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Map a failed response to a ProbeError; the token never enters the text. */
export async function toProbeError(response) {
  const status = response.status;
  if (status === 403) {
    return new ProbeError("forbidden", "нет права checks:write — нужна задача оператору доски");
  }
  if (status === 404) {
    return new ProbeError("not-found", "репозиторий или ветка не найдены");
  }
  if (status === 401) {
    return new ProbeError("unauthorized", "токен не принят");
  }
  return new ProbeError("http", `GitHub API вернул HTTP ${status}`);
}

/** GET the head commit sha of a branch or an explicit commit sha. */
export async function fetchRefHead(repo, ref, token, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
      headers: ghHeaders(token),
    });
  } catch (err) {
    throw new ProbeError("network", `GitHub недоступен: ${err instanceof Error ? err.message : "network failure"}`);
  }
  if (!response.ok) throw await toProbeError(response);
  const data = await response.json();
  const sha = data?.sha;
  if (typeof sha !== "string" || sha === "") {
    throw new ProbeError("http", "GitHub не вернул sha головы ref");
  }
  return sha;
}

/**
 * POST one completed neutral check run "Board review probe" on `headSha`.
 * Returns the created check run id. `completed` + `neutral` is deliberate:
 * an in_progress run would linger on the commit, and any other conclusion
 * could be read as a verdict by a merge or review gate.
 */
export async function createProbeCheckRun(repo, headSha, token, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/repos/${repo}/check-runs`, {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: PROBE_CHECK_NAME,
        head_sha: headSha,
        status: "completed",
        conclusion: "neutral",
        output: {
          title: "Board review probe: checks:write ok",
          summary:
            "Одноразовая проба права checks:write (REVIEW-CHECKS-NATIVE D1, OPE-12184). Не является вердиктом ревью.",
        },
      }),
    });
  } catch (err) {
    throw new ProbeError("network", `GitHub недоступен: ${err instanceof Error ? err.message : "network failure"}`);
  }
  if (!response.ok) throw await toProbeError(response);
  const data = await response.json();
  return data?.id ?? null;
}

export function resolveToken(env = process.env) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  return typeof token === "string" && token.trim() !== "" ? token : null;
}

export function parseArgs(argv) {
  const args = { repo: null, ref: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const need = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${a} requires a value`);
      return value;
    };
    if (a === "--repo") args.repo = need();
    else if (a === "--ref") args.ref = need();
    else if (a === "--json") args.json = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) {
    throw new Error("--repo owner/name is required");
  }
  if (!args.ref || args.ref.trim() === "") throw new Error("--ref branch-or-sha is required");
  return args;
}

/**
 * Run the probe end to end. Returns `{ ok, ... }`; throws ProbeError on any
 * GitHub refusal. Injectable `fetchImpl` and `env` keep `node --test` hermetic.
 */
export async function runProbe({ repo, ref, fetchImpl = fetch, env = process.env } = {}) {
  const token = resolveToken(env);
  if (!token) {
    const err = new ProbeError("usage", "GH_TOKEN или GITHUB_TOKEN не заданы");
    err.kind = "usage";
    throw err;
  }
  const headSha = await fetchRefHead(repo, ref, token, fetchImpl);
  const checkRunId = await createProbeCheckRun(repo, headSha, token, fetchImpl);
  return { ok: true, checkRunId, headSha, checkName: PROBE_CHECK_NAME };
}

export async function main(argv, io = {}) {
  const out = io.log ?? console.log;
  const err = io.error ?? console.error;
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }
  try {
    const result = await runProbe({
      repo: args.repo,
      ref: args.ref,
      fetchImpl: io.fetchImpl,
      env: io.env ?? process.env,
    });
    if (args.json) out(JSON.stringify(result));
    else out(`ok: check run "${result.checkName}" id=${result.checkRunId} on head ${result.headSha}`);
    return 0;
  } catch (e) {
    const kind = e instanceof ProbeError ? e.kind : "http";
    const message = e instanceof Error ? e.message : String(e);
    // Usage problems answer with the message; GitHub refusals answer with the
    // mapped Russian text. Either way the token never appears in the output.
    err(message);
    return kind === "usage" ? 2 : 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main(process.argv.slice(2)));
}
