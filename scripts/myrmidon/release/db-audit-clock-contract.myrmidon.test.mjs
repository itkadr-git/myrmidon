import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const gate = fileURLToPath(new URL("./db-audit-gate.sh", import.meta.url));
const now = "2026-10-09T06:00:00Z";
const cases = [
  { name: "missing timestamp", generatedAt: undefined, age: "unknown", stale: true },
  { name: "future timestamp", generatedAt: "2026-10-09T07:00:00Z", age: "0.0", stale: false },
  { name: "24-hour boundary", generatedAt: "2026-10-08T06:00:00Z", age: "24.0", stale: false },
  { name: "25-hour stale report", generatedAt: "2026-10-08T05:00:00Z", age: "25.0", stale: true },
  { name: "25 hours in a 48-hour window", generatedAt: "2026-10-08T05:00:00Z", age: "25.0", stale: false, window: "48" },
  { name: "49 hours in a 48-hour window", generatedAt: "2026-10-07T05:00:00Z", age: "49.0", stale: true, window: "48" },
];

function withFixture(generatedAt, check) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir();
  const dir = mkdtempSync(path.join(base, "db-audit-clock-"));
  try {
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    for (const command of ["jq", "date", "awk"]) symlinkSync(`/usr/bin/${command}`, path.join(bin, command));
    const file = path.join(dir, "report.json");
    const content = JSON.stringify({
      datastoreKey: "board", trigger: "manual", generatedAt,
      criteria: [{ id: "clean", verdict: "ok", value: "1", threshold: "2", source: "fixture" }],
      summary: { ok: 1, warn: 0, fail: 0, unknown: 0, worst: "ok" },
    });
    writeFileSync(file, content);
    const run = (args) => spawnSync("/bin/bash", [gate, "--report", file, "--quiet", "--json", ...args], {
      encoding: "utf8", timeout: 5000, cwd: dir,
      env: { PATH: bin, HOME: dir, TMPDIR: dir, LC_ALL: "C", TZ: "UTC" },
    });
    try {
      check(run);
    } finally {
      assert.equal(readFileSync(file, "utf8"), content, "the report must remain unchanged");
      assert.deepEqual(readdirSync(dir).sort(), ["bin", "report.json"], "no side effects in fixture directory");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const fixture of cases) {
  test(fixture.name, () => withFixture(fixture.generatedAt, (run) => {
    for (const mode of ["warn", "block"]) {
      const args = ["--now", now, "--mode", mode, "--max-age-hours", fixture.window || "24"];
      const result = run(args);
      assert.ifError(result.error);
      assert.equal(result.status, mode === "block" && fixture.stale ? 1 : 0, result.stderr);
      if (mode === "block" && fixture.stale) assert.match(result.stderr, /BLOCKED.*fail=0 stale=1/);
      else assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), {
        mode, target: "board", trigger: "manual", generatedAt: fixture.generatedAt || "",
        ageHours: fixture.age, counts: { ok: 1, warn: 0, fail: 0, unknown: 0 },
        stale: fixture.stale, strict: false, blocking: fixture.stale,
      });
    }
  }));
}

test("invalid generatedAt exits 2 with a diagnostic", () => withFixture("not-a-date", (run) => {
  const result = run(["--now", now]);
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /generatedAt is not an ISO-8601 date: not-a-date/);
}));

test("invalid --now exits 2 with a diagnostic", () => withFixture("2026-10-09T05:00:00Z", (run) => {
  const result = run(["--now", "not-a-date"]);
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--now is not an ISO-8601 date: not-a-date/);
}));
