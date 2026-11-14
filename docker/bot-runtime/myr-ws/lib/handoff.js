"use strict";

const { spawnSync } = require("node:child_process");
const { parseArgs } = require("node:util");

function runCommand(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    error: res.error,
  };
}

function resolveReviewerAgentId(prNumber) {
  const table = [
    "dbd3f01c-518e-4c1d-a05a-2a4bf25acf93", // 0 -> adm-dev-review-8
    "d674a53a-3abd-43fe-8f49-696a04937323", // 1 -> adm-dev-review-9
    "07555686-c5f7-4536-ac2b-c9ab1027e89f", // 2 -> adm-dev-review-10
    "62640ae6-658b-4cde-ba3a-b6a88e708df9", // 3 -> adm-dev-review-11
    "b7040a16-03a0-4d3c-8060-709038ccc403", // 4 -> adm-dev-review-12
    "c85f5dac-4a13-4bdb-9498-c666fe45d4c9", // 5 -> adm-dev-review-13
  ];
  const mod = Number(prNumber) % 6;
  return table[mod];
}

async function run(args, deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const env = deps.env || process.env;
  const execCmd = deps.runCommand || runCommand;
  const fetchFn = deps.fetch || globalThis.fetch;

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
  const prViewRes = execCmd("gh", ["pr", "view", branch, "--json", "number,url,title"], { cwd, env });
  if (prViewRes.status === 0 && prViewRes.stdout.trim()) {
    try {
      const data = JSON.parse(prViewRes.stdout);
      if (data && data.number) {
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
      const checkView = execCmd("gh", ["pr", "view", branch, "--json", "number"], { cwd, env });
      if (checkView.status === 0) {
        try {
          prNumber = JSON.parse(checkView.stdout).number;
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
    const issueGetRes = await fetchFn(`${paperclipUrl}/api/issues/${issueKeyOrId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${paperclipKey}`,
      },
    });
    if (issueGetRes.ok) {
      issueData = await issueGetRes.json();
    }
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step issue_fetch: ${err.message}\n`,
    };
  }

  if (!issueData || !issueData.id) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `myr-handoff: failed at step issue_fetch: issue ${issueKeyOrId} not found\n`,
    };
  }

  const issueId = issueData.id;
  const reviewerAgentId = resolveReviewerAgentId(prNumber);

  const patchBody = {
    status: "in_review",
    comment: summary,
    executionPolicy: {
      mode: "normal",
      stages: [
        {
          type: "review",
          approvalsNeeded: 1,
          participants: [
            {
              type: "agent",
              agentId: reviewerAgentId,
            },
          ],
        },
      ],
    },
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
      stderr: `myr-handoff: failed at step issue_patch: ${err.message}\n`,
    };
  }

  if (!patchRes.ok) {
    const errText = await patchRes.text();
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
            return url.includes(String(prNumber)) || meta.number === prNumber;
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
  resolveReviewerAgentId,
};
