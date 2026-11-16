import assert from "node:assert/strict";
import test from "node:test";
import { addFileToSnapshot } from "../dev-runner-snapshot.mjs";

const root = "/repo";
const target = "/repo/server/nested/app.ts";
const initial = [["server/before.ts", "1:2"], ["server/nested/app.ts", "3:4"], ["server/after.ts", "5:6"]];
const updated = [["server/before.ts", "1:2"], ["server/nested/app.ts", "12:7"], ["server/after.ts", "5:6"]];

function fixture(result = { mtimeMs: 12.75, size: 7 }, ignoredRelativePaths = new Set()) {
  const snapshot = new Map(initial);
  const calls = [];
  const options = {
    repoRoot: root,
    ignoredRelativePaths,
    fileSystem: { statSync(name) { calls.push(name); if (result instanceof Error) throw result; return result; } },
  };
  return { snapshot, calls, options };
}

function recover(f) {
  f.options.fileSystem.statSync = (name) => { f.calls.push(name); return { mtimeMs: 12.75, size: 7 }; };
  addFileToSnapshot(f.snapshot, target, f.options);
  assert.deepEqual([...f.snapshot], updated);
}

test("adds a nested runtime path with a root-relative key and truncated fractional mtime", () => {
  const f = fixture();
  assert.deepEqual([...f.snapshot], initial);
  addFileToSnapshot(f.snapshot, "/repo/server/nested/new.ts", f.options);
  assert.deepEqual([...f.snapshot], [...initial, ["server/nested/new.ts", "12:7"]]);
  assert.deepEqual(f.calls, ["/repo/server/nested/new.ts"]);
});

test("updates an existing signature without moving neighboring keys", () => {
  const f = fixture();
  assert.deepEqual([...f.snapshot], initial);
  addFileToSnapshot(f.snapshot, target, f.options);
  assert.deepEqual([...f.snapshot], updated);
  assert.deepEqual(f.calls, [target]);
});

test("repeated insertion keeps one key and the latest signature", () => {
  const f = fixture();
  assert.deepEqual([...f.snapshot], initial);
  addFileToSnapshot(f.snapshot, target, f.options);
  assert.deepEqual([...f.snapshot], updated);
  f.options.fileSystem.statSync = (name) => { f.calls.push(name); return { mtimeMs: 22.9, size: 9 }; };
  addFileToSnapshot(f.snapshot, target, f.options);
  assert.deepEqual([...f.snapshot], [["server/before.ts", "1:2"], ["server/nested/app.ts", "22:9"], ["server/after.ts", "5:6"]]);
  assert.deepEqual(f.calls, [target, target]);
});

test("ignored existing path preserves its entry before stat and permits a later update", () => {
  const f = fixture(undefined, new Set(["server/nested/app.ts"]));
  assert.deepEqual([...f.snapshot], initial);
  addFileToSnapshot(f.snapshot, target, f.options);
  assert.deepEqual([...f.snapshot], initial);
  assert.deepEqual(f.calls, []);
  f.options.ignoredRelativePaths.clear();
  recover(f);
  assert.deepEqual(f.calls, [target]);
});

for (const name of ["/repo/server/nested/app.test.ts", "/repo/server/__tests__/app.ts"]) {
  test(`lexical test path ${name} is filtered before stat and does not poison later insertion`, () => {
    const f = fixture();
    assert.deepEqual([...f.snapshot], initial);
    addFileToSnapshot(f.snapshot, name, f.options);
    assert.deepEqual([...f.snapshot], initial);
    assert.deepEqual(f.calls, []);
    recover(f);
    assert.deepEqual(f.calls, [target]);
  });
}

for (const code of ["ENOENT", "ENOTDIR", "EACCES", "EIO"]) {
  test(`${code} preserves the complete snapshot and permits a later update`, () => {
    const error = Object.assign(new Error(code), { code });
    const f = fixture(error);
    assert.deepEqual([...f.snapshot], initial);
    if (code === "ENOENT" || code === "ENOTDIR") {
      assert.equal(addFileToSnapshot(f.snapshot, target, f.options), undefined);
    } else {
      assert.throws(() => addFileToSnapshot(f.snapshot, target, f.options), (caught) => caught === error);
    }
    assert.deepEqual([...f.snapshot], initial);
    assert.deepEqual(f.calls, [target]);
    recover(f);
    assert.deepEqual(f.calls, [target, target]);
  });
}
