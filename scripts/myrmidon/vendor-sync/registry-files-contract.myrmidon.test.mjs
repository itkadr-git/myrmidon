import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rowVendorFiles, rowTouchesFile } from "./lib.mjs";

const row = (column) => ({ cells: column === undefined ? {} : { "Файлы вендора": column } });

describe("registry vendor file contract", () => {
  it("ignores absent and empty columns", () => {
    for (const input of [row(), row("")]) {
      assert.deepEqual(rowVendorFiles(input), []);
      assert.equal(rowTouchesFile(input, "server/src/a.ts"), false);
    }
  });

  it("keeps vendor paths in order and excludes our paths after plus", () => {
    const input = row("`server/src/a.ts`, `server/src/b.ts` + `server/src/ours.ts`");
    assert.deepEqual(rowVendorFiles(input), ["server/src/a.ts", "server/src/b.ts"]);
    assert.equal(rowTouchesFile(input, "server/src/a.ts"), true);
    assert.equal(rowTouchesFile(input, "server/src/b.ts"), true);
    assert.equal(rowTouchesFile(input, "server/src/ours.ts"), false);
  });

  it("matches exact paths, not suffixes, neighboring basenames, or directories", () => {
    const input = row("`server/src/routes` `server/src/a.ts`");
    assert.equal(rowTouchesFile(input, "server/src/a.ts"), true);
    assert.equal(rowTouchesFile(input, "server/src/a.ts.bak"), false);
    assert.equal(rowTouchesFile(input, "server/src/other-a.ts"), false);
    assert.equal(rowTouchesFile(input, "server/src/routes"), true);
    assert.equal(rowTouchesFile(input, "server/src/routes/x.ts"), false);
  });

  it("uses the prefix before single and double wildcards", () => {
    for (const wildcard of ["*", "**"]) {
      const input = row(`\`server/src/routes/${wildcard}\``);
      assert.deepEqual(rowVendorFiles(input), [`server/src/routes/${wildcard}`]);
      assert.equal(rowTouchesFile(input, "server/src/routes/x.ts"), true);
      assert.equal(rowTouchesFile(input, "server/src/routes/nested/x.ts"), true);
      assert.equal(rowTouchesFile(input, "server/src/routes-other/x.ts"), false);
    }
  });
});
