import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listFragments } from "./collect-fragments.mjs";

test("fragment discovery is ordered, filtered and read-only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fragment-order-"));
  try {
    const dir = path.join(root, "docs/myrmidon/changes");
    assert.deepEqual(listFragments(root), []);
    assert.equal(fs.existsSync(dir), false);

    fs.mkdirSync(dir, { recursive: true });
    const entries = [
      ["z.md", "last\n"],
      ["readME.md", "ignored mixed case\n"],
      ["a.md.bak", "ignored backup\n"],
      ["a.md", "lowercase\n"],
      ["README.md", "ignored uppercase\n"],
      ["Z.md", "uppercase\n"],
      ["A.MD", "ignored extension\n"],
      ["10.md", "numeric\n"],
    ];
    for (const [name, contents] of entries) fs.writeFileSync(path.join(dir, name), contents);

    const expected = ["10.md", "Z.md", "a.md", "z.md"];
    assert.deepEqual(listFragments(root), expected);
    assert.deepEqual(listFragments(root), expected);
    assert.deepEqual(new Set(fs.readdirSync(dir)), new Set(entries.map(([name]) => name)));
    for (const [name, contents] of entries) {
      assert.deepEqual(fs.readFileSync(path.join(dir, name)), Buffer.from(contents));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
