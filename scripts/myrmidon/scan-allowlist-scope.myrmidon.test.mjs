import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  compileForbiddenPatterns,
  loadAllowlist,
  parseAddedLines,
  scan,
} from "./scan-diff.mjs";

// Build address-like values at runtime so the fixture does not expose them in source.
const ip = (...octets) => octets.join(".");
const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR
  ?? process.env.PAPERCLIP_SCRATCH_DIR
  ?? path.join(os.homedir(), ".cache", "myrmidon-test-scratch");

function fixture(entries, suffix = "allowlist.json") {
  fs.mkdirSync(scratchRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(scratchRoot, "scan-allowlist-scope-"));
  const file = path.join(directory, suffix);
  fs.writeFileSync(file, JSON.stringify(entries));
  return { directory, file };
}

function added(file, text) {
  return [{ file, line: 7, text }];
}

describe("scan allowlist path scope", () => {
  it("matches literal regex punctuation without treating it as syntax", () => {
    const { directory, file } = fixture({
      privateIp: [{ path: "docs/[v1](draft)?.md", reason: "documented fixture" }],
    });
    try {
      const allowlist = loadAllowlist(file);
      assert.deepEqual(scan(added("docs/[v1](draft)?.md", `host ${ip(10, 1, 2, 3)}`), {
        check: "private-ip",
        allowlist,
      }), []);
      assert.deepEqual(scan(added("docs/v1draft.md", `host ${ip(10, 1, 2, 3)}`), {
        check: "private-ip",
        allowlist,
      }), [{ file: "docs/v1draft.md", line: 7, rule: "private address in 10/8" }]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a single star inside one path segment", () => {
    const { directory, file } = fixture({
      privateIp: [{ path: "docs/*.md", reason: "flat documents" }],
    });
    try {
      const allowlist = loadAllowlist(file);
      assert.deepEqual(scan(added("docs/readme.md", `host ${ip(10, 2, 3, 4)}`), {
        check: "private-ip",
        allowlist,
      }), []);
      assert.deepEqual(scan(added("docs/nested/readme.md", `host ${ip(10, 2, 3, 4)}`), {
        check: "private-ip",
        allowlist,
      }), [{ file: "docs/nested/readme.md", line: 7, rule: "private address in 10/8" }]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lets a double star cross path segments but not a neighboring path", () => {
    const { directory, file } = fixture({
      privateIp: [{ path: "docs/**/fixture?.md", reason: "fixture documents" }],
    });
    try {
      const allowlist = loadAllowlist(file);
      assert.deepEqual(scan(added("docs/a/b/fixture1.md", `host ${ip(172, 20, 0, 5)}`), {
        check: "private-ip",
        allowlist,
      }), []);
      assert.deepEqual(scan(added("notes/a/b/fixture1.md", `host ${ip(172, 20, 0, 5)}`), {
        check: "private-ip",
        allowlist,
      }), [{ file: "notes/a/b/fixture1.md", line: 7, rule: "private address in 172.16/12" }]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats question mark as exactly one character", () => {
    const { directory, file } = fixture({
      privateIp: [{ path: "docs/v?.md", reason: "versioned document" }],
    });
    try {
      const allowlist = loadAllowlist(file);
      assert.deepEqual(scan(added("docs/v2.md", `host ${ip(192, 168, 1, 9)}`), {
        check: "private-ip",
        allowlist,
      }), []);
      assert.deepEqual(scan(added("docs/v10.md", `host ${ip(192, 168, 1, 9)}`), {
        check: "private-ip",
        allowlist,
      }), [{ file: "docs/v10.md", line: 7, rule: "private address in 192.168/16" }]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("applies the allowlist only to private-ip and leaves forbidden findings", () => {
    const { directory, file } = fixture({
      privateIp: [{ path: "docs/**", reason: "private address fixture" }],
    });
    try {
      const allowlist = loadAllowlist(file);
      const patterns = compileForbiddenPatterns("internal-host");
      assert.deepEqual(scan(added("docs/blocked.md", `internal-host ${ip(10, 3, 4, 5)}`), {
        check: "private-ip",
        allowlist,
      }), []);
      assert.deepEqual(scan(added("docs/blocked.md", `internal-host ${ip(10, 3, 4, 5)}`), {
        check: "forbidden",
        patterns,
        allowlist,
      }), [{ file: "docs/blocked.md", line: 7, rule: "forbidden pattern #1" }]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("skips test paths only when skipTests is true and preserves production lookalikes", () => {
    const lines = [
      { file: "tests/fixtures/test-suffix.txt", line: 1, text: `host ${ip(10, 4, 5, 6)}` },
      { file: "src/production.testimony.txt", line: 2, text: `host ${ip(10, 4, 5, 6)}` },
      { file: "src/fixtureship/service.ts", line: 3, text: `host ${ip(10, 4, 5, 6)}` },
      { file: "src/service.test.ts", line: 4, text: `host ${ip(10, 4, 5, 6)}` },
      { file: "src/fixtures/data.ts", line: 5, text: `host ${ip(10, 4, 5, 6)}` },
    ];
    assert.deepEqual(scan(lines, { check: "private-ip", skipTests: false }), [
      { file: "tests/fixtures/test-suffix.txt", line: 1, rule: "private address in 10/8" },
      { file: "src/production.testimony.txt", line: 2, rule: "private address in 10/8" },
      { file: "src/fixtureship/service.ts", line: 3, rule: "private address in 10/8" },
      { file: "src/service.test.ts", line: 4, rule: "private address in 10/8" },
      { file: "src/fixtures/data.ts", line: 5, rule: "private address in 10/8" },
    ]);
    assert.deepEqual(scan(lines, { check: "private-ip", skipTests: true }), [
      { file: "src/production.testimony.txt", line: 2, rule: "private address in 10/8" },
      { file: "src/fixtureship/service.ts", line: 3, rule: "private address in 10/8" },
    ]);
  });
});

describe("scan allowlist fixture validation", () => {
  it("rejects malformed JSON instead of allowing publication", () => {
    const { directory, file } = fixture(null);
    try {
      fs.writeFileSync(file, "{\"privateIp\":[");
      assert.throws(() => loadAllowlist(file), SyntaxError);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an allowlist entry without a reason", () => {
    const { directory, file } = fixture({ privateIp: [{ path: "docs/**" }] });
    try {
      assert.throws(() => loadAllowlist(file), /allowlist entry needs path and reason/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

it("parses the real scanner exports rather than duplicating its implementation", () => {
  assert.deepEqual(parseAddedLines("+++ b/docs/example.md\n@@ -0,0 +7,1 @@\n+content\n"), [
    { file: "docs/example.md", line: 7, text: "content" },
  ]);
});
