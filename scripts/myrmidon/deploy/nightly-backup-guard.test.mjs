import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const guard = fileURLToPath(new URL("./nightly-backup-guard.sh", import.meta.url));

function runFixture(archive, tasks) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nightly-guard-"));
  try {
    writeFileSync(path.join(dir, "runuser"), '#!/bin/sh\ncase "$*" in *pvesm*) printf "%s\\n" "$ARCHIVE";; *) printf "%s\\n" "$TASKS";; esac\n', { mode: 0o755 });
    return spawnSync("bash", [guard], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ARCHIVE: archive, TASKS: JSON.stringify(tasks) }, encoding: "utf8" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("fresh archive matches a completed VM 100 task by start time", () => {
  const start = Math.floor(Date.now() / 1000) - 600;
  const stamp = new Date(start * 1000).toISOString().replace('.000Z', 'Z');
  const task = { id: "100", node: "hk01", type: "vzdump", status: "OK", starttime: start, endtime: start + 10 };
  assert.equal(runFixture(`pbs-offsite:backup/vm/100/${stamp} backup 100 10`, [task]).status, 0);
  assert.notEqual(runFixture(`pbs-offsite:backup/vm/100/${stamp} backup 100 10`, [{ ...task, starttime: start - 1 }]).status, 0);
});

test("a newer failed VM backup cannot be hidden by an older successful archive", () => {
  const start = Math.floor(Date.now() / 1000) - 600;
  const stamp = new Date(start * 1000).toISOString().replace('.000Z', 'Z');
  const task = { id: "100", node: "hk01", type: "vzdump", status: "OK", starttime: start, endtime: start + 10 };
  const failed = { ...task, status: "ERROR", starttime: start + 30, endtime: start + 40 };
  assert.notEqual(runFixture(`pbs-offsite:backup/vm/100/${stamp} backup 100 10`, [task, failed]).status, 0);
});

test("stale, future, incomplete and ambiguous backup evidence is rejected", () => {
  const now = Math.floor(Date.now() / 1000);
  const task = { id: "100", node: "hk01", type: "vzdump", status: "OK", starttime: now - 600, endtime: now - 590 };
  const archive = (start) => `pbs-offsite:backup/vm/100/${new Date(start * 1000).toISOString().replace('.000Z', 'Z')} backup 100 10`;
  const stale = now - 36 * 3600 - 10;
  assert.notEqual(runFixture(archive(stale), [{ ...task, starttime: stale, endtime: stale + 10 }]).status, 0);
  const future = now + 600;
  assert.notEqual(runFixture(archive(future), [{ ...task, starttime: future, endtime: future + 10 }]).status, 0);
  assert.notEqual(runFixture(archive(task.starttime), [{ ...task, endtime: null }]).status, 0);
  assert.notEqual(runFixture(archive(task.starttime), [task, task]).status, 0);
  assert.notEqual(runFixture(`${archive(task.starttime)}\n${archive(task.starttime)}`, [task]).status, 0);
  assert.notEqual(runFixture(archive(task.starttime), [{ ...task, id: "101" }]).status, 0);
});

test("a failed operator backup query stops the guard", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nightly-guard-"));
  try {
    writeFileSync(path.join(dir, "runuser"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    const result = spawnSync("bash", [guard], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PBS query failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
