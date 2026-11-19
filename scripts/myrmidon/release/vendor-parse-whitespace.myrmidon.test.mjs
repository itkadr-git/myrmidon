import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseShareLine, STATE_ENV } from "./vendor-share-notes.mjs";

test("parseShareLine accepts whitespace around percent and derives share from counts", () => {
  const expected = { inherited: 1, totalFiles: 3, share: 1 / 3 };
  for (const percentage of ["33.33 % ", "33.33\t%\t", "99.99%", "33%", "33.33%"]) {
    const body = `## Release notes\n\nVendor-derived files: 1 of 3 (${percentage})\n\nOther notes`;
    assert.deepEqual(parseShareLine(body), expected, percentage);
  }
});

test("parseShareLine rejects malformed percentage, closing parenthesis, and marker", () => {
  for (const body of [
    "Vendor-derived files: 1 of 3 (nope % )",
    "Vendor-derived files: 1 of 3 (33.33 % ",
    "Vendor files: 1 of 3 (33.33 % )",
  ]) {
    assert.equal(parseShareLine(body), null, body);
  }
});

test("CLI computes the delta from whitespace notes using offline state", () => {
  const dir = fs.mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.TMPDIR || os.homedir(), "vendor-whitespace-"));
  try {
    const state = path.join(dir, "state.json");
    const body = path.join(dir, "previous.md");
    fs.writeFileSync(state, JSON.stringify({ inherited: 2, totalFiles: 3, share: 2 / 3 }));
    fs.writeFileSync(body, "## Previous release\nVendor-derived files: 1 of 3 (99.99\t%\t)\n");
    const cli = fileURLToPath(new URL("./vendor-share-notes.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [cli, "--previous-tag", "myr-v1.6.4", "--previous-body", body], {
      encoding: "utf8",
      env: { ...process.env, [STATE_ENV]: state },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "Vendor-derived files: 2 of 3 (66.67%), Δ to myr-v1.6.4: +33.33 pp (+1 files)\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
