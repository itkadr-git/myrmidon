"use strict";

const { spawnSync } = require("node:child_process");
const { parseArgs } = require("node:util");

const SPAWN_TIMEOUT_MS = 60000;
const FETCH_TIMEOUT_MS = 15000;

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
  if (typeof wp.title === "string" && wp.title.includes(`#${prNumber}`)) return true;
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
      strict: false,
    });
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: invalid arguments: ${err.message}\n`,
    };
  }

  const issueKeyOrId = parsed.values.issue;
  const summary = parsed.values.summary;
  const reviewer = parsed.values.reviewer;

  if (!issueKeyOrId || !summary) {
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
        body = String(await issueGetRes.text()).slice(0, 300);
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
      stderr: `myr-handoff: failed at step issue_admission: cannot transition closed issue (status: ${issueData.status}) to in_review\n`,
    };
  }
  if (issueData.reviewPolicy === "human_only") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "myr-handoff: failed at step issue_admission: issue reviewPolicy is human_only; agent cannot transition to in_review\n",
    };
  }

  // The board rejects a bare in_review PATCH from an agent when the issue has no review stage.
  const existingPolicy =
    issueData.executionPolicy && typeof issueData.executionPolicy === "object" ? issueData.executionPolicy : null;
  const existingStages = Array.isArray(existingPolicy && existingPolicy.stages) ? existingPolicy.stages : [];
  const hasReviewStage = existingStages.some(
    (st) => st && st.type === "review" && Array.isArray(st.participants) && st.participants.length > 0
  );
  if (!hasReviewStage && !reviewer) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "myr-handoff: issue has no review stage: pass --reviewer <agentId> (see your instructions)\n",
    };
  }

  const branchRes = execCmd("git", ["branch", "--show-current"], { cwd });
  if (branchRes.status !== 0 || !branchRes.stdout.trim()) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step git_branch: ${branchRes.stderr.trim() || "cannot determine current branch"}\n`,
    };
  }
  const branch = branchRes.stdout.trim();

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
        if (data.title && !data.title.includes(issueKey)) {
          const editRes = execCmd("gh", ["pr", "edit", String(prNumber), "--title", `${issueKey}: ${data.title}`], { cwd, env });
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

  const issueId = issueData.id;

  const patchBody = {
    status: "in_review",
    comment: summary,
  };
  if (!hasReviewStage) {
    // Keep other stages and policy fields; replace any empty review stage with ours.
    const otherStages = existingStages.filter((st) => !(st && st.type === "review"));
    patchBody.executionPolicy = {
      ...(existingPolicy || {}),
      mode: (existingPolicy && existingPolicy.mode) || "normal",
      stages: [
        ...otherStages,
        {
          type: "review",
          approvalsNeeded: 1,
          participants: [{ type: "agent", agentId: reviewer }],
        },
      ],
    };
  }

  const patchHeaders = {
    Authorization: `Bearer ${paperclipKey}`,
    "Content-Type": "application/json",
  };
  if (paperclipRunId) {
    patchHeaders["X-Paperclip-Run-Id"] = paperclipRunId;
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
      errText = String(await patchRes.text()).slice(0, 300);
    } catch (_) {}
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step issue_patch: PR #${prNumber} sha ${headSha} (branch ${branch}) exists, but status transition to in_review failed: HTTP ${patchRes.status} ${errText}\n`,
    };
  }

  let boundPr = false;
  let wpRes;
  try {
    wpRes = await fetchFn(`${paperclipUrl}/api/issues/${issueId}/work-products`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${paperclipKey}`,
      },
    });
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step work_product_verify: ${describeFetchError(err)}\n`,
    };
  }

  if (!wpRes.ok) {
    let errText = "";
    try {
      errText = String(await wpRes.text()).slice(0, 300);
    } catch (_) {}
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step work_product_verify: HTTP ${wpRes.status} ${errText}\n`,
    };
  }

  const wps = await wpRes.json().catch(() => []);
  if (Array.isArray(wps)) {
    boundPr = wps.some((wp) => isMatchingPrWorkProduct(wp, prNumber, prUrl));
  }

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
        bindErr = String(await bindRes.text()).slice(0, 300);
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

  return {
    exitCode: 0,
    stdout: `PR #${prNumber} sha ${headSha} status in_review bound yes\n`,
    stderr: "",
  };
}

module.exports = {
  run,
  isMatchingPrWorkProduct,
};
