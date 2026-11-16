import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main, STATE_ENV } from "./vendor-share-notes.mjs";

test("flat and nested states produce the same independent CLI results", () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || os.homedir();
  const dir = fs.mkdtempSync(path.join(scratch, "vendor-state-equivalence-"));
  const originalEnv = process.env[STATE_ENV];
  try {
    const summary = { inherited: 75, totalFiles: 100, share: 0.75 };
    const files = new Map([
      [path.join(dir, "flat.json"), JSON.stringify(summary)],
      [path.join(dir, "nested.json"), JSON.stringify({ summary })],
      [path.join(dir, "other.json"), JSON.stringify({ inherited: 40, totalFiles: 100, share: 0.4 })],
      [path.join(dir, "previous.md"), "## Vendor-derived files\n\nVendor-derived files: 50 of 100 (50.00%)\n"],
    ]);
    for (const [file, content] of files) fs.writeFileSync(file, content);
    const [flat, nested, other, previous] = files.keys();
    const missing = path.join(dir, "missing.md");
    const run = (state, body) => {
      process.env[STATE_ENV] = state;
      let out = "";
      let err = "";
      const code = main(["--previous-tag", "myr-v1.6.4", "--previous-body", body], {
        out: (value) => { out += value; },
        err: (value) => { err += value; },
      });
      return { code, out, err };
    };
    const delta = "Vendor-derived files: 75 of 100 (75.00%), Δ to myr-v1.6.4: +25.00 pp (+25 files)\n";
    const noData = "Vendor-derived files: 75 of 100 (75.00%), Δ to myr-v1.6.4: нет данных (no vendor-share line in that release)\n";
    const changed = "Vendor-derived files: 40 of 100 (40.00%), Δ to myr-v1.6.4: -10.00 pp (-10 files)\n";
    const expect = (result, out) => {
      assert.equal(result.code, 0);
      assert.equal(result.err, "");
      assert.equal(result.out, out);
      assert.match(result.out, /[^\n]\n$/);
    };
    const flatDelta = run(flat, previous);
    const nestedDelta = run(nested, previous);
    expect(flatDelta, delta);
    expect(nestedDelta, delta);
    assert.equal(flatDelta.out, nestedDelta.out);
    const flatMissing = run(flat, missing);
    const nestedMissing = run(nested, missing);
    expect(flatMissing, noData);
    expect(nestedMissing, noData);
    assert.equal(flatMissing.out, nestedMissing.out);
    expect(run(other, previous), changed);
    expect(run(nested, previous), delta);
    for (const [file, content] of files) assert.equal(fs.readFileSync(file, "utf8"), content);
    assert.equal(fs.existsSync(missing), false);
  } finally {
    if (originalEnv === undefined) delete process.env[STATE_ENV];
    else process.env[STATE_ENV] = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
