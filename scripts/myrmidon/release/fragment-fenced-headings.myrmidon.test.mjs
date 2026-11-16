import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildFragment, classifyDoc, parseHunks } from "./fragments-from-diff.mjs";

const GIT = "/usr/bin/git";
const SETTINGS = `# Settings

## Track 6 - models

| Variable | Function | Default | What it does | How to disable |
|---|---|---|---|---|
| \`MYRMIDON_MODEL\` | M | \`x\` | Model | unset |
`;
const REL = "docs/myrmidon/SETTINGS.md";
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache", "myrmidon-tests");
const gitEnv = {
  PATH: "/usr/bin:/bin",
  GIT_AUTHOR_NAME: "fragment-test",
  GIT_AUTHOR_EMAIL: "fragment-test@example.invalid",
  GIT_COMMITTER_NAME: "fragment-test",
  GIT_COMMITTER_EMAIL: "fragment-test@example.invalid",
};

function git(cwd, ...args) {
  return execFileSync(GIT, args, { cwd, env: gitEnv, encoding: "utf8", timeout: 10000 });
}

function fixture(edit) {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "fragment-fenced-headings-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    fs.mkdirSync(path.join(dir, path.dirname(REL)), { recursive: true });
    fs.writeFileSync(path.join(dir, REL), SETTINGS);
    git(dir, "add", REL);
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(dir, REL), edit(SETTINGS));
    git(dir, "add", REL);
    git(dir, "commit", "-q", "-m", "edit");
    const base = git(dir, "show", `main:${REL}`);
    const head = git(dir, "show", `feature:${REL}`);
    const diff = git(dir, "diff", "--no-ext-diff", "-U0", "main", "feature", "--", REL);
    return { dir, base, head, diff };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function withFixture(edit, check) {
  const f = fixture(edit);
  try {
    const hunks = parseHunks(f.diff);
    const original = structuredClone(hunks);
    const result = classifyDoc("settings-en", f.base, f.head, hunks);
    assert.deepEqual(hunks, original);
    assert.deepEqual(classifyDoc("settings-en", f.base, f.head, hunks), result);
    assert.deepEqual(hunks, original);
    check({ ...f, hunks, result });
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
}

describe("fragment classification ignores headings inside fenced additions", () => {
  it("keeps backtick-fenced ## and # text in one append body", () => {
    withFixture(
      (text) => `${text}\n\n\`\`\`md\n## A heading in a code sample\n# A level-one heading in a code sample\n\`\`\`\n`,
      ({ base, head, diff, hunks, result }) => {
        assert.equal(hunks.length, 1);
        assert.deepEqual(result.news, []);
        assert.deepEqual(result.unsupported, []);
        assert.equal(result.rows.length, 0);
        assert.equal(result.appends.length, 1);
        assert.equal(result.appends[0].section, "Track 6 - models");
        assert.equal(result.appends[0].body, "```md\n## A heading in a code sample\n# A level-one heading in a code sample\n```");
        assert.equal(buildFragment({ "settings-en": result }), "## settings-en-append\n\n<!-- section: Track 6 - models -->\n\n```md\n## A heading in a code sample\n# A level-one heading in a code sample\n```\n");
        assert.deepEqual(parseHunks(diff), hunks);
        assert.equal(base.includes("A heading in a code sample"), false);
        assert.equal(head.includes("A heading in a code sample"), true);
      },
    );
  });

  it("keeps tilde-fenced ## and # text in one append body", () => {
    withFixture(
      (text) => `${text}\n\n~~~yaml\n## A heading in YAML\n# A comment in YAML\n~~~\n`,
      ({ result }) => {
        assert.deepEqual(result.news, []);
        assert.deepEqual(result.unsupported, []);
        assert.equal(result.appends.length, 1);
        assert.equal(result.appends[0].section, "Track 6 - models");
        assert.equal(result.appends[0].body, "~~~yaml\n## A heading in YAML\n# A comment in YAML\n~~~");
        assert.equal(buildFragment({ "settings-en": result }), "## settings-en-append\n\n<!-- section: Track 6 - models -->\n\n~~~yaml\n## A heading in YAML\n# A comment in YAML\n~~~\n");
      },
    );
  });

  it("classifies a real outside-fence ## as a new section and is repeatable", () => {
    withFixture(
      (text) => `${text}\n\n## New model section\n\nNew model prose.\n`,
      ({ base, head, hunks, result }) => {
        assert.equal(result.appends.length, 0);
        assert.equal(result.unsupported.length, 0);
        assert.deepEqual(result.news, [{ after: "Track 6 - models", occurrence: null, body: "### New model section\n\nNew model prose." }]);
        assert.equal(buildFragment({ "settings-en": result }), "## settings-en-new\n\n<!-- after: Track 6 - models -->\n\n### New model section\n\nNew model prose.\n");
        const second = classifyDoc("settings-en", base, head, hunks);
        assert.deepEqual(second, result);
      },
    );
  });

  it("reports an unsupported edit while preserving the unchanged diff input", () => {
    withFixture(
      (text) => text.replace("# Settings", "# Changed settings"),
      ({ diff, hunks, result }) => {
        assert.equal(result.news.length, 0);
        assert.equal(result.appends.length, 0);
        assert.equal(result.unsupported.length, 1);
        assert.match(result.unsupported[0], /edits or deletes existing text/);
        assert.deepEqual(parseHunks(diff), hunks);
      },
    );
  });
});
