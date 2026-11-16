import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildManifest, resolvePageFile } from "./generate-llms-txt.mjs";

const scratchRoot = process.env.TMPDIR || os.tmpdir();

function withDocs(files, callback) {
  const docsDir = fs.mkdtempSync(path.join(scratchRoot, "llms-manifest-failstop-"));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const file = path.join(docsDir, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (content === "directory") fs.mkdirSync(file);
      else fs.writeFileSync(file, content);
    }
    return callback(docsDir);
  } finally {
    fs.rmSync(docsDir, { recursive: true, force: true });
  }
}

function nav(...pages) {
  return { navigation: { tabs: [{ tab: "T", groups: [{ group: "G", pages }] }] } };
}

function page(title, summary) {
  const fields = [];
  if (title !== undefined) fields.push(`title: ${title}`);
  if (summary !== undefined) fields.push(`summary: ${summary}`);
  return fields.length ? `---\n${fields.join("\n")}\n---\n\nbody\n` : "body\n";
}

test("fails closed with every missing page in navigation order", () => {
  withDocs({ "first.md": page("First"), "last.md": page("Last") }, (docsDir) => {
    assert.throws(
      () => buildManifest(nav("first", "missing/alpha", "missing/beta", "last"), docsDir),
      (error) => {
        assert.match(error.message, /missing\/alpha, missing\/beta/);
        assert.ok(!error.message.includes("last"), "diagnostic should list only missing pages");
        return true;
      },
    );
  });
});

test("does not return a partial manifest when any page is missing", () => {
  withDocs({ "first.md": page("First") }, (docsDir) => {
    let result;
    assert.throws(() => {
      result = buildManifest(nav("first", "missing"), docsDir);
    }, /broken links/);
    assert.equal(result, undefined);
  });
});

test("prefers mdx over md while emitting a relative md link", () => {
  withDocs(
    { "guide.mdx": page("MDX title", "from mdx"), "guide.md": page("MD title", "from md") },
    (docsDir) => {
      assert.equal(path.basename(resolvePageFile(docsDir, "guide")), "guide.mdx");
      const manifest = buildManifest(nav("guide"), docsDir);
      assert.match(manifest, /\[MDX title\]\(guide\.md\): from mdx/);
      assert.ok(!manifest.includes("MD title"));
    },
  );
});

test("treats an mdx-suffixed directory as non-file and falls back to md", () => {
  withDocs({ "guide.mdx": "directory", "guide.md": page("Fallback") }, (docsDir) => {
    assert.equal(path.basename(resolvePageFile(docsDir, "guide")), "guide.md");
    assert.match(buildManifest(nav("guide"), docsDir), /\[Fallback\]\(guide\.md\)/);
  });
});

test("renders an empty navigation as exactly the header and trailing newline", () => {
  withDocs({}, (docsDir) => {
    assert.equal(
      buildManifest({ navigation: { tabs: [] } }, docsDir),
      "# Myrmidon\n\n> The control plane for autonomous AI companies.\n\n",
    );
  });
});

test("uses the nav path when title is absent and omits the summary separator", () => {
  withDocs({ "plain/page.md": "body\n" }, (docsDir) => {
    assert.equal(buildManifest(nav("plain/page"), docsDir), "# Myrmidon\n\n> The control plane for autonomous AI companies.\n\n- [plain/page](plain/page.md)\n");
  });
});

test("preserves an explicitly empty title and omits an empty summary", () => {
  withDocs({ "empty.md": page("", "") }, (docsDir) => {
    assert.equal(buildManifest(nav("empty"), docsDir).split("\n")[4], "- [](empty.md)");
  });
});

test("adds a separator only for a non-empty summary", () => {
  withDocs({ "summary.md": page(undefined, "Useful summary") }, (docsDir) => {
    assert.match(buildManifest(nav("summary"), docsDir), /\[summary\]\(summary\.md\): Useful summary/);
  });
});

test("deduplicates pages across tabs and groups without changing first-seen order", () => {
  withDocs(
    { "one.md": page("One"), "two.md": page("Two"), "three.md": page("Three"), "sentinel.md": "OUT_OF_NAV" },
    (docsDir) => {
      const docsJson = {
        navigation: {
          tabs: [
            { tab: "A", groups: [{ group: "A1", pages: ["two", "one", "two"] }] },
            { tab: "B", groups: [{ group: "B1", pages: ["three", "one"] }] },
          ],
        },
      };
      const manifest = buildManifest(docsJson, docsDir);
      assert.deepEqual(
        [...manifest.matchAll(/\]\(([^)]+)\.md\)/g)].map((match) => match[1]),
        ["two", "one", "three"],
      );
      assert.ok(!manifest.includes("sentinel"));
      assert.ok(!manifest.includes("OUT_OF_NAV"));
    },
  );
});

test("keeps nested nav order across multiple groups", () => {
  withDocs({ "a.md": page("A"), "b.md": page("B"), "c.md": page("C") }, (docsDir) => {
    const docsJson = {
      navigation: {
        tabs: [
          { tab: "A", groups: [{ group: "first", pages: ["a"] }, { group: "second", pages: ["b"] }] },
          { tab: "B", groups: [{ group: "third", pages: ["c"] }] },
        ],
      },
    };
    const manifest = buildManifest(docsJson, docsDir);
    assert.ok(manifest.indexOf("](a.md)") < manifest.indexOf("](b.md)"));
    assert.ok(manifest.indexOf("](b.md)") < manifest.indexOf("](c.md)"));
  });
});

test("negative control proves the manifest assertion is sensitive", () => {
  withDocs({ "real.md": page("Real title") }, (docsDir) => {
    const manifest = buildManifest(nav("real"), docsDir);
    if (process.env.LLMS_FAILSTOP_NEGATIVE === "1") {
      assert.match(manifest, /\[Intentionally wrong title\]\(real\.md\)/);
      return;
    }
    assert.match(manifest, /\[Real title\]\(real\.md\)/);
    const childEnv = { ...process.env, LLMS_FAILSTOP_NEGATIVE: "1" };
    delete childEnv.NODE_TEST_CONTEXT;
    const negative = spawnSync(
      process.execPath,
      ["--test", fileURLToPath(import.meta.url)],
      { env: childEnv, encoding: "utf8" },
    );
    assert.equal(negative.status, 1, "mutated assertion must fail the suite");
    assert.match(negative.stdout, /Intentionally wrong title/);
  });
});
