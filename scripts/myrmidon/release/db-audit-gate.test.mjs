import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// DB-AUDIT-GATE (DB-CARE / DBC-4). The gate is the release-side half of the
// module: it reads one audit report and decides whether the release may pass.
// These tests run the real script in a sandbox directory with reports written
// on the fly — no board, no database, no network.
//
// The property that matters most here is the mode: for 1.6.5 the gate must
// report findings and still exit 0, and the same report must exit 1 under
// --mode block. A gate that blocks 1.6.5, or one that stays silent under
// block, is the failure this file exists to catch.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "db-audit-gate.sh");

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-db-audit-gate-"));
  return {
    dir,
    write(name, content) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
      return file;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function report(overrides = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    datastoreKey: "board",
    generatedAt: "2026-10-08T05:00:00.000Z",
    trigger: "manual",
    criteria: [
      { id: "db-size", title: "Размер базы доски", threshold: "≤ 8 GiB", value: "1.0 GiB", verdict: "ok", source: "pg_database_size(current_database())" },
      { id: "invalid-indexes", title: "Некорректные индексы", threshold: "= 0", value: "2", verdict: "fail", source: "pg_index WHERE NOT indisvalid" },
      { id: "jit", title: "jit", threshold: "off", value: "on", verdict: "warn", source: "pg_settings" },
      { id: "growth-24h", title: "Рост базы за сутки", threshold: "≤ 5 %/сутки", value: "нет предыдущего снимка", verdict: "unknown", source: "datastore_snapshots" },
    ],
    summary: { ok: 1, warn: 1, fail: 1, unknown: 1, worst: "fail" },
    markdown: "# Аудит",
    ...overrides,
  };
}

function run(args) {
  return spawnSync("bash", [GATE, ...args], { encoding: "utf8" });
}

describe("db-audit-gate.sh", () => {
  it("warns on a failing audit and does not block the 1.6.5 release", () => {
    const box = sandbox();
    try {
      const file = box.write("report.json", report());
      const result = run(["--report", file, "--now", "2026-10-08T06:00:00.000Z"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /target=board trigger=manual/);
      assert.match(result.stdout, /age=1\.0h worst=fail/);
      assert.match(result.stdout, /criteria ok=1 warn=1 fail=1 unknown=1/);
      assert.match(result.stdout, /FAIL invalid-indexes: 2 \(threshold = 0\)/);
      assert.match(result.stdout, /WARN jit: on \(threshold off\)/);
      assert.match(result.stdout, /NOTE growth-24h: no value yet/);
      assert.match(result.stdout, /WARNING MODE \(1\.6\.5\).*release NOT blocked/);
      assert.doesNotMatch(result.stderr, /BLOCKED/);
    } finally {
      box.cleanup();
    }
  });

  it("blocks the same audit under --mode block", () => {
    const box = sandbox();
    try {
      const file = box.write("report.json", report());
      const result = run(["--report", file, "--mode", "block", "--now", "2026-10-08T06:00:00.000Z"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /BLOCKED — the audit of board does not pass \(fail=1 stale=0 strict=0\)/);
      // The findings are still printed for the person reading the log.
      assert.match(result.stdout, /FAIL invalid-indexes/);
    } finally {
      box.cleanup();
    }
  });

  it("passes a clean audit in block mode, and only the strict run trips over warnings", () => {
    const box = sandbox();
    try {
      const clean = report({
        criteria: [
          { id: "db-size", threshold: "≤ 8 GiB", value: "1.0 GiB", verdict: "ok", source: "pg_database_size" },
          { id: "jit", threshold: "off", value: "on", verdict: "warn", source: "pg_settings" },
        ],
        summary: { ok: 1, warn: 1, fail: 0, unknown: 0, worst: "warn" },
      });
      const file = box.write("clean.json", clean);

      const lenient = run(["--report", file, "--mode", "block", "--now", "2026-10-08T06:00:00.000Z"]);
      assert.equal(lenient.status, 0, lenient.stderr);
      assert.match(lenient.stdout, /OK — the audit of board passes/);

      const strict = run(["--report", file, "--mode", "block", "--strict", "--now", "2026-10-08T06:00:00.000Z"]);
      assert.equal(strict.status, 1);
      assert.match(strict.stderr, /fail=0 stale=0 strict=1/);
    } finally {
      box.cleanup();
    }
  });

  it("treats a stale report as a finding of its own", () => {
    const box = sandbox();
    try {
      const file = box.write("old.json", report({ summary: { ok: 4, warn: 0, fail: 0, unknown: 0, worst: "ok" } }));
      // 30 hours after the report, with a 24-hour window.
      const warned = run(["--report", file, "--now", "2026-10-09T11:00:00.000Z"]);
      assert.equal(warned.status, 0);
      assert.match(warned.stdout, /STALE the report is older than 24h \(age 30\.0h\)/);
      assert.match(warned.stdout, /release NOT blocked/);

      const blocked = run(["--report", file, "--mode", "block", "--now", "2026-10-09T11:00:00.000Z"]);
      assert.equal(blocked.status, 1);

      // A tighter window turns a fresh report into a stale one, and a wider
      // window accepts the very same file.
      const tight = run(["--report", file, "--max-age-hours", "0.5", "--now", "2026-10-08T06:00:00.000Z"]);
      assert.match(tight.stdout, /STALE the report is older than 0\.5h/);
      const wide = run(["--report", file, "--max-age-hours", "48", "--now", "2026-10-09T11:00:00.000Z"]);
      assert.match(wide.stdout, /age=30\.0h/);
      assert.doesNotMatch(wide.stdout, /STALE/);
    } finally {
      box.cleanup();
    }
  });

  it("accepts the API answer, an array of reports and the bare report object", () => {
    const box = sandbox();
    try {
      const wrapped = box.write("wrapped.json", { report: report() });
      assert.match(run(["--report", wrapped, "--now", "2026-10-08T06:00:00.000Z"]).stdout, /FAIL invalid-indexes/);

      const older = report({ generatedAt: "2026-10-01T05:00:00.000Z", trigger: "hourly" });
      const newest = report({ generatedAt: "2026-10-08T05:00:00.000Z", trigger: "manual" });
      const list = box.write("list.json", [older, newest]);
      const fromList = run(["--report", list, "--now", "2026-10-08T06:00:00.000Z"]);
      assert.equal(fromList.status, 0);
      // The newest report of the array is the one that was checked.
      assert.match(fromList.stdout, /trigger=manual generated=2026-10-08T05:00:00\.000Z/);
    } finally {
      box.cleanup();
    }
  });

  it("emits the machine-readable summary with --json and keeps the log quiet on demand", () => {
    const box = sandbox();
    try {
      const file = box.write("report.json", report());
      const result = run(["--report", file, "--json", "--now", "2026-10-08T06:00:00.000Z"]);
      assert.equal(result.status, 0, result.stderr);
      const lines = result.stdout.trim().split("\n");
      const payload = JSON.parse(lines[lines.length - 1]);
      assert.deepEqual(payload, {
        mode: "warn",
        target: "board",
        trigger: "manual",
        generatedAt: "2026-10-08T05:00:00.000Z",
        ageHours: "1.0",
        counts: { ok: 1, warn: 1, fail: 1, unknown: 1 },
        stale: false,
        strict: false,
        blocking: true,
      });

      const quiet = run(["--report", file, "--quiet", "--json", "--now", "2026-10-08T06:00:00.000Z"]);
      assert.equal(quiet.stdout.trim().split("\n").length, 1);
    } finally {
      box.cleanup();
    }
  });

  it("refuses bad input with exit 2 instead of guessing", () => {
    const box = sandbox();
    try {
      const missing = run(["--report", path.join(box.dir, "nope.json")]);
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /report file not found/);

      const broken = box.write("broken.json", "{not json");
      const bad = run(["--report", broken]);
      assert.equal(bad.status, 2);
      assert.match(bad.stderr, /not JSON/);

      const empty = box.write("empty.json", { datastoreKey: "board", generatedAt: "2026-10-08T05:00:00.000Z", criteria: [] });
      const noCriteria = run(["--report", empty]);
      assert.equal(noCriteria.status, 2);
      assert.match(noCriteria.stderr, /report has no criteria/);

      const noReport = run(["--json"]);
      assert.equal(noReport.status, 2);
      assert.match(noReport.stderr, /--report <report\.json> is required/);

      const badMode = run(["--report", empty, "--mode", "enforce"]);
      assert.equal(badMode.status, 2);
      assert.match(badMode.stderr, /--mode must be warn or block/);

      const unknownArg = run(["--report", empty, "--nope"]);
      assert.equal(unknownArg.status, 2);
      assert.match(unknownArg.stderr, /unknown argument: --nope/);
    } finally {
      box.cleanup();
    }
  });

  it("prints its usage on --help", () => {
    const result = run(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /--mode warn\|block/);
    assert.match(result.stdout, /--max-age-hours 24/);
  });
});