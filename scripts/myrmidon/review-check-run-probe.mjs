#!/usr/bin/env node
// Probe whether the current token may create check runs (`checks:write`) —
// REVIEW-CHECKS-NATIVE D1.
//
// The propagation service (server/src/services/pull-request-approval-propagation.ts)
// creates a `Board review` check run on the reviewed pull request head. Before
// enabling that path the operator needs a one-shot answer to "does this token
// actually have the right?". This script answers it with a probe run:
//
//   node scripts/myrmidon/review-check-run-probe.mjs --repo owner/name --ref <branch> [--json]
//
// It resolves the branch's head sha, creates a check run named
// "Board review probe" (never the production "Board review" name) already in
// the completed state with conclusion `neutral`, and prints `ok` plus the run
// id. Exit code 0 only on ok. The token never reaches stdout, stderr, or error
// text: token values are never interpolated into messages, and GitHub API
// error bodies are reduced to their `message` field before printing.
//
// Token: GH_TOKEN or GITHUB_TOKEN (ghJson-style env, same as
// review-approve-label.mjs). Responses:
//   403 -> "checks:write is missing — ask the board operator for a task"
//   404 -> "repository or ref not found"
//   401 -> "token rejected"
//   anything else non-ok -> "github api error <status>"

const PROBE_CHECK_NAME = "Board review probe";


export function describeStatus(status) {
  if (status === 401) return "token rejected";
  if (status === 403) return "checks:write is missing — ask the board operator for a task";
  if (status === 404) return "repository or ref not found";
  return `github api error ${status}`;
}

/** Reduces a GitHub error body to its public `message` field, if any. */
export function safeErrorText(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON — fall through
  }
  return "";
}

export async function main(argv, io = {}) {
  const out = io.log ?? console.log;
  const err = io.error ?? console.error;
  const fetchImpl = io.fetchImpl ?? fetch;
  const env = io.env ?? process.env;

  let args;
  try {
    args = { repo: null, ref: null, json: false };
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
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (!args.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) {
    err("--repo owner/name is required");
    return 2;
  }
  if (!args.ref) {
    err("--ref branch is required");
    return 2;
  }
  const token = io.token ?? (env.GH_TOKEN ?? env.GITHUB_TOKEN);
  const bearer = typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
  if (!bearer) {
    err("GH_TOKEN or GITHUB_TOKEN is required");
    return 2;
  }

  const headers = {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  // 1. Resolve the ref to a head sha.
  let sha;
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${args.repo}/commits/${encodeURIComponent(args.ref)}`,
      { headers },
    );
    if (!response.ok) {
      err(describeStatus(response.status));
      return 1;
    }
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      err("github returned a non-JSON commit body");
      return 1;
    }
    sha = data?.sha;
    if (typeof sha !== "string" || sha.length === 0) {
      err("repository or ref not found");
      return 1;
    }
  } catch (e) {
    err(`github request failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // 2. Create the probe check run, already completed and neutral.
  let body;
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${args.repo}/check-runs`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: PROBE_CHECK_NAME,
          head_sha: sha,
          status: "completed",
          conclusion: "neutral",
          output: {
            title: "Board review probe",
            summary:
              "REVIEW-CHECKS-NATIVE D1 probe: verifies the token may create check runs. Safe to delete.",
          },
        }),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      const publicMessage = safeErrorText(text);
      err(describeStatus(response.status) + (publicMessage ? `: ${publicMessage}` : ""));
      return 1;
    }
    try {
      body = JSON.parse(text);
    } catch {
      err("github returned a non-JSON check run body");
      return 1;
    }
  } catch (e) {
    err(`github request failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  if (typeof body?.id !== "number") {
    err("github did not return a check run id");
    return 1;
  }

  if (args.json) {
    out(JSON.stringify({ ok: true, checkRunId: body.id, headSha: sha, name: PROBE_CHECK_NAME }));
  } else {
    out(`ok check_run_id=${body.id} head=${sha} name=${PROBE_CHECK_NAME}`);
  }
  return 0;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  process.exit(await main(process.argv.slice(2)));
}
