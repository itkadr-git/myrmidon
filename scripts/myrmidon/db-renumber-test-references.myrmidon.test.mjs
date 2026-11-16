import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { updateAssociatedTests } from "./db-renumber-migration.mjs";

const directories = ["packages/db/src", "packages/db/tests", "server/tests"];
const extensions = [".test.ts", ".test.mts", ".test.js"];
const before = "0423_sample migration_0423 0423_sample migration_0423\n";
const after = "0424_sample migration_0424 0424_sample migration_0424\n";

function withFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "renumber-references-"));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function put(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function update(root) {
  return updateAssociatedTests(root, "0423", "0424", "0423_sample", "0424_sample");
}

describe("associated migration test references", () => {
  for (const directory of directories) {
    for (const extension of extensions) {
      it(`updates every marker in ${directory} files ending ${extension}`, () => {
        withFixture((root) => {
          const file = `${directory}/migration${extension}`;
          put(root, file, before);
          assert.deepEqual(new Set(update(root)), new Set([file]));
          assert.equal(read(root, file), after);
        });
      });
    }
  }

  it("returns exactly the relative paths whose contents changed", () => {
    withFixture((root) => {
      const files = {
        "packages/db/src/one.test.ts": "0423_sample\n",
        "packages/db/tests/two.test.mts": "migration_0423\n",
        "server/tests/three.test.js": before,
        "server/tests/unchanged.test.js": "no references\n",
        "server/tests/neighbor.spec.ts": before,
        "server/tests/neighbor.ts": before,
        "server/tests/README": before,
      };
      for (const [file, content] of Object.entries(files)) put(root, file, content);
      const returned = update(root);
      const changed = Object.keys(files).filter((file) => read(root, file) !== files[file]);
      assert.deepEqual(new Set(returned), new Set(changed));
      assert.equal(returned.length, changed.length);
      assert.deepEqual(new Set(changed), new Set([
        "packages/db/src/one.test.ts", "packages/db/tests/two.test.mts", "server/tests/three.test.js",
      ]));
      assert.equal(read(root, "packages/db/src/one.test.ts"), "0424_sample\n");
      assert.equal(read(root, "packages/db/tests/two.test.mts"), "migration_0424\n");
      assert.equal(read(root, "server/tests/three.test.js"), after);
    });
  });

  it("accepts all supported directories being absent", () => {
    withFixture((root) => assert.deepEqual(update(root), []));
  });

  it("returns no files on a second run and preserves the updated content", () => {
    withFixture((root) => {
      const file = "packages/db/tests/idempotent.test.ts";
      put(root, file, before);
      assert.deepEqual(update(root), [file]);
      assert.deepEqual(update(root), []);
      assert.equal(read(root, file), after);
    });
  });

  it("keeps independent fixture roots isolated", () => {
    withFixture((first) => withFixture((second) => {
      const file = "server/tests/isolated.test.js";
      put(first, file, before);
      put(second, file, before);
      assert.deepEqual(update(first), [file]);
      assert.equal(read(second, file), before);
      assert.deepEqual(update(second), [file]);
      assert.equal(read(first, file), after);
      assert.equal(read(second, file), after);
    }));
  });
});
