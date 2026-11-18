import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "./cut-rc.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function exercise(dryRun) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cut-ancestor-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Release test");
    git(root, "config", "user.email", "test@example.com");
    const dir = path.join(root, "docs/myrmidon");
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, section] of [["CHANGELOG.md", "Unreleased"], ["CHANGELOG.ru.md", "Без выпуска"]]) {
      fs.writeFileSync(path.join(dir, file), `# Changelog\n\n## ${section}\n\n## 1.7.0\n\n### Feature (X)\n- shipped\n\n## 1.6.0\n\n- old\n`);
    }
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "OPE-100: delivery");
    const ancestor = git(root, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(root, "tip.txt"), "second commit\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "second commit");
    const tip = git(root, "rev-parse", "HEAD");
    assert.match(ancestor, /^[0-9a-f]{40}$/);
    assert.notEqual(ancestor, tip);

    const boardCalls = [];
    const ciCalls = [];
    const errors = [];
    const fetchBoard = async (_api, pathname) => {
      boardCalls.push(pathname);
      if (pathname === "/api/companies/c1/labels") return [{ id: "label-17", name: "1.7" }];
      if (pathname === "/api/companies/c1/issues?labelId=label-17&limit=100&offset=0&view=compact") {
        return [{ id: "i1", identifier: "OPE-100", status: "done", title: "delivery" }];
      }
      if (pathname === "/api/issues/i1/work-products") return [];
      throw new Error(`unexpected board request: ${pathname}`);
    };
    const code = await run(
      { version: "1.7.0", rc: "25", root, branch: "main", sha: ancestor, dryRun },
      {
        api: { apiUrl: "http://board.invalid", apiKey: "unused", companyId: "c1" },
        fetchBoard,
        ciStatus: (repoRoot, options) => { ciCalls.push({ repoRoot, branch: options.branch, sha: options.sha }); return { ok: true }; },
        prDetails: () => { throw new Error("unexpected GitHub request"); },
        log: () => {}, err: (message) => errors.push(message),
      },
    );
    assert.equal(code, 0, errors.join("\n"));
    assert.deepEqual(ciCalls, [{ repoRoot: root, branch: "main", sha: ancestor }]);
    assert.deepEqual(boardCalls, [
      "/api/companies/c1/labels",
      "/api/companies/c1/issues?labelId=label-17&limit=100&offset=0&view=compact",
      "/api/issues/i1/work-products",
    ]);
    assert.equal(git(root, "rev-parse", "main"), tip);
    assert.equal(git(root, "tag", "-l", "myr-v1.7.0-rc.25"), dryRun ? "" : "myr-v1.7.0-rc.25");
    if (!dryRun) assert.equal(git(root, "rev-parse", "refs/tags/myr-v1.7.0-rc.25^{commit}"), ancestor);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("run tags the explicit ancestor, not the main tip", async () => {
  await exercise(false);
});

test("dry run checks the explicit ancestor without creating a tag", async () => {
  await exercise(true);
});
