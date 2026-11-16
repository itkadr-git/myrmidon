import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const script = join(repoRoot, "scripts", "draft-stable-notes.sh");

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "topology-test",
      GIT_AUTHOR_EMAIL: "topology@example.invalid",
      GIT_COMMITTER_NAME: "topology-test",
      GIT_COMMITTER_EMAIL: "topology@example.invalid",
    },
  });
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "myrmidon-notes-topology-"));
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

function commit(dir, subject) {
  git(dir, "commit", "--allow-empty", "-m", subject);
}

function tag(dir, name, annotated = false) {
  git(dir, "tag", ...(annotated ? ["-a", "-m", `release ${name}`] : []), name);
}

function draft(dir, version) {
  const out = join(dir, "draft.md");
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, "gh"),
    "#!/usr/bin/env sh\nprintf '%s\\n' network-must-not-be-used >&2\nexit 91\n",
    { mode: 0o755 }
  );
  const result = execFileSync(
    "bash",
    [script, version, "--repo-dir", dir, "--out", out],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        DRAFT_NOTES_SKIP_PR_ENRICHMENT: "1",
      },
    }
  );
  return { body: readFileSync(out, "utf8"), stdout: result };
}

function withRepo(callback) {
  const dir = repo();
  try {
    callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertNotes(body, expected, absent = []) {
  const subjects = [...body.matchAll(/^- (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(subjects.slice().sort(), expected.slice().sort());
  for (const subject of absent) assert.doesNotMatch(body, new RegExp(escapeRegExp(subject)));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("uses a lightweight beta and annotated stable as the exact baseline", () => {
  withRepo((dir) => {
    commit(dir, "feat: shipped (#1)");
    tag(dir, "v2026.100.0", true);
    commit(dir, "feat: selected (#2)");
    commit(dir, "fix: selected fix (#3)");
    tag(dir, "beta/v2026.101.0-beta.0");

    const { body } = draft(dir, "2026.101.0-beta.0");
    assert.match(body, /baseline: v2026\.100\.0/);
    assertNotes(body, ["feat: selected (#2)", "fix: selected fix (#3)"], ["feat: shipped (#1)"]);
  });
});

test("ignores an unrelated stable tag on an orphan branch", () => {
  withRepo((dir) => {
    commit(dir, "feat: shipped (#10)");
    tag(dir, "v2026.100.0");
    commit(dir, "feat: selected after unrelated (#11)");
    tag(dir, "beta/v2026.101.0-beta.0", true);
    git(dir, "checkout", "--orphan", "unrelated");
    commit(dir, "feat: unrelated stable (#12)");
    tag(dir, "v2026.999.0", true);
    git(dir, "checkout", "-q", "main");

    const { body } = draft(dir, "2026.101.0-beta.0");
    assertNotes(body, ["feat: selected after unrelated (#11)"], ["feat: unrelated stable (#12)"]);
    assert.match(body, /baseline: v2026\.100\.0/);
  });
});

test("skips a stable tag equal to the source and selects its prior stable", () => {
  withRepo((dir) => {
    commit(dir, "feat: old shipped (#20)");
    tag(dir, "v2026.100.0");
    commit(dir, "feat: source already stable (#21)");
    tag(dir, "v2026.200.0", true);
    tag(dir, "beta/v2026.200.1-beta.0");

    const { body } = draft(dir, "2026.200.1-beta.0");
    assert.match(body, /baseline: v2026\.100\.0/);
    assertNotes(body, ["feat: source already stable (#21)"], ["feat: old shipped (#20)"]);
  });
});

test("skips a stable descendant of the source", () => {
  withRepo((dir) => {
    commit(dir, "feat: shipped (#30)");
    tag(dir, "v2026.100.0", true);
    commit(dir, "feat: beta source (#31)");
    tag(dir, "beta/v2026.101.0-beta.0", true);
    commit(dir, "feat: stable descendant (#32)");
    tag(dir, "v2026.200.0");

    const { body } = draft(dir, "2026.101.0-beta.0");
    assert.match(body, /baseline: v2026\.100\.0/);
    assertNotes(body, ["feat: beta source (#31)"], ["feat: stable descendant (#32)", "feat: shipped (#30)"]);
  });
});

test("uses a side-branch stable merge-base without shipping side-branch work", () => {
  withRepo((dir) => {
    commit(dir, "feat: common shipped (#40)");
    const base = git(dir, "rev-parse", "--short", "HEAD").trim();
    git(dir, "checkout", "-q", "-b", "candidate");
    commit(dir, "docs: candidate-only release text (#41)");
    tag(dir, "v2026.200.0", true);
    git(dir, "checkout", "-q", "main");
    commit(dir, "feat: source after candidate split (#42)");
    tag(dir, "beta/v2026.201.0-beta.0");

    const { body } = draft(dir, "2026.201.0-beta.0");
    assert.ok(body.includes(`baseline: v2026.200.0 (merge-base ${base})`));
    assertNotes(body, ["feat: source after candidate split (#42)"], ["feat: common shipped (#40)", "docs: candidate-only release text (#41)"]);
  });
});

test("falls back to an annotated previous beta when no stable is usable", () => {
  withRepo((dir) => {
    commit(dir, "feat: first beta (#50)");
    tag(dir, "beta/v2026.100.0-beta.0", true);
    commit(dir, "fix: second beta (#51)");
    tag(dir, "beta/v2026.101.0-beta.0");

    const { body } = draft(dir, "2026.101.0-beta.0");
    assert.match(body, /baseline: beta\/v2026\.100\.0-beta\.0/);
    assertNotes(body, ["fix: second beta (#51)"], ["feat: first beta (#50)"]);
  });
});

test("uses full root history and excludes a merge commit from notes", () => {
  withRepo((dir) => {
    commit(dir, "feat: root release work (#60)");
    tag(dir, "beta/v2026.100.0-beta.0");

    git(dir, "checkout", "-q", "-b", "feature");
    commit(dir, "feat: merged feature (#61)");
    git(dir, "checkout", "-q", "main");
    commit(dir, "fix: main fix (#62)");
    git(dir, "merge", "--no-ff", "-m", "Merge feature branch", "feature");
    tag(dir, "beta/v2026.101.0-beta.0", true);

    const { body } = draft(dir, "2026.101.0-beta.0");
    assertNotes(body, ["feat: merged feature (#61)", "fix: main fix (#62)"], ["feat: root release work (#60)", "Merge feature branch"]);
  });
});

test("uses the full history when the beta source itself is the repository root", () => {
  withRepo((dir) => {
    commit(dir, "feat: first ever release (#70)");
    tag(dir, "beta/v2026.100.0-beta.0");

    const { body, stdout } = draft(dir, "2026.100.0-beta.0");
    assert.match(stdout, /full history/);
    assert.match(body, /baseline: the beginning of history/);
    assertNotes(body, ["feat: first ever release (#70)"]);
  });
});
