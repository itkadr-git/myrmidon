import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "./cut-rc.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cut-override-dryrun-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "release test");
    const dir = path.join(root, "docs/myrmidon");
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, unreleased] of [["CHANGELOG.md", "Unreleased"], ["CHANGELOG.ru.md", "Без выпуска"]]) {
      fs.writeFileSync(path.join(dir, file), `# Changelog\n\n## ${unreleased}\n\n## 1.7.0\n\n### Feature (X)\n- shipped\n\n## 1.6.0\n\n- old\n`);
    }
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "OPE-100: delivered");
    return root;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

for (const failPost of [false, true]) {
  test(`run: dry-run override ${failPost ? "refuses a failed journal POST" : "journals without creating a tag"}`, async () => {
    const root = makeRepo();
    try {
      const calls = [];
      const errors = [];
      const issues = [
        { id: "i1", identifier: "OPE-100", status: "done", title: "delivered" },
        { id: "i2", identifier: "OPE-102", status: "in_progress", title: "still working" },
      ];
      const fetchBoard = async (api, pathname, init = {}) => {
        calls.push({ pathname, init });
        if (pathname === "/api/companies/c1/labels") return [{ id: "label-17", name: "1.7", companyId: "c1" }];
        if (pathname.startsWith("/api/companies/c1/issues?")) return issues;
        if (pathname === "/api/issues/i1/work-products" || pathname === "/api/issues/i2/work-products") return [];
        if (pathname === "/api/issues/OPE-12408") return { id: "j1", identifier: "OPE-12408" };
        if (pathname === "/api/issues/j1/comments" && init.method === "POST") {
          if (failPost) throw new Error("HTTP 500 journal unavailable");
          return { id: "comment-1" };
        }
        throw new Error(`Unexpected board request: ${pathname}`);
      };
      const code = await run(
        { version: "1.7.0", rc: "25", root, boardLabel: "1.7", override: "release list is stale", journal: "OPE-12408", dryRun: true },
        { api: { apiUrl: "http://board.invalid", apiKey: "fake", companyId: "c1" }, fetchBoard, root, ciStatus: () => ({ ok: true }), log: () => {}, err: (message) => errors.push(message) },
      );
      assert.equal(code, failPost ? 1 : 0);
      const posts = calls.filter(({ init }) => init.method === "POST");
      assert.equal(posts.length, 1);
      assert.equal(posts[0].pathname, "/api/issues/j1/comments");
      const body = JSON.parse(posts[0].init.body).body;
      assert.match(body, /myr-v1\.7\.0-rc\.25/);
      assert.match(body, /release list is stale/);
      assert.match(body, /OPE-102 "still working" \[in_progress\]/);
      assert.equal(git(root, "tag", "-l"), "");
      if (failPost) assert.match(errors.join("\n"), /cannot post the override record to OPE-12408: HTTP 500 journal unavailable/);
      else assert.deepEqual(errors, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
