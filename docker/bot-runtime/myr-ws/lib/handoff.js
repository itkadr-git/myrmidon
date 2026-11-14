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

  if (!issueKeyOrId || !summary) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "myr-handoff: --issue and --summary are required\n",
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
  const prViewRes = execCmd("gh", ["pr", "view", branch, "--json", "number,url,title,state"], { cwd, env });
  if (prViewRes.status === 0 && prViewRes.stdout.trim()) {
    try {
      const data = JSON.parse(prViewRes.stdout);
      if (data && data.number && data.state === "OPEN") {
        prNumber = data.number;
        if (data.title && !data.title.includes(issueKeyOrId)) {
          execCmd("gh", ["pr", "edit", String(prNumber), "--title", `${issueKeyOrId}: ${data.title}`], { cwd, env });
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
        `${issueKeyOrId}: handoff to review`,
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
    const match = (prCreateRes.stdout + prCreateRes.stderr).match(/\/pull\/(\d+)/);
    if (match) {
      prNumber = Number(match[1]);
    } else {
      const checkView = execCmd("gh", ["pr", "view", branch, "--json", "number,state"], { cwd, env });
      if (checkView.status === 0) {
        try {
          const checked = JSON.parse(checkView.stdout);
          if (checked && checked.state === "OPEN") prNumber = checked.number;
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

  const issueId = issueData.id;

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
      stderr: `myr-handoff: failed at step issue_patch: HTTP ${patchRes.status} ${errText}\n`,
    };
  }

  let boundPr = false;
  try {
    const wpRes = await fetchFn(`${paperclipUrl}/api/issues/${issueId}/work-products`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${paperclipKey}`,
      },
    });
    if (wpRes.ok) {
      const wps = await wpRes.json();
      if (Array.isArray(wps)) {
        boundPr = wps.some((wp) => {
          if (wp.kind === "pull_request") {
            const meta = wp.metadata || {};
            const url = wp.url || meta.url || "";
            return meta.number === prNumber || new RegExp(`/pull/${prNumber}/?$`).test(url);
          }
          return false;
        });
      }
    }
  } catch (_) {}

  return {
    exitCode: 0,
    stdout: `PR #${prNumber} sha ${headSha} status in_review bound ${boundPr ? "yes" : "pending_sync"}\n`,
    stderr: "",
  };
}

module.exports = {
  run,
};
