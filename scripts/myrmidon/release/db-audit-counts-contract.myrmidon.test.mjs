import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const gate = fileURLToPath(new URL("./db-audit-gate.sh", import.meta.url));
const generatedAt = "2026-10-08T05:00:00.000Z";
const cases = [
  { name: "clean criteria override failing summary", verdicts: ["ok", "ok", "ok"], summary: { ok: 0, warn: 0, fail: 9, unknown: 0, worst: "fail" }, counts: { ok: 3, warn: 0, fail: 0, unknown: 0 }, mode: "block", strict: false, blocking: false, status: 0 },
  { name: "failing criteria override clean summary", verdicts: ["ok", "ok", "fail", "fail", "warn", "warn", "unknown", "unknown"], summary: { ok: 8, warn: 0, fail: 0, unknown: 0, worst: "ok" }, counts: { ok: 2, warn: 2, fail: 2, unknown: 2 }, mode: "block", strict: false, blocking: true, status: 1 },
  { name: "unknown criteria do not block", verdicts: ["unknown", "unknown", "unknown"], summary: { ok: 0, warn: 0, fail: 5, unknown: 0, worst: "fail" }, counts: { ok: 0, warn: 0, fail: 0, unknown: 3 }, mode: "block", strict: false, blocking: false, status: 0 },
  { name: "warnings pass in lenient mode", verdicts: ["ok", "ok", "warn", "warn"], summary: { ok: 0, warn: 0, fail: 4, unknown: 0, worst: "fail" }, counts: { ok: 2, warn: 2, fail: 0, unknown: 0 }, mode: "block", strict: false, blocking: false, status: 0 },
  { name: "warnings block in strict mode", verdicts: ["ok", "ok", "warn", "warn"], summary: { ok: 4, warn: 0, fail: 0, unknown: 0, worst: "ok" }, counts: { ok: 2, warn: 2, fail: 0, unknown: 0 }, mode: "block", strict: true, blocking: true, status: 1 },
  { name: "warning mode exits zero for a blocking result", verdicts: ["fail", "fail", "unknown", "unknown"], summary: { ok: 4, warn: 0, fail: 0, unknown: 0, worst: "ok" }, counts: { ok: 0, warn: 0, fail: 2, unknown: 2 }, mode: "warn", strict: false, blocking: true, status: 0 },
];

for (const fixture of cases) {
  test(fixture.name, () => {
    const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || path.join(os.homedir(), ".cache");
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, "db-audit-counts-"));
    try {
      const bin = path.join(dir, "bin");
      const calls = path.join(dir, "forbidden-calls");
      fs.mkdirSync(bin);
      for (const name of ["bash", "jq", "date", "awk"]) {
        const found = spawnSync("which", [name], { encoding: "utf8", timeout: 5000 });
        assert.equal(found.status, 0, `${name} is required`);
        fs.symlinkSync(found.stdout.trim(), path.join(bin, name));
      }
      for (const name of ["curl", "wget", "gh", "git", "npm", "npx", "pnpm", "docker", "psql"]) {
        fs.writeFileSync(path.join(bin, name), `#!/bin/bash\nprintf '%s\\n' '${name}' >> "$FORBIDDEN_CALLS"\nexit 99\n`, { mode: 0o755 });
      }
      const report = path.join(dir, "report.json");
      fs.writeFileSync(report, JSON.stringify({
        datastoreKey: "board", trigger: "manual", generatedAt,
        criteria: fixture.verdicts.map((verdict, index) => ({ id: `criterion-${index}`, verdict, value: "value", threshold: "threshold", source: "fixture" })),
        summary: fixture.summary,
      }));
      const args = [gate, "--report", report, "--mode", fixture.mode, "--now", "2026-10-08T06:00:00.000Z", "--quiet", "--json"];
      if (fixture.strict) args.push("--strict");
      const result = spawnSync(path.join(bin, "bash"), args, {
        cwd: dir, encoding: "utf8", timeout: 10000,
        env: { PATH: bin, HOME: dir, TMPDIR: dir, FORBIDDEN_CALLS: calls, LC_ALL: "C" },
      });
      assert.ifError(result.error);
      assert.equal(result.status, fixture.status, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        mode: fixture.mode, target: "board", trigger: "manual", generatedAt,
        ageHours: "1.0", counts: fixture.counts, stale: false,
        strict: fixture.strict, blocking: fixture.blocking,
      });
      assert.equal(fs.existsSync(calls), false, "the gate invoked a forbidden external command");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
