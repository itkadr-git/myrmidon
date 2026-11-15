"use strict";

const { spawnSync } = require("node:child_process");
const { parseArgs } = require("node:util");

const SPAWN_TIMEOUT_MS = 60000;
const FETCH_TIMEOUT_MS = 15000;
const BODY_LIMIT = 1000;

function runCommand(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: SPAWN_TIMEOUT_MS,
    ...options,
  });
  let stderr = res.stderr || "";
  if (res.error) {
    const reason = res.error.code === "ETIMEDOUT"
      ? `${cmd} timed out after ${SPAWN_TIMEOUT_MS} ms`
      : `${cmd}: ${res.error.message}`;
    stderr = stderr ? `${stderr.trim()}\n${reason}` : reason;
  }
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout || "",
    stderr,
    error: res.error,
  };
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describeFetchError(err) {
  if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `request timed out after ${FETCH_TIMEOUT_MS} ms`;
  }
  return `network error: ${err && err.message ? err.message : String(err)}`;
}

function isMatchingPrWorkProduct(wp, prNumber, prUrl) {
  if (!wp) return false;
  const isPr = wp.kind === "pull_request" || wp.type === "pull_request";
  if (!isPr) return false;
  const meta = wp.metadata || {};
  const url = wp.url || meta.url || "";
  if (meta.number === prNumber || meta.number === String(prNumber)) return true;
  if (prUrl && url === prUrl) return true;
  if (new RegExp(`/pull/${prNumber}/?$`).test(url)) return true;
  if (wp.externalId !== undefined && wp.externalId !== null && String(wp.externalId) === String(prNumber)) return true;
  if (typeof wp.title === "string" && new RegExp(`(^|[^\\w])#${prNumber}(?!\\d)`).test(wp.title)) return true;
  return false;
}

async function run(args, deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const env = deps.env || process.env;
  const execCmd = deps.runCommand || runCommand;
  const rawFetch = deps.fetch || globalThis.fetch;
  const fetchFn = (url, opts = {}) =>
    rawFetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        issue: { type: "string" },
        summary: { type: "string" },
        reviewer: { type: "string" },
      },
      strict: true,
    });
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: invalid arguments: ${err.message} (usage: myr-handoff --issue <key|id> --summary <text>)\n`,
    };
  }

  const issueKeyOrId = parsed.values.issue;
  const summary = parsed.values.summary;
  const reviewer = parsed.values.reviewer;

  if (reviewer !== undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "myr-handoff: --reviewer is not supported; use the issue's configured review workflow\n",
    };
  }

  if (
    typeof issueKeyOrId !== "string" || !issueKeyOrId.trim() ||
    typeof summary !== "string" || !summary.trim()
  ) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "myr-handoff: --issue and --summary are required\n",
    };
  }

  const paperclipUrl = env.PAPERCLIP_API_URL || "http://paperclip-server-1:3100";
  const paperclipKey = env.PAPERCLIP_API_KEY;
  const paperclipRunId = env.PAPERCLIP_RUN_ID;

  if (!paperclipKey) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "myr-handoff: failed at step paperclip_auth: PAPERCLIP_API_KEY is not set\n",
    };
  }

  // GET /api/issues/{id}/work-products returns a plain JSON array (server/src/routes/issues.ts).
  // Anything else is an error, never "not bound" (that would lead to a duplicate POST).
  async function listWorkProducts(id) {
    let res;
    try {
      res = await fetchFn(`${paperclipUrl}/api/issues/${id}/work-products`, {
        method: "GET",
        headers: { Authorization: `Bearer ${paperclipKey}` },
      });
    } catch (err) {
      return { error: describeFetchError(err) };
    }
    if (!res.ok) {
      let errText = "";
      try {
        errText = String(await res.text()).slice(0, BODY_LIMIT);
      } catch (_) {}
      return { error: `HTTP ${res.status} ${errText}` };
    }
    let body;
    try {
      body = await res.json();
    } catch (err) {
      return { error: `response is not valid JSON (${err.message})` };
    }
    if (!Array.isArray(body)) {
      return { error: "unexpected response shape: expected a JSON array of work products" };
    }
    return { wps: body };
  }

  // Pre-flight check: fetch issue before push/PR creation to avoid partial handoff on early rejection
  let issueData = null;
  try {
    const issueGetRes = await fetchFn(`${paperclipUrl}/api/issues/${encodeURIComponent(issueKeyOrId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${paperclipKey}`,
      },
    });
    if (!issueGetRes.ok) {
      let body = "";
      try {
        body = String(await issueGetRes.text()).slice(0, BODY_LIMIT);
      } catch (_) {}
      return {
        exitCode: 1,
        stdout: "",
        stderr: `myr-handoff: failed at step issue_get: HTTP ${issueGetRes.status} ${body}\n`,
      };
    }
    issueData = await issueGetRes.json();
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step issue_get: ${describeFetchError(err)}\n`,
    };
  }

  if (!issueData || !issueData.id) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step issue_get: response for ${issueKeyOrId} has no id\n`,
    };
  }

  // Canonical key for PR titles even when --issue was given as a UUID.
  const issueKey =
    typeof issueData.identifier === "string" && issueData.identifier.trim()
      ? issueData.identifier.trim()
      : issueKeyOrId;

  // Early admission check
  if (issueData.status === "done" || issueData.status === "cancelled") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step issue_admission: cannot transition closed issue (status: ${issueData.status}) to in_review. Nothing was pushed and the issue is unchanged; reopen the issue on the board or hand off the right one, then rerun (a rerun is safe)\n`,
    };
  }
  if (issueData.reviewPolicy === "human_only") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "myr-handoff: failed at step issue_admission: issue reviewPolicy is human_only; agent cannot transition to in_review. Nothing was pushed and the issue is unchanged; ask the owner or reviewer to take it from here\n",
    };
  }

  // Review stages are the board's business: since OPE-13099 the board adds the configured review stage when an
  // engineer hands off an issue without one. The CLI never reads, creates or replaces executionPolicy; any
  // admission/setup refusal comes back from the PATCH below and is shown verbatim.

  const issueId = issueData.id;

  const branchRes = execCmd("git", ["branch", "--show-current"], { cwd });
  if (branchRes.status !== 0 || !branchRes.stdout.trim()) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step git_branch: ${branchRes.stderr.trim() || "cannot determine current branch"}\n`,
    };
  }
  const branch = branchRes.stdout.trim();
  if (!branch.startsWith("bot/")) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step git_branch: refusing to hand off from branch ${branch}: only bot/* branches are accepted (main, master and rel/* are rejected); run it from the working copy on your bot/OPE-* branch\n`,
    };
  }

  // Idempotent rerun: already in review with the PR bound -> nothing to do (no push, no PATCH, no second comment).
  // Only read-only calls here: gh pr view and GET work-products.
  if (issueData.status === "in_review") {
    const viewRes = execCmd("gh", ["pr", "view", branch, "--json", "number,url,state"], { cwd, env });
    if (viewRes.status === 0 && viewRes.stdout.trim()) {
      let view = null;
      try {
        view = JSON.parse(viewRes.stdout);
      } catch (_) {}
      if (view && view.number && view.state === "OPEN") {
        const list = await listWorkProducts(issueId);
        if (list.error) {
          return { exitCode: 1, stdout: "", stderr: `myr-handoff: failed at step work_product_verify: ${list.error}\n` };
        }
        if (list.wps.some((wp) => isMatchingPrWorkProduct(wp, view.number, view.url || null))) {
          return {
            exitCode: 0,
            stdout: `PR #${view.number} already in review (issue ${issueKey} is in_review, PR is bound); nothing to do\n`,
            stderr: "",
          };
        }
      }
    }
  }

  const headRes = execCmd("git", ["rev-parse", "HEAD"], { cwd });
  if (headRes.status !== 0 || !headRes.stdout.trim()) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step git_head: ${headRes.stderr.trim() || "cannot determine HEAD SHA"}\n`,
    };
  }
  const headSha = headRes.stdout.trim();

  const pushRes = execCmd("git", ["push", "-u", "origin", branch], { cwd });
  if (pushRes.status !== 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step git_push: ${pushRes.stderr.trim() || pushRes.stdout.trim()}\n`,
    };
  }

  let prNumber = null;
  let prUrl = null;
  const prViewRes = execCmd("gh", ["pr", "view", branch, "--json", "number,url,title,state"], { cwd, env });
  if (prViewRes.status === 0 && prViewRes.stdout.trim()) {
    try {
      const data = JSON.parse(prViewRes.stdout);
      if (data && data.number && data.state === "OPEN") {
        prNumber = data.number;
        prUrl = data.url || null;
        const ownPrefix = new RegExp(`^${escapeRegExp(issueKey)}(?![0-9A-Za-z-])`);
        if (data.title && !ownPrefix.test(data.title)) {
          // Replace a leading foreign key, the raw --issue value or a UUID; keep the rest of the title.
          const cleanTitle = data.title
            .replace(new RegExp(`^${escapeRegExp(issueKeyOrId)}:?\\s*`, "i"), "")
            .replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:?\s*/i, "")
            .replace(/^[A-Z][A-Z0-9]*-\d+(?![0-9A-Za-z-]):?\s*/, "")
            .trim();
          const newTitle = cleanTitle ? `${issueKey}: ${cleanTitle}` : `${issueKey}: handoff to review`;
          const editRes = execCmd("gh", ["pr", "edit", String(prNumber), "--title", newTitle], { cwd, env });
          if (editRes.status !== 0) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: `myr-handoff: failed at step gh_pr_edit: ${editRes.stderr.trim() || editRes.stdout.trim() || "failed to update PR title"}\n`,
            };
          }
        }
      }
    } catch (_) {}
  }

  if (!prNumber) {
    const prCreateRes = execCmd(
      "gh",
      [
        "pr",
        "create",
        "--head",
        branch,
        "--title",
        `${issueKey}: handoff to review`,
        "--body",
        summary,
      ],
      { cwd, env }
    );
    if (prCreateRes.status !== 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `myr-handoff: failed at step gh_pr_create: ${prCreateRes.stderr.trim() || prCreateRes.stdout.trim()}\n`,
      };
    }
    const fullOut = prCreateRes.stdout + prCreateRes.stderr;
    const match = fullOut.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/) || fullOut.match(/\/pull\/(\d+)/);
    if (match) {
      prNumber = Number(match[1]);
      if (match[0].startsWith("http")) {
        prUrl = match[0].trim();
      }
    } else {
      const checkView = execCmd("gh", ["pr", "view", branch, "--json", "number,url,state"], { cwd, env });
      if (checkView.status === 0) {
        try {
          const checked = JSON.parse(checkView.stdout);
          if (checked && checked.state === "OPEN") {
            prNumber = checked.number;
            prUrl = checked.url || null;
          }
        } catch (_) {}
      }
    }
  }

  if (!prNumber) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "myr-handoff: failed at step gh_pr_detect: could not determine PR number\n",
    };
  }

  if (!prUrl) {
    prUrl = `https://github.com/itkadr-git/myrmidon/pull/${prNumber}`;
  }

  const patchBody = {
    status: "in_review",
    comment: summary,
  };

  const patchHeaders = {
    Authorization: `Bearer ${paperclipKey}`,
    "Content-Type": "application/json",
  };
  if (paperclipRunId) {
    patchHeaders["X-Paperclip-Run-Id"] = paperclipRunId;
  }

  let boundPr = false;
  const wpList = await listWorkProducts(issueId);
  if (wpList.error) {
    return { exitCode: 1, stdout: "", stderr: `myr-handoff: failed at step work_product_verify: ${wpList.error}\n` };
  }
  boundPr = wpList.wps.some((wp) => isMatchingPrWorkProduct(wp, prNumber, prUrl));

  if (!boundPr) {
    // Attempt explicit binding if webhook hasn't created the work product yet
    const bindPayload = {
      type: "pull_request",
      provider: "github",
      title: `PR #${prNumber}`,
      url: prUrl,
      metadata: {
        number: prNumber,
        headSha,
        branch,
      },
    };
    let bindRes;
    try {
      bindRes = await fetchFn(`${paperclipUrl}/api/issues/${issueId}/work-products`, {
        method: "POST",
        headers: patchHeaders,
        body: JSON.stringify(bindPayload),
      });
    } catch (err) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `myr-handoff: failed at step work_product_binding: ${describeFetchError(err)}\n`,
      };
    }
    if (!bindRes.ok) {
      let bindErr = "";
      try {
        bindErr = String(await bindRes.text()).slice(0, BODY_LIMIT);
      } catch (_) {}
      return {
        exitCode: 1,
        stdout: "",
        stderr: `myr-handoff: failed at step work_product_binding: PR #${prNumber} is not bound and explicit binding failed: HTTP ${bindRes.status} ${bindErr}\n`,
      };
    }
    boundPr = true;
  }

  if (!boundPr) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step work_product_binding: PR #${prNumber} is not bound to issue ${issueKey}\n`,
    };
  }

  let patchRes;
  try {
    patchRes = await fetchFn(`${paperclipUrl}/api/issues/${issueId}`, {
      method: "PATCH",
      headers: patchHeaders,
      body: JSON.stringify(patchBody),
    });
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step issue_patch: ${describeFetchError(err)}\n`,
    };
  }

  if (!patchRes.ok) {
    let errText = "";
    try {
      errText = String(await patchRes.text()).slice(0, BODY_LIMIT);
    } catch (_) {}
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step issue_patch: PR #${prNumber} sha ${headSha} (branch ${branch}) exists, but status transition to in_review failed: HTTP ${patchRes.status} ${errText}\nThe issue status was not changed. Fix the cause named above (for admission errors: review stage, CI, issue state) and rerun the same command: a rerun is safe, the PR is reused and not duplicated.\n`,
    };
  }

  // Show what the board answered, not what we asked for.
  let boardStatus = "in_review";
  try {
    const patched = await patchRes.json();
    if (patched && typeof patched.status === "string" && patched.status) boardStatus = patched.status;
  } catch (_) {}
  if (boardStatus !== "in_review") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step issue_patch: PR #${prNumber} sha ${headSha} (branch ${branch}) exists, but the board answered status ${boardStatus} instead of in_review\n`,
    };
  }

  return {
    exitCode: 0,
    stdout: `PR #${prNumber} sha ${headSha} status ${boardStatus} bound yes\n`,
    stderr: "",
  };
}

module.exports = {
  run,
  isMatchingPrWorkProduct,
};
