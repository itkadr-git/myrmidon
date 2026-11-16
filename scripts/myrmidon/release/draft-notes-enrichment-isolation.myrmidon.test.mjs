import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../draft-stable-notes.sh", import.meta.url));
const version = "2026.100.0-beta.0";
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

function run(subjects, fixture, { skip = false, fail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "notes-isolation-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { env: gitEnv, stdio: "pipe" });
    git("init", "-q", "-b", "master");
    git("commit", "--allow-empty", "-m", "baseline");
    git("tag", "v2026.99.0");
    for (const subject of subjects) git("commit", "--allow-empty", "-m", subject);
    git("tag", `beta/v${version}`);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "calls");
    const body = join(dir, "body");
    const sentinel = join(dir, "sentinel");
    writeFileSync(log, "");
    writeFileSync(body, fixture);
    writeFileSync(join(bin, "gh"), '#!/bin/bash\nprintf "%s\\0" "$@" >> "$GH_CALLS"\nprintf "\\n" >> "$GH_CALLS"\ncat "$GH_BODY"\nexit "$GH_EXIT"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_CALLS: log, GH_BODY: body, GH_EXIT: fail ? "1" : "0", SENTINEL: sentinel };
    delete env.BASH_ENV;
    delete env.DRAFT_NOTES_SKIP_PR_ENRICHMENT;
    if (skip) env.DRAFT_NOTES_SKIP_PR_ENRICHMENT = "1";
    const out = join(dir, "draft.md");
    const result = spawnSync("bash", [script, version, "--repo-dir", dir, "--out", out], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split("\0").filter(Boolean));
    const notes = readFileSync(out, "utf8");
    const section = notes.split("## Features\n\n")[1]?.split("\n\n")[0] ?? "";
    return { calls, lines: section.split("\n"), sentinel: existsSync(sentinel) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const call = (id) => ["pr", "view", String(id), "--json", "body", "--jq", ".body"];

test("terminal PR suffix invokes gh with exact argv and nests at most three bullets", () => {
  const result = run(["feat: widgets (#42)"], "## What Changed\n- one\n- two\n- three\n- four\n## Risks\n- excluded\n");
  assert.deepEqual(result.calls, [call(42)]);
  assert.deepEqual(result.lines, ["- feat: widgets (#42)", "  > - one", "  > - two", "  > - three"]);
});

test("What Changed stops at the next heading even when fewer than three bullets", () => {
  const result = run(["feat: boundary (#42)"], "## What Changed\n- included\n## Risks\n- excluded\n");
  assert.deepEqual(result.calls, [call(42)]);
  assert.deepEqual(result.lines, ["- feat: boundary (#42)", "  > - included"]);
});

test("nonterminal and embedded references do not invoke gh", () => {
  const result = run(["feat: embedded (#42) later", "feat: see #43"], "- leaked\n");
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.lines, ["- feat: see #43", "- feat: embedded (#42) later"]);
});

test("fallback retains only the first two nonempty prose lines", () => {
  const result = run(["feat: fallback (#42)"], "# Heading\n\n> quote\n<!-- comment -->\nfirst line\nsecond line\nthird line\n");
  assert.deepEqual(result.calls, [call(42)]);
  assert.deepEqual(result.lines, ["- feat: fallback (#42)", "  > first line", "  > second line"]);
});

test("empty gh response preserves skeleton", () => {
  const result = run(["feat: empty (#42)"], "");
  assert.deepEqual(result.calls, [call(42)]);
  assert.deepEqual(result.lines, ["- feat: empty (#42)"]);
});

test("gh failure with empty output preserves skeleton and succeeds", () => {
  const result = run(["feat: offline (#42)"], "", { fail: true });
  assert.deepEqual(result.calls, [call(42)]);
  assert.deepEqual(result.lines, ["- feat: offline (#42)"]);
});

test("explicit skip prevents gh calls", () => {
  const result = run(["feat: skip (#42)"], "## What Changed\n- forbidden\n", { skip: true });
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.lines, ["- feat: skip (#42)"]);
});

test("shell substitution syntax in a subject remains literal", () => {
  const subject = "feat: $(touch $SENTINEL) and `touch $SENTINEL` (#42)";
  const result = run([subject], "## What Changed\n- safe\n");
  assert.deepEqual(result.calls, [call(42)]);
  assert.deepEqual(result.lines, [`- ${subject}`, "  > - safe"]);
  assert.equal(result.sentinel, false);
});

test("multiple terminal references invoke gh in output order", () => {
  const result = run(["feat: first (#41)", "feat: second (#42)"], "## What Changed\n- shared\n");
  assert.deepEqual(result.calls, [call(42), call(41)]);
  assert.deepEqual(result.lines, ["- feat: second (#42)", "  > - shared", "- feat: first (#41)", "  > - shared"]);
});
