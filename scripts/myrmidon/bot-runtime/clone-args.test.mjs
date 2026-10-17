import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H1a): docker/bot-runtime/git-reference/clone-args.js,
// the pure parser of `git clone` arguments. Placeholder owners and a fake token only.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const { parseCloneArgs } = require(path.join(ROOT, "docker/bot-runtime/git-reference/clone-args.js"));

const TOKEN = "ghs_FAKETOKEN0123456789abcdef";
const gh = (over = {}) => ({
  kind: "github", owner: "acme", repo: "widgets", dir: "widgets", ignoredFlags: [], hadUserinfo: false, ...over,
});
const foreign = (over = {}) => ({
  kind: "foreign", owner: null, repo: null, dir: null, ignoredFlags: [], hadUserinfo: false, ...over,
});

const TABLE = [
  ["https with .git", ["clone", "https://github.com/acme/widgets.git"], gh()],
  ["https without .git", ["clone", "https://github.com/acme/widgets"], gh()],
  ["trailing slash", ["clone", "https://github.com/acme/widgets/"], gh()],
  ["no leading clone word", ["https://github.com/acme/widgets.git"], gh()],
  ["target directory", ["clone", "https://github.com/acme/widgets.git", "repo"], gh({ dir: "repo" })],
  ["--filter=blob:none", ["clone", "--filter=blob:none", "https://github.com/acme/widgets.git", "repo"], gh({ dir: "repo", ignoredFlags: ["--filter"] })],
  ["--filter separate value", ["clone", "--filter", "tree:0", "https://github.com/acme/widgets"], gh({ ignoredFlags: ["--filter"] })],
  ["--depth 1", ["clone", "--depth", "1", "https://github.com/acme/widgets.git"], gh({ ignoredFlags: ["--depth"] })],
  ["--depth=50", ["clone", "--depth=50", "https://github.com/acme/widgets.git"], gh({ ignoredFlags: ["--depth"] })],
  ["-b branch", ["clone", "-b", "main", "https://github.com/acme/widgets.git"], gh()],
  ["--branch=x", ["clone", "--branch=feat/x", "https://github.com/acme/widgets.git", "w"], gh({ dir: "w" })],
  ["--mirror", ["clone", "--mirror", "https://github.com/acme/widgets.git"], gh({ ignoredFlags: ["--mirror"] })],
  ["--bare", ["clone", "--bare", "https://github.com/acme/widgets.git"], gh({ ignoredFlags: ["--bare"] })],
  ["--single-branch", ["clone", "--single-branch", "-b", "dev", "https://github.com/acme/widgets.git"], gh({ ignoredFlags: ["--single-branch"] })],
  ["many flags", ["clone", "--filter=blob:none", "--depth", "1", "--single-branch", "-q", "https://github.com/acme/widgets.git"], gh({ ignoredFlags: ["--filter", "--depth", "--single-branch"] })],
  ["ssh url", ["clone", "ssh://git@github.com/acme/widgets.git"], gh()],
  ["ssh url with port", ["clone", "ssh://git@github.com:22/acme/widgets.git"], gh()],
  ["scp-like", ["clone", "git@github.com:acme/widgets.git"], gh()],
  ["scp-like without .git and dir", ["clone", "git@github.com:acme/widgets", "x"], gh({ dir: "x" })],
  ["git protocol", ["clone", "git://github.com/acme/widgets.git"], gh()],
  ["-- separator", ["clone", "--", "https://github.com/acme/widgets.git", "d"], gh({ dir: "d" })],
  ["-- keeps dash-led dir", ["clone", "--", "https://github.com/acme/widgets.git", "-weird"], gh({ dir: "-weird" })],
  ["userinfo x-access-token", ["clone", `https://x-access-token:${TOKEN}@github.com/acme/widgets.git`], gh({ hadUserinfo: true })],
  ["userinfo bare token", ["clone", `https://${TOKEN}@github.com/acme/widgets`, "repo"], gh({ hadUserinfo: true, dir: "repo" })],
  ["userinfo and flags", ["clone", "--filter=blob:none", `https://oauth2:${TOKEN}@github.com/acme/widgets.git`], gh({ hadUserinfo: true, ignoredFlags: ["--filter"] })],
  ["host case", ["clone", "https://GitHub.com/acme/widgets.git"], gh()],
  ["unknown flags do not break", ["clone", "--frobnicate", "--weird=1", "https://github.com/acme/widgets.git"], gh({ ignoredFlags: ["--frobnicate", "--weird"] })],
  ["gitlab https", ["clone", "https://gitlab.com/acme/widgets.git"], foreign()],
  ["foreign with dir and flags", ["clone", "--depth", "1", "https://example.org/a/b.git", "out"], foreign({ dir: "out", ignoredFlags: ["--depth"] })],
  ["foreign scp", ["clone", "git@gitlab.com:acme/widgets.git"], foreign()],
  ["lookalike host", ["clone", "https://github.com.evil.example/acme/widgets.git"], foreign()],
  ["lookalike in userinfo", ["clone", "https://github.com@evil.example/acme/widgets.git"], foreign({ hadUserinfo: false })],
  ["local path", ["clone", "/srv/repos/widgets"], foreign()],
  ["relative path", ["clone", "./widgets", "copy"], foreign({ dir: "copy" })],
  ["github deep path is not a repo", ["clone", "https://github.com/acme/widgets/tree/main"], foreign()],
  ["github org only", ["clone", "https://github.com/acme"], foreign()],
  ["no repository", ["clone", "--depth", "1"], { ...foreign(), kind: "invalid", ignoredFlags: ["--depth"] }],
  ["empty", [], { ...foreign(), kind: "invalid" }],
];

describe("parseCloneArgs", () => {
  for (const [name, argv, expected] of TABLE) {
    it(name, () => {
      assert.deepEqual(parseCloneArgs(argv), expected);
    });
  }

  it("the table covers at least 15 shapes", () => {
    assert.ok(TABLE.length >= 15);
  });

  it("the token never appears in any result field", () => {
    for (const [, argv] of TABLE) {
      const joined = JSON.stringify(parseCloneArgs(argv));
      assert.ok(!joined.includes(TOKEN), "token leaked");
      assert.ok(!joined.includes("FAKETOKEN"), "token part leaked");
      assert.ok(!joined.includes("x-access-token"), "userinfo leaked");
    }
    for (const argv of [
      ["clone", `-c`, `http.extraheader=Authorization: ${TOKEN}`, "https://github.com/acme/widgets"],
      ["clone", `--bogus=${TOKEN}`, "https://github.com/acme/widgets"],
      ["clone", `https://u:${TOKEN}@gitlab.com/acme/widgets`],
    ]) {
      assert.ok(!JSON.stringify(parseCloneArgs(argv)).includes(TOKEN));
    }
  });

  it("has exactly the contract fields and does not mutate or throw on odd input", () => {
    const argv = ["clone", "https://github.com/acme/widgets.git"];
    const copy = [...argv];
    const r = parseCloneArgs(argv);
    assert.deepEqual(Object.keys(r).sort(), ["dir", "hadUserinfo", "ignoredFlags", "kind", "owner", "repo"]);
    assert.deepEqual(argv, copy);
    for (const bad of [undefined, null, "clone", 42, [null, 1, {}]]) {
      assert.equal(parseCloneArgs(bad).kind, "invalid");
    }
  });
});
