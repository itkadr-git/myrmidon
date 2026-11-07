#!/usr/bin/env node
// DOCS-WRITER-RULES (OPE-12243, slice A2 of epic OPE-12135): one non-blocking
// PR comment when a pull request changes the API/schema/generated capability
// surface without touching docs or the runtime skill references.
//
//   GITHUB_TOKEN=… PR_NUMBER=… BASE_SHA=… HEAD_SHA=… \
//     node scripts/myrmidon/ci/docs-reminder.mjs
//
// Trigger: the merge-base diff (base...head) contains at least one file under
//   - packages/paperclip-runner/generated/capability/**
//   - server/**  with "schema" in the basename of a .ts file (covers the
//     spec's server/**/schema*.ts as well as the schema files that exist in
//     this repo: server/src/routes/*-schemas.ts,
//     server/src/services/*schema*.ts)
//   - server/src/myrmidon/**  with "schema" in the basename (any extension)
//   - .agents/schemas/**
// and no file at all under docs/myrmidon/changes/** or skills/myrmidon/references/**.
// Then exactly ONE comment with the marker below is posted (re-runs on new
// pushes find the marker and skip), asking the author to check whether the
// fragment docs/myrmidon/changes/<slug>.md and the skill reference need the
// same change. The reminder NEVER fails CI: it exits 0 on every verdict; a
// missing token or missing PR data is a silent 0 (fork PRs), and only
// infrastructure failures outside the reminder's control (git errors) throw.
//
// Node built-ins only. The reminder complements (does not duplicate) the
// release-time blocking check scripts/myrmidon/release/collect-fragments.mjs
// and the registry-documents gate scripts/myrmidon/ci/change-fragments-gate.mjs
// — it only reads the same fragment directory and never edits documents.

import { execFileSync } from "node:child_process";

const MARKER = "<!-- docs-reminder -->";

// Trigger groups (aligned with the change-fragments flow of
// collect-fragments.mjs; the task asks to verify the list against the actual
// repository layout — see the header note on server/src/myrmidon).
const TRIGGER_PREFIXES = [
  "packages/paperclip-runner/generated/capability/",
  ".agents/schemas/",
];

const TRIGGER_PATTERNS = [
  // any .ts schema file under server/ at any depth — spec wording is
  // server/**/schema*.ts; this repo's schema files are named *-schemas.ts /
  // *schema*.ts, so match "schema" anywhere in the basename (same .ts scope).
  (f) => f.startsWith("server/") && f.endsWith(".ts") && /(^|\/)[^/]*schema[^/]*$/.test(f),
  // any file with "schema" in its basename under server/src/myrmidon/**
  (f) => f.startsWith("server/src/myrmidon/") && /(^|\/)[^/]*schema[^/]*$/.test(f),
];

// Docs paths whose presence in the same diff suppresses the reminder.
const DOCS_PREFIXES = ["docs/myrmidon/changes/", "skills/myrmidon/references/"];

const isTrigger = (f) =>
  TRIGGER_PREFIXES.some((p) => f.startsWith(p)) || TRIGGER_PATTERNS.some((m) => m(f));

const isDocs = (f) => DOCS_PREFIXES.some((p) => f.startsWith(p));

/** merge-base diff (base...head) changed-file list, one path per line. */
export function changedFiles(root, base, head) {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.split("\n").filter(Boolean);
}

/** The verdict for one change set: { triggerFiles[], docsFiles[], remind }. */
export function judge(files) {
  const triggerFiles = files.filter(isTrigger);
  const docsFiles = files.filter(isDocs);
  // Reminder only when the API/schema/capability surface changed AND the
  // author shipped no change fragment and no skill-reference update at all.
  const remind = triggerFiles.length > 0 && docsFiles.length === 0;
  return { triggerFiles, docsFiles, remind };
}

export function commentBody({ triggerFiles }) {
  const shown = triggerFiles.slice(0, 10);
  const lines = [
    MARKER,
    "This PR changes the API/schema/generated capability surface, but the diff",
    "has no file under `docs/myrmidon/changes/` and none under",
    "`skills/myrmidon/references/`. Please check whether both need the same",
    "change (agents read the docs and the skill; ignore this comment if not).",
    "",
    "Changed surface files:",
  ];
  for (const f of shown) lines.push(`- \`${f}\``);
  if (triggerFiles.length > shown.length) {
    lines.push(`- …and ${triggerFiles.length - shown.length} more`);
  }
  lines.push(
    "",
    "How to ship the docs entry: add `docs/myrmidon/changes/<branch-slug>.md`",
    "(one file per PR; format and a copy-paste template:",
    "docs/myrmidon/changes/README.md). The release cut folds fragments into the",
    "shared registry documents — they are never edited by hand in a PR. If the",
    "change affects how agents do their work, also update the matching file in",
    "`skills/myrmidon/references/`.",
    "",
    "This reminder is informational only and never fails CI.",
  );
  return lines.join("\n");
}

/** Existing PR comments: [{ id, body, user: { login } }] or null on any error. */
async function listComments(api, repo, prNumber, token) {
  const res = await fetch(
    `${api}/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
  );
  if (!res.ok) throw new Error(`list comments: HTTP ${res.status}`);
  return res.json();
}

async function postComment(api, repo, prNumber, token, body) {
  const res = await fetch(`${api}/repos/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`post comment: HTTP ${res.status}`);
  return res.json();
}

/**
 * One reminder per PR, guarded by the marker. Pure decision part is exported
 * for tests; this wrapper is what the workflow runs.
 */
export async function run({ root, token, prNumber, base, head, repo, api = "https://api.github.com", post = postComment, list = listComments }) {
  if (!token || !prNumber || !base || !head || !repo) {
    return { status: "skipped", reason: "missing token/PR data (fork or workflow_dispatch) — silent exit" };
  }
  const files = changedFiles(root, base, head);
  const verdict = judge(files);
  if (!verdict.remind) {
    return { status: "no-reminder", triggerFiles: verdict.triggerFiles, docsFiles: verdict.docsFiles };
  }
  const comments = await list(api, repo, prNumber, token);
  const bot = "github-actions[bot]";
  const existing = (comments ?? []).find(
    (c) => c.user?.login === bot && typeof c.body === "string" && c.body.includes(MARKER),
  );
  if (existing) {
    return { status: "already-posted", commentId: existing.id };
  }
  const created = await post(api, repo, prNumber, token, commentBody(verdict));
  return { status: "posted", commentId: created?.id ?? null };
}

async function main() {
  const { GITHUB_TOKEN, PR_NUMBER, BASE_SHA, HEAD_SHA, GITHUB_REPOSITORY, GITHUB_API_URL } = process.env;
  try {
    const out = await run({
      root: process.cwd(),
      token: GITHUB_TOKEN,
      prNumber: PR_NUMBER,
      base: BASE_SHA,
      head: HEAD_SHA,
      repo: GITHUB_REPOSITORY,
      api: GITHUB_API_URL || "https://api.github.com",
    });
    console.log(`docs-reminder: ${out.status}${out.reason ? ` (${out.reason})` : ""}`);
  } catch (err) {
    // Never fail the PR: a reminder must not turn CI red. Log and exit 0.
    console.log(`docs-reminder: skipped (${err.message})`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
  process.exit(0);
}
