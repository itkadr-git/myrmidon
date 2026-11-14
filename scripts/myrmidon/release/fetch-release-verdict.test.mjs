// FETCH-RELEASE-VERDICT tests (OPE-13017): the CLI must locate the release
// issue by label, call the board release-verify route, and persist the SIGNED
// verdict JSON for the publish gate. Board API is faked (fetchBoard injected);
// no network, no real board.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseArgs,
  validateArgs,
  labelFromVersion,
  mainSync,
  run,
  UsageError,
} from "./fetch-release-verdict.mjs";

const COMPANY_ID = "c1";
const ISSUE_ID = "5f38f2aa-381b-476c-97a8-d8ba190c099b";
const LABEL = { id: "label-18", name: "1.8", companyId: COMPANY_ID };
const RELEASE_ISSUE = { id: ISSUE_ID, identifier: "OPE-12988", status: "in_progress", title: "release" };

const VERDICT = {
  issueId: ISSUE_ID,
  releaseLabel: "1.8",
  candidateIssueIds: ["i1"],
  deployedVersion: "abc123abc123abc123abc123abc123abc123abc1",
  verdict: "confirmed",
  failureReason: null,
  reason: "all members present",
  checkedAt: "2026-11-14T04:00:00.000Z",
  members: [],
  signature: "deadbeef".repeat(8),
};

// A fake board: labels list, label-filtered issue list, and the release-verify
// POST. Records every call so tests can assert the route and method.
function fakeBoard({ labels = [LABEL], issues = [RELEASE_ISSUE], verdict = VERDICT, failVerify = false } = {}) {
  const calls = [];
  async function fetchBoard(api, pathname, init) {
    calls.push({ pathname, init });
    if (pathname === `/api/companies/${api.companyId}/labels`) return labels;
    if (pathname.startsWith(`/api/companies/${api.companyId}/issues?`)) {
      return issues;
    }
    if (pathname === `/api/issues/${ISSUE_ID}/release-verify`) {
      if (failVerify) throw new Error("board API /release-verify failed: HTTP 500");
      assert.equal(init.method, "POST");
      return verdict;
    }
    throw new Error(`unmapped board path: ${pathname}`);
  }
  return { fetchBoard, calls };
}

function env(extra = {}) {
  return {
    PAPERCLIP_API_URL: "http://board.test",
    PAPERCLIP_API_KEY: "key",
    PAPERCLIP_COMPANY_ID: COMPANY_ID,
    ...extra,
  };
}

const silent = { log: () => {} };

// --- args -------------------------------------------------------------------

test("labelFromVersion maps X.Y.Z to the release label X.Y", () => {
  assert.equal(labelFromVersion("1.8.0"), "1.8");
  assert.equal(labelFromVersion("1.6.5"), "1.6");
  assert.equal(labelFromVersion("2.10.3"), "2.10");
});

test("validateArgs requires --version X.Y.Z", () => {
  assert.throws(() => validateArgs({ version: null }), /--version/);
  assert.throws(() => validateArgs({ version: "1.8" }), /--version/);
  assert.throws(() => validateArgs({ version: "1.8-rc.1" }), /--version/);
  validateArgs({ version: "1.8.0" });
});

test("parseArgs maps flags and rejects unknowns", () => {
  const a = parseArgs([
    "--version", "1.8.0", "--board-label", "1.8", "--issue", ISSUE_ID,
    "--out", "/tmp/v.json", "--api-url", "http://x", "--api-key", "k", "--company-id", "c",
  ]);
  assert.equal(a.version, "1.8.0");
  assert.equal(a.boardLabel, "1.8");
  assert.equal(a.issue, ISSUE_ID);
  assert.equal(a.out, "/tmp/v.json");
  assert.equal(a.apiUrl, "http://x");
  assert.equal(a.apiKey, "k");
  assert.equal(a.companyId, "c");
  assert.throws(() => parseArgs(["--version", "1.8.0", "--skip-verify"]), /unknown argument/);
});

test("parseArgs throws UsageError (not a bare Error) on unknown flags", () => {
  assert.throws(() => parseArgs(["--bogus"]), (e) => e instanceof UsageError);
});

test("mainSync: usage error exits 2 before touching the board", () => {
  assert.equal(mainSync(["--version", "1.8.0", "--skip-verify"], { env: env() }), 2);
});

// --- run --------------------------------------------------------------------

test("run: locates the issue by derived label and writes the signed verdict", async () => {
  const { fetchBoard, calls } = fakeBoard();
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fetch-verdict-")), "v.json");
  const code = await run(
    { version: "1.8.0", boardLabel: null, issue: null, out, apiUrl: null, apiKey: null, companyId: null },
    { ...silent, env: env() },
    fetchBoard,
  );
  assert.equal(code, 0);
  const written = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(written.verdict, "confirmed");
  assert.equal(written.signature, VERDICT.signature);
  assert.equal(written.deployedVersion, VERDICT.deployedVersion);
  // One label list, one issue page, one release-verify POST.
  const paths = calls.map((c) => c.pathname);
  assert.ok(paths.some((p) => p.endsWith("/labels")));
  assert.ok(paths.some((p) => p.includes("labelId=label-18")));
  assert.ok(paths.includes(`/api/issues/${ISSUE_ID}/release-verify`));
});

test("run: --issue skips the label lookup and verifies the given issue", async () => {
  const { fetchBoard, calls } = fakeBoard();
  const code = await run(
    { version: "1.8.0", boardLabel: null, issue: ISSUE_ID, out: null, apiUrl: null, apiKey: null, companyId: null },
    { ...silent, env: env() },
    fetchBoard,
  );
  assert.equal(code, 0);
  assert.deepEqual(calls.map((c) => c.pathname), [`/api/issues/${ISSUE_ID}/release-verify`]);
});

test("run: --board-label overrides the derived label", async () => {
  const other = { id: "label-x", name: "1.8-rc", companyId: COMPANY_ID };
  const { fetchBoard, calls } = fakeBoard({ labels: [other] });
  const code = await run(
    { version: "1.8.0", boardLabel: "1.8-rc", issue: null, out: null, apiUrl: null, apiKey: null, companyId: null },
    { ...silent, env: env() },
    fetchBoard,
  );
  assert.equal(code, 0);
  assert.ok(calls.some((c) => c.pathname.includes("labelId=label-x")));
});

test("run: refuses when no issue carries the release label", async () => {
  const { fetchBoard } = fakeBoard({ issues: [] });
  const logs = [];
  const code = await run(
    { version: "1.8.0", boardLabel: null, issue: null, out: null, apiUrl: null, apiKey: null, companyId: null },
    { log: (m) => logs.push(m), env: env() },
    fetchBoard,
  );
  assert.equal(code, 1);
  assert.ok(logs.join("\n").includes("no issue carries the release label"));
});

test("run: refuses when the label is ambiguous (more than one issue)", async () => {
  const other = { id: "other-id", identifier: "OPE-99999", status: "todo", title: "dup" };
  const { fetchBoard } = fakeBoard({ issues: [RELEASE_ISSUE, other] });
  const logs = [];
  const code = await run(
    { version: "1.8.0", boardLabel: null, issue: null, out: null, apiUrl: null, apiKey: null, companyId: null },
    { log: (m) => logs.push(m), env: env() },
    fetchBoard,
  );
  assert.equal(code, 1);
  assert.ok(logs.join("\n").includes("disambiguate"));
});

test("run: refuses when the API key is missing", async () => {
  const { fetchBoard } = fakeBoard();
  const logs = [];
  const code = await run(
    { version: "1.8.0", boardLabel: null, issue: null, out: null, apiUrl: null, apiKey: null, companyId: null },
    { log: (m) => logs.push(m), env: env({ PAPERCLIP_API_KEY: "" }) },
    fetchBoard,
  );
  assert.equal(code, 1);
  assert.ok(logs.join("\n").includes("PAPERCLIP_API_KEY"));
});

test("run: refuses when the release-verify route errors", async () => {
  const { fetchBoard } = fakeBoard({ failVerify: true });
  const logs = [];
  const code = await run(
    { version: "1.8.0", boardLabel: null, issue: ISSUE_ID, out: null, apiUrl: null, apiKey: null, companyId: null },
    { log: (m) => logs.push(m), env: env() },
    fetchBoard,
  );
  assert.equal(code, 1);
  assert.ok(logs.join("\n").includes("HTTP 500"));
});

test("run: refuses when the route returns no verdict", async () => {
  const { fetchBoard } = fakeBoard({ verdict: {} });
  const code = await run(
    { version: "1.8.0", boardLabel: null, issue: ISSUE_ID, out: null, apiUrl: null, apiKey: null, companyId: null },
    { ...silent, env: env() },
    fetchBoard,
  );
  assert.equal(code, 1);
});

test("run: writes to stdout when --out is omitted", async () => {
  const { fetchBoard } = fakeBoard();
  const stdoutWrite = mock.method(process.stdout, "write");
  try {
    const code = await run(
      { version: "1.8.0", boardLabel: null, issue: ISSUE_ID, out: null, apiUrl: null, apiKey: null, companyId: null },
      { ...silent, env: env() },
      fetchBoard,
    );
    assert.equal(code, 0);
    assert.ok(stdoutWrite.mock.calls.length > 0);
    const payload = stdoutWrite.mock.calls.map((c) => c.arguments[0]).join("");
    assert.equal(JSON.parse(payload).verdict, "confirmed");
  } finally {
    stdoutWrite.mock.restore();
  }
});
