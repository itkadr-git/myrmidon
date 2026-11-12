// RELEASE-CUT tests (OPE-12888): cut-rc.mjs must refuse a cut when the release
// has open tasks or unmerged attached PRs (including on done tasks), tag when
// everything is clean, and only bypass a board violation with an explicit
// override + journal record. Board API and gh are faked; git is real (a
// throwaway repo per test).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  validateArgs,
  tagName,
  changelogVersionOk,
  prBlockingState,
  blockingPrsOfIssue,
  buildOverrideComment,
  formatRefusal,
  resolveRef,
  commitOnBranch,
  defaultBranch,
} from "./cut-rc.mjs";

// --- helpers -----------------------------------------------------------------

function makeRepo({ withChangelog = true, changelogVersion = "1.7.0" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cut-rc-test-"));
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "cut-rc test"]);
  fs.writeFileSync(path.join(root, "README.md"), "test repo\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "init"]);
  if (withChangelog) {
    const dir = path.join(root, "docs/myrmidon");
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, unreleased] of [
      ["CHANGELOG.md", "Unreleased"],
      ["CHANGELOG.ru.md", "Без выпуска"],
    ]) {
      fs.writeFileSync(
        path.join(dir, file),
        `# Changelog\n\n## ${unreleased}\n\n## ${changelogVersion}\n\n### Feature (X)\n- shipped\n\n## 1.6.0\n\n- old\n`,
      );
    }
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "changelog"]);
  }
  return root;
}

function runGit(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

// A fake board: maps path patterns to JSON payloads; records comment POSTs.
function fakeBoard({ labels, issues, workProductsByIssue = {}, failPost = false }) {
  const postedComments = [];
  const calls = [];
  async function fetchBoard(api, pathname, init) {
    calls.push({ pathname, init });
    if (pathname === `/api/companies/${api.companyId}/labels`) {
      if (failPost) throw new Error("HTTP 500 labels down");
      return labels;
    }
    if (pathname.startsWith(`/api/companies/${api.companyId}/issues?`)) {
      return issues.filter((i) => i.status !== "hidden");
    }
    if (pathname.startsWith("/api/issues/") && pathname.endsWith("/comments")) {
      if (failPost) throw new Error("board API comments failed: HTTP 500");
      const id = pathname.split("/")[3];
      postedComments.push({ issueId: id, body: JSON.parse(init.body).body });
      return { ok: true };
    }
    const issueRef = decodeURIComponent(pathname.split("/")[3]);
    if (pathname.startsWith("/api/issues/") && !pathname.includes("/work-products") && !pathname.includes("/comments")) {
      const issue = issues.find((i) => i.id === issueRef || i.identifier === issueRef);
      if (!issue) throw new Error(`HTTP 404 ${pathname}`);
      return issue;
    }
    if (pathname.includes("/work-products")) {
      const id = pathname.split("/")[3];
      return workProductsByIssue[id] || [];
    }
    throw new Error(`unmapped board path: ${pathname}`);
  }
  return { fetchBoard, postedComments, calls };
}

function boardApi(extra = {}) {
  return { apiUrl: "http://board.test", apiKey: "k", companyId: "c1", ...extra };
}

const LABEL_17 = { id: "label-17", name: "1.7", companyId: "c1" };
const API = boardApi();

function issue(id, identifier, status, title = "task") {
  return { id, identifier, status, title };
}

function prWp(status, title = "PR #1: change") {
  return { type: "pull_request", status, title };
}

// --- args --------------------------------------------------------------------

test("tagName builds myr-vX.Y.Z-rc.N", () => {
  assert.equal(tagName({ version: "1.7.0", rc: "25" }), "myr-v1.7.0-rc.25");
});

test("validateArgs rejects missing version / bad rc / override without journal", () => {
  assert.throws(() => validateArgs({ version: null, rc: "1" }), /--version/);
  assert.throws(() => validateArgs({ version: "1.7", rc: "1" }), /--version/);
  assert.throws(() => validateArgs({ version: "1.7.0", rc: null }), /--rc/);
  assert.throws(() => validateArgs({ version: "1.7.0", rc: "x" }), /--rc/);
  assert.throws(
    () => validateArgs({ version: "1.7.0", rc: "1", override: "  " }),
    /non-empty/,
  );
  assert.throws(
    () => validateArgs({ version: "1.7.0", rc: "1", override: "why" }),
    /--journal/,
  );
  assert.throws(
    () => validateArgs({ version: "1.7.0", rc: "1", journal: "12408" }),
    /OPE-/,
  );
  // valid:
  validateArgs({ version: "1.7.0", rc: "25", override: "why", journal: "OPE-12408" });
});

test("parseArgs maps flags", () => {
  const a = parseArgs([
    "--version", "1.7.0", "--rc", "25", "--override", "because",
    "--journal", "ope-12408", "--dry-run", "--skip-gh", "--sha", "abc123",
  ]);
  assert.equal(a.version, "1.7.0");
  assert.equal(a.rc, "25");
  assert.equal(a.override, "because");
  assert.equal(a.journal, "ope-12408");
  assert.equal(a.dryRun, true);
  assert.equal(a.skipGh, true);
  assert.equal(a.sha, "abc123");
});

// --- pr state ------------------------------------------------------------------

test("prBlockingState: merged/closed-unmerged/open classification", () => {
  assert.equal(prBlockingState(prWp("merged")), null);
  assert.equal(prBlockingState(prWp("open")), "open");
  assert.equal(prBlockingState(prWp("draft")), "draft");
  assert.equal(prBlockingState(prWp("ready")), "open");
  assert.equal(prBlockingState(prWp("closed")), "closed-unmerged");
});

test("blockingPrsOfIssue lists unmerged PRs only", () => {
  const blockers = blockingPrsOfIssue({}, [
    prWp("merged", "PR #1: in"),
    prWp("open", "PR #2: open"),
    { type: "artifact", status: "active", title: "not a PR" },
    prWp("closed", "PR #3: closed unmerged"),
  ]);
  assert.equal(blockers.length, 2);
  assert.match(blockers[0], /- PR open$/);
  assert.match(blockers[1], /- PR closed-unmerged$/);
  assert.match(blockers[0], /PR #2: open/);
  assert.match(blockers[1], /PR #3: closed unmerged/);
});

// --- changelog -----------------------------------------------------------------

test("changelogVersionOk accepts a proper release section and empty unreleased", () => {
  const root = makeRepo();
  assert.deepEqual(changelogVersionOk(root, "1.7.0"), []);
});

test("changelogVersionOk refuses a missing version section", () => {
  const root = makeRepo({ changelogVersion: "1.6.9" });
  const problems = changelogVersionOk(root, "1.7.0");
  assert.ok(problems.some((p) => p.includes("CHANGELOG.md") && p.includes('no "## 1.7.0"')));
  assert.ok(problems.some((p) => p.includes("CHANGELOG.ru.md")));
});

test("changelogVersionOk refuses a non-empty Unreleased (fragments not folded)", () => {
  const root = makeRepo();
  const file = path.join(root, "docs/myrmidon/CHANGELOG.md");
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("## Unreleased\n", "## Unreleased\n\n### New (Y)\n- pending\n"),
  );
  const problems = changelogVersionOk(root, "1.7.0");
  assert.ok(problems.some((p) => p.includes("Unreleased") && p.includes("not empty")));
});

// --- git helpers -----------------------------------------------------------------

test("resolveRef/commitOnBranch/defaultBranch on a real throwaway repo", () => {
  const root = makeRepo();
  const sha = resolveRef(root, "main");
  assert.ok(/^[0-9a-f]{40}$/.test(sha));
  assert.equal(commitOnBranch(root, sha, "main"), true);
  // a commit not on main
  runGit(root, ["checkout", "-q", "-b", "side"]);
  fs.writeFileSync(path.join(root, "x.txt"), "x");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-q", "-m", "side"]);
  const side = resolveRef(root, "side");
  assert.equal(commitOnBranch(root, side, "main"), false);
  runGit(root, ["checkout", "-q", "main"]);
  assert.equal(defaultBranch(root), "main");
});

// --- board violations ---------------------------------------------------------

const CLEAN_ISSUES = [
  issue("i1", "OPE-100", "done"),
  issue("i2", "OPE-101", "done"),
];

test("collectBoardViolations: all clean -> no violations", async () => {
  const { collectBoardViolations } = await import("./cut-rc.mjs");
  const board = fakeBoard({ labels: [LABEL_17], issues: CLEAN_ISSUES, workProductsByIssue: { i1: [prWp("merged")], i2: [] } });
  const { violations, openIssues } = await collectBoardViolations(API, CLEAN_ISSUES, {}, board.fetchBoard);
  assert.deepEqual(violations, []);
  assert.deepEqual(openIssues, []);
});

test("collectBoardViolations: open task -> refusal item", async () => {
  const { collectBoardViolations } = await import("./cut-rc.mjs");
  const issues = [...CLEAN_ISSUES, issue("i3", "OPE-102", "in_progress", "still working")];
  const board = fakeBoard({ labels: [LABEL_17], issues, workProductsByIssue: { i1: [], i2: [], i3: [] } });
  const { violations, openIssues } = await collectBoardViolations(API, issues, {}, board.fetchBoard);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /OPE-102.*still working.*in_progress/);
  assert.equal(openIssues.length, 1);
});

test("collectBoardViolations: done task with unmerged PR -> refusal item (12.11 failure mode)", async () => {
  const { collectBoardViolations } = await import("./cut-rc.mjs");
  const board = fakeBoard({
    labels: [LABEL_17],
    issues: CLEAN_ISSUES,
    workProductsByIssue: { i1: [prWp("open", "PR #2996: forgotten")], i2: [prWp("closed", "PR #2900: abandoned")] },
  });
  const { violations, openIssues } = await collectBoardViolations(API, CLEAN_ISSUES, {}, board.fetchBoard);
  assert.equal(violations.length, 2);
  assert.match(violations[0], /OPE-100.*unmerged attached PR.*#2996/);
  assert.match(violations[1], /OPE-101.*closed-unmerged/);
  assert.deepEqual(openIssues, []);
});

test("collectBoardViolations: cancelled task counts as not done", async () => {
  const { collectBoardViolations } = await import("./cut-rc.mjs");
  const issues = [...CLEAN_ISSUES, issue("i4", "OPE-103", "cancelled")];
  const board = fakeBoard({ labels: [LABEL_17], issues, workProductsByIssue: {} });
  const { violations } = await collectBoardViolations(API, issues, {}, board.fetchBoard);
  assert.match(violations[0], /OPE-103 not done \[cancelled\]/);
});

// --- override comment -----------------------------------------------------------

test("buildOverrideComment carries tag, reason, violations and open list", () => {
  const text = buildOverrideComment({
    tagName: "myr-v1.7.0-rc.25",
    version: "1.7.0",
    rc: "25",
    reason: "rc.24 already shipped",
    violations: ["open task OPE-102", "OPE-100 has unmerged attached PR: PR #2996"],
    openIssues: [issue("i3", "OPE-102", "in_progress", "still working")],
  });
  assert.match(text, /RELEASE-CUT OVERRIDE — myr-v1.7.0-rc\.25/);
  assert.match(text, /Обоснование: rc\.24 already shipped/);
  assert.match(text, /OPE-102 "still working" \[in_progress\]/);
  assert.match(text, /PR #2996/);
});

test("formatRefusal names the bypass flags", () => {
  const text = formatRefusal({ tag: "myr-v1.7.0-rc.25", violations: ["x"], ciProblem: "CI failed: build=failure" });
  assert.match(text, /RELEASE-CUT REFUSED/);
  assert.match(text, /--override/);
  assert.match(text, /CI failed/);
});

// --- end-to-end via run() ---------------------------------------------------------

async function importRun() {
  const mod = await import("./cut-rc.mjs");
  return mod.run;
}

test("run: open task refuses and tags nothing (exit 1)", async () => {
  const run = await importRun();
  const root = makeRepo();
  const issues = [issue("i1", "OPE-100", "done"), issue("i2", "OPE-102", "todo", "not started")];
  const board = fakeBoard({ labels: [LABEL_17], issues, workProductsByIssue: { i1: [], i2: [] } });
  const logs = [];
  const code = await run(
    { version: "1.7.0", rc: "25", skipGh: true, root, boardLabel: "1.7" },
    { api: API, fetchBoard: board.fetchBoard, log: (m) => logs.push(m), err: () => {}, root },
  );
  assert.equal(code, 1);
  assert.equal(runGit(root, ["tag", "-l", "myr-v1.7.0-rc.25"]), "");
});

test("run: done task with unmerged PR refuses (exit 1)", async () => {
  const run = await importRun();
  const root = makeRepo();
  const board = fakeBoard({
    labels: [LABEL_17],
    issues: CLEAN_ISSUES,
    workProductsByIssue: { i1: [prWp("open", "PR #3001: unmerged")], i2: [] },
  });
  const code = await run(
    { version: "1.7.0", rc: "25", skipGh: true, root, boardLabel: "1.7" },
    { api: API, fetchBoard: board.fetchBoard, log: () => {}, err: () => {}, root },
  );
  assert.equal(code, 1);
  assert.equal(runGit(root, ["tag", "-l", "myr-v1.7.0-rc.25"]), "");
});

test("run: everything clean -> tags the commit (exit 0)", async () => {
  const run = await importRun();
  const root = makeRepo();
  const board = fakeBoard({ labels: [LABEL_17], issues: CLEAN_ISSUES, workProductsByIssue: { i1: [], i2: [] } });
  const code = await run(
    { version: "1.7.0", rc: "25", skipGh: true, root, boardLabel: "1.7" },
    { api: API, fetchBoard: board.fetchBoard, log: () => {}, err: () => {}, root },
  );
  assert.equal(code, 0);
  const tagged = runGit(root, ["rev-parse", "myr-v1.7.0-rc.25"]);
  assert.equal(tagged, runGit(root, ["rev-parse", "main"]));
});

test("run: existing tag refuses (exit 1)", async () => {
  const run = await importRun();
  const root = makeRepo();
  runGit(root, ["tag", "myr-v1.7.0-rc.25", "main"]);
  const board = fakeBoard({ labels: [LABEL_17], issues: CLEAN_ISSUES, workProductsByIssue: { i1: [], i2: [] } });
  const code = await run(
    { version: "1.7.0", rc: "25", skipGh: true, root, boardLabel: "1.7" },
    { api: API, fetchBoard: board.fetchBoard, log: () => {}, err: () => {}, root },
  );
  assert.equal(code, 1);
});

test("run: override + journal records the comment and tags (exit 0)", async () => {
  const run = await importRun();
  const root = makeRepo();
  const issues = [issue("i1", "OPE-100", "done"), issue("i2", "OPE-102", "in_progress", "still working")];
  const journal = issue("j1", "OPE-12408", "in_progress", "1.7 release journal");
  const board = fakeBoard({
    labels: [LABEL_17],
    issues: [...issues, journal],
    workProductsByIssue: { i1: [], i2: [] },
  });
  const code = await run(
    { version: "1.7.0", rc: "25", skipGh: true, root, boardLabel: "1.7", override: "rc.24 already shipped; list is stale", journal: "OPE-12408" },
    { api: API, fetchBoard: board.fetchBoard, log: () => {}, err: () => {}, root },
  );
  assert.equal(code, 0);
  // tagged
  assert.equal(runGit(root, ["tag", "-l", "myr-v1.7.0-rc.25"]), "myr-v1.7.0-rc.25");
  // comment posted to the journal issue with the reason and the open list
  assert.equal(board.postedComments.length, 1);
  const body = board.postedComments[0].body;
  assert.match(body, /OVERRIDE — myr-v1.7.0-rc\.25/);
  assert.match(body, /rc\.24 already shipped; list is stale/);
  assert.match(body, /OPE-102 "still working" \[in_progress\]/);
  // posted to the right issue (resolved from identifier to id)
  assert.equal(board.postedComments[0].issueId, "j1");
});

test("run: override without a reachable board refuses (no silent bypass, exit 1)", async () => {
  const run = await importRun();
  const root = makeRepo();
  const issues = [issue("i1", "OPE-100", "done"), issue("i2", "OPE-102", "todo")];
  const board = fakeBoard({ labels: [LABEL_17], issues, failPost: true });
  const code = await run(
    { version: "1.7.0", rc: "25", skipGh: true, root, boardLabel: "1.7", override: "why", journal: "OPE-12408" },
    { api: API, fetchBoard: board.fetchBoard, log: () => {}, err: () => {}, root },
  );
  assert.equal(code, 1);
  assert.equal(runGit(root, ["tag", "-l", "myr-v1.7.0-rc.25"]), "");
});

test("run: dry-run tags nothing even when clean", async () => {
  const run = await importRun();
  const root = makeRepo();
  const board = fakeBoard({ labels: [LABEL_17], issues: CLEAN_ISSUES, workProductsByIssue: { i1: [], i2: [] } });
  const logs = [];
  const code = await run(
    { version: "1.7.0", rc: "25", skipGh: true, root, boardLabel: "1.7", dryRun: true },
    { api: API, fetchBoard: board.fetchBoard, log: (m) => logs.push(m), err: () => {}, root },
  );
  assert.equal(code, 0);
  assert.equal(runGit(root, ["tag", "-l", "myr-v1.7.0-rc.25"]), "");
  assert.ok(logs.some((m) => m.includes("dry-run")));
});

test("run: red CI refuses even with an override (CI not bypassable)", async () => {
  const run = await importRun();
  const root = makeRepo();
  const board = fakeBoard({ labels: [LABEL_17], issues: CLEAN_ISSUES, workProductsByIssue: { i1: [], i2: [] } });
  const code = await run(
    { version: "1.7.0", rc: "25", root, boardLabel: "1.7", override: "because", journal: "OPE-12408" },
    {
      api: API, fetchBoard: board.fetchBoard, log: () => {}, err: () => {}, root,
      ciStatus: () => ({ ok: false, reason: "CI failed: checks=failure" }),
    },
  );
  assert.equal(code, 1);
  assert.equal(runGit(root, ["tag", "-l", "myr-v1.7.0-rc.25"]), "");
});

test("run: missing release label on the board refuses", async () => {
  const run = await importRun();
  const root = makeRepo();
  const board = fakeBoard({ labels: [{ id: "other", name: "1.8" }], issues: [] });
  const code = await run(
    { version: "1.7.0", rc: "25", skipGh: true, root, boardLabel: "1.7" },
    { api: API, fetchBoard: board.fetchBoard, log: () => {}, err: () => {}, root },
  );
  assert.equal(code, 1);
});

test("run: sha not on the branch refuses", async () => {
  const run = await importRun();
  const root = makeRepo();
  runGit(root, ["checkout", "-q", "-b", "side"]);
  fs.writeFileSync(path.join(root, "side.txt"), "s");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-q", "-m", "side"]);
  const side = runGit(root, ["rev-parse", "side"]);
  runGit(root, ["checkout", "-q", "main"]);
  const board = fakeBoard({ labels: [LABEL_17], issues: CLEAN_ISSUES, workProductsByIssue: { i1: [], i2: [] } });
  const code = await run(
    { version: "1.7.0", rc: "25", skipGh: true, root, boardLabel: "1.7", sha: side },
    { api: API, fetchBoard: board.fetchBoard, log: () => {}, err: () => {}, root },
  );
  assert.equal(code, 1);
});
