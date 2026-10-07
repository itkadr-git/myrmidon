import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H1a): docker/bot-runtime/git-reference/clone-args.js —
// the pure argv reader the git wrapper routes GitHub clones through. The
// command forms are the ones the fleet's clones took on 06.10 (https and
// scp-style ssh, tokens in the URL, --filter=blob:none, --depth, --mirror,
// -b/--branch, a target directory, --) plus the neighbours the wrapper must
// keep sending to the real git. Placeholder owners, repositories and tokens
// only; nothing here touches the network or the filesystem outside a temp dir.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MODULE_SRC = path.join(ROOT, "docker/bot-runtime/git-reference/clone-args.js");

// A credential that must never survive the parse, in the shape of a GitHub PAT.
const TOKEN = "ghp_ExampleOnly0000000000000000000000000000";

/** The result is exactly these six fields — the shapes BOT-DISK parts read. */
const FIELDS = ["dir", "hadUserinfo", "ignoredFlags", "kind", "owner", "repo"];

let tmp;
let lib;
let parseCloneArgs;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clone-args-test-"));
  // The image loads the module as CommonJS next to `git` (no package.json
  // above /opt); in this repo the root package.json is a module, so the test
  // loads a .cjs copy the same way git-reference.test.mjs loads the wrapper.
  const copy = path.join(tmp, "clone-args.cjs");
  fs.copyFileSync(MODULE_SRC, copy);
  lib = createRequire(import.meta.url)(copy);
  parseCloneArgs = lib.parseCloneArgs;
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const github = (owner, repo, dir, ignoredFlags = [], hadUserinfo = false) => ({
  owner,
  repo,
  dir,
  ignoredFlags,
  hadUserinfo,
  kind: "github",
});

const foreign = (dir, ignoredFlags = [], hadUserinfo = false) => ({
  owner: null,
  repo: null,
  dir,
  ignoredFlags,
  hadUserinfo,
  kind: "foreign",
});

// [what the command is, argv after `git`, expected parse (null: not our case)]
const FORMS = [
  ["https with .git", ["clone", "https://github.com/itkadr-git/myrmidon.git"], github("itkadr-git", "myrmidon", "myrmidon")],
  [
    "https without .git and a target directory",
    ["clone", "https://github.com/itkadr-git/myrmidon", "myrmidon-1.6.5"],
    github("itkadr-git", "myrmidon", "myrmidon-1.6.5"),
  ],
  ["https without .git, directory derived", ["clone", "https://github.com/itkadr-git/myrmidon"], github("itkadr-git", "myrmidon", "myrmidon")],
  ["https with a trailing slash", ["clone", "https://github.com/itkadr-git/myrmidon/"], github("itkadr-git", "myrmidon", "myrmidon")],
  [
    "https with a token in the userinfo",
    ["clone", `https://x-access-token:${TOKEN}@github.com/itkadr-git/myrmidon.git`],
    github("itkadr-git", "myrmidon", "myrmidon", [], true),
  ],
  ["https with the token as the user", ["clone", `https://${TOKEN}@github.com/itkadr-git/myrmidon.git`], github("itkadr-git", "myrmidon", "myrmidon", [], true)],
  ["scp-style ssh", ["clone", "git@github.com:itkadr-git/myrmidon.git"], github("itkadr-git", "myrmidon", "myrmidon")],
  ["ssh:// URL", ["clone", "ssh://git@github.com/itkadr-git/myrmidon.git"], github("itkadr-git", "myrmidon", "myrmidon")],
  [
    "scp-style with -b and --single-branch",
    ["clone", "-b", "release/1.6.5", "--single-branch", "git@github.com:itkadr-git/myrmidon.git"],
    github("itkadr-git", "myrmidon", "myrmidon"),
  ],
  [
    "--filter=blob:none with a target directory",
    ["clone", "--filter=blob:none", "https://github.com/itkadr-git/myrmidon.git", "dst"],
    github("itkadr-git", "myrmidon", "dst", ["--filter=blob:none"]),
  ],
  [
    "--filter whose value is the next argument",
    ["clone", "--filter", "blob:none", "https://github.com/itkadr-git/myrmidon.git"],
    github("itkadr-git", "myrmidon", "myrmidon", ["--filter"]),
  ],
  ["--depth 1", ["clone", "--depth", "1", "https://github.com/itkadr-git/myrmidon.git"], github("itkadr-git", "myrmidon", "myrmidon", ["--depth"])],
  [
    "--depth=1 with -b and a target directory",
    ["clone", "--depth=1", "-b", "release/1.6.5", "git@github.com:itkadr-git/myrmidon.git", "ws"],
    github("itkadr-git", "myrmidon", "ws", ["--depth=1"]),
  ],
  ["--mirror", ["clone", "--mirror", "https://github.com/itkadr-git/myrmidon.git"], github("itkadr-git", "myrmidon", "myrmidon", ["--mirror"])],
  [
    "--bare with a legal target",
    ["clone", "--bare", "git@github.com:itkadr-git/myrmidon.git", "base.git"],
    github("itkadr-git", "myrmidon", "base.git", ["--bare"]),
  ],
  [
    "every dropped flag at once",
    ["clone", "--bare", "--filter=blob:limit=1m", "--depth=1", "https://github.com/itkadr-git/myrmidon.git", "merged"],
    github("itkadr-git", "myrmidon", "merged", ["--bare", "--filter=blob:limit=1m", "--depth=1"]),
  ],
  [
    "the -- separator before the repository",
    ["clone", "--", "https://github.com/itkadr-git/myrmidon.git", "dir"],
    github("itkadr-git", "myrmidon", "dir"),
  ],
  [
    "a dropped flag after the repository",
    ["clone", "https://github.com/itkadr-git/myrmidon.git", "--depth", "1"],
    github("itkadr-git", "myrmidon", "myrmidon", ["--depth"]),
  ],
  ["mixed case in the URL", ["clone", "https://github.com/Itkadr-Git/Myrmidon.git"], github("itkadr-git", "myrmidon", "Myrmidon")],
  [
    "global options before the subcommand",
    ["-C", "/x", "-c", "core.hooksPath=/dev/null", "clone", "https://github.com/itkadr-git/myrmidon.git"],
    github("itkadr-git", "myrmidon", "myrmidon"),
  ],
  ["-o whose value is not a directory", ["clone", "-o", "upstream", "https://github.com/itkadr-git/myrmidon.git"], github("itkadr-git", "myrmidon", "myrmidon")],
  [
    "unknown flags do not break the parse",
    ["clone", "--recurse-submodules", "--myrmidon-unknown-flag", "git@github.com:itkadr-git/myrmidon.git"],
    github("itkadr-git", "myrmidon", "myrmidon"),
  ],
  ["https on another host", ["clone", "https://gitlab.com/itkadr/myrmidon.git"], foreign("myrmidon")],
  ["scp-style ssh on another host", ["clone", "git@gitlab.com:group/repo.git"], foreign("repo")],
  ["another host with a token in the userinfo", ["clone", `https://user:${TOKEN}@gitlab.com/group/repo.git`, "dst"], foreign("dst", [], true)],
  ["ssh:// on another host", ["clone", "ssh://git@git.example.com/group/repo.git"], foreign("repo")],
  ["a local mirror path", ["clone", "/srv/mirrors/thing.git"], foreign("thing")],
  ["a file:// URL", ["clone", "file:///srv/mirrors/thing.git", "x"], foreign("x")],
  ["a GitHub URL that names no repository", ["clone", "https://github.com/itkadr-git"], foreign("itkadr-git")],
  ["another subcommand", ["fetch", "--all"], null],
  ["clone without a repository", ["clone", "--depth", "1"], null],
  ["git --version", ["--version"], null],
  ["empty argv", [], null],
];

describe("clone-args", () => {
  it("reads every form of the fleet's clones and leaves the rest to the real git", () => {
    for (const [name, argv, expected] of FORMS) {
      assert.deepEqual(parseCloneArgs(argv), expected, name);
    }
    assert.ok(FORMS.length >= 16, `expected the 15 field forms and then some, got ${FORMS.length}`);
  });

  it("returns exactly the six documented fields, typed", () => {
    for (const [name, argv] of FORMS) {
      const result = parseCloneArgs(argv);
      if (result === null) continue;
      assert.deepEqual(Object.keys(result).sort(), FIELDS, name);
      for (const field of ["owner", "repo", "dir"]) {
        assert.ok(typeof result[field] === "string" || result[field] === null, `${name}: ${field}`);
      }
      assert.ok(Array.isArray(result.ignoredFlags) && result.ignoredFlags.every((f) => typeof f === "string"), name);
      assert.equal(typeof result.hadUserinfo, "boolean", name);
      assert.ok(result.kind === "github" || result.kind === "foreign", name);
      assert.equal(result.kind === "github", typeof result.owner === "string", `${name}: owner only for kind=github`);
      assert.equal(result.kind === "github", typeof result.repo === "string", `${name}: repo only for kind=github`);
    }
  });

  it("never carries the token, the userinfo or the URL into any field", () => {
    let checked = 0;
    for (const [name, argv] of FORMS) {
      const result = parseCloneArgs(argv);
      if (result === null) continue;
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes("://"), `${name}: a URL survived the parse: ${serialized}`);
      assert.ok(!serialized.includes("@"), `${name}: an authority survived the parse: ${serialized}`);
      if (JSON.stringify(argv).includes(TOKEN)) {
        checked += 1;
        assert.ok(!serialized.includes(TOKEN), `${name}: the token survived the parse: ${serialized}`);
      }
    }
    assert.equal(checked, 3, `expected three token-bearing forms, checked ${checked}`);
  });

  it("keeps the parse pure and dependency free", () => {
    const source = fs.readFileSync(MODULE_SRC, "utf8");
    assert.ok(!/\brequire\s*\(/.test(source), "the module must not require() anything");
    assert.ok(!/^import /m.test(source), "the module must stay CommonJS");
    assert.deepEqual(Object.keys(lib), ["parseCloneArgs"], "the module exports parseCloneArgs only");
    assert.equal(typeof parseCloneArgs, "function");
  });
});