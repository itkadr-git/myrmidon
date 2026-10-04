import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// GITHUB-SHARED-IDENTITY: the bot image's GitHub broker wrappers name the target
// repository to the board's broker, so the broker can issue the shared GitHub
// authorization per allowed repository. The board side is covered by vitest; this
// pins the container half: what the git credential helper and the gh wrapper
// send, and that they answer git/gh only with what the broker returned.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BROKER_DIR = path.join(ROOT, "docker/bot-runtime/github-broker");
const GITCONFIG = path.join(BROKER_DIR, "gitconfig");
// The wrappers are CommonJS scripts installed under /opt (no package.json).
// Inside this repository the root package.json says "type": "module", so run
// copies from a scratch directory, exactly as the image runs them.
const INSTALL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-github-broker-test-"));
const HELPER = path.join(INSTALL_DIR, "git-credential-paperclip");
const GH_WRAPPER = path.join(INSTALL_DIR, "gh");
for (const name of ["git-credential-paperclip", "gh"]) {
  fs.copyFileSync(path.join(BROKER_DIR, name), path.join(INSTALL_DIR, name));
}

const TEST_TOKEN = "test-token-value-not-a-secret";

let server;
let baseUrl;
let requests = [];
let reply = { status: 200, body: {} };

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  reply = { status: 200, body: {} };
});

function run(command, args, { input = "", env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [command, ...args], {
      cwd,
      env: {
        PATH: env.PATH ?? process.env.PATH,
        HOME: os.tmpdir(),
        PAPERCLIP_GITHUB_BROKER_URL: baseUrl,
        PAPERCLIP_GITHUB_BROKER_TOKEN: "test-capability",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const available = {
  status: "available",
  source: "shared",
  login: "bot-a",
  repository: "owner-a/repo-a",
  env: { GH_TOKEN: TEST_TOKEN, GITHUB_TOKEN: TEST_TOKEN },
};

describe("docker/bot-runtime/github-broker/gitconfig", () => {
  it("makes git hand the helper the repository path for github.com", () => {
    const text = fs.readFileSync(GITCONFIG, "utf8");
    for (const host of ["https://github.com", "https://www.github.com"]) {
      const section = text.split(`[credential "${host}"]`)[1]?.split("[")[0] ?? "";
      assert.match(section, /helper = !\/opt\/paperclip\/bin\/git-credential-paperclip/);
      assert.match(section, /useHttpPath = true/);
    }
  });
});

describe("docker/bot-runtime/github-broker/git-credential-paperclip", () => {
  it("forwards owner/repo from git's path and answers with the issued credential", async () => {
    reply = { status: 200, body: available };
    const result = await run(HELPER, ["get"], {
      input: "protocol=https\nhost=github.com\npath=owner-a/repo-a.git\n\n",
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `username=x-access-token\npassword=${TEST_TOKEN}\n`);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/runtime-tools/github/credentials");
    assert.deepEqual(JSON.parse(requests[0].body), { repository: "owner-a/repo-a" });
    assert.equal(requests[0].headers["x-paperclip-github-capability"], "test-capability");
    assert.doesNotMatch(result.stderr, new RegExp(TEST_TOKEN));
  });

  it("answers nothing when the broker refuses the repository", async () => {
    reply = {
      status: 200,
      body: {
        status: "unavailable",
        source: "shared",
        reason: "Repository owner-a/other is not in the allowed list of the shared GitHub authorization",
        env: {},
      },
    };
    const result = await run(HELPER, ["get"], {
      input: "protocol=https\nhost=github.com\npath=owner-a/other.git\n\n",
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /not in the allowed list/);
    assert.deepEqual(JSON.parse(requests[0].body), { repository: "owner-a/other" });
  });

  it("sends an empty body when git names no usable path", async () => {
    reply = { status: 200, body: { status: "absent", reason: "No GitHub identity connected", env: {} } };
    for (const input of [
      "protocol=https\nhost=github.com\n\n",
      "protocol=https\nhost=github.com\npath=only-owner\n\n",
      "protocol=https\nhost=github.com\npath=../../etc/passwd\n\n",
    ]) {
      requests = [];
      const result = await run(HELPER, ["get"], { input });
      assert.equal(result.stdout, "");
      assert.deepEqual(JSON.parse(requests[0].body), {});
    }
  });

  it("never asks the broker for another host", async () => {
    reply = { status: 200, body: available };
    const result = await run(HELPER, ["get"], {
      input: "protocol=https\nhost=example.com\npath=owner-a/repo-a.git\n\n",
    });
    assert.equal(result.stdout, "");
    assert.equal(requests.length, 0);
  });
});

describe("docker/bot-runtime/github-broker/gh", () => {
  let fakeBin;

  before(() => {
    // A stand-in for the real gh, found on PATH after the wrapper's own directory.
    fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-gh-wrapper-test-"));
    fs.writeFileSync(
      path.join(fakeBin, "gh"),
      '#!/bin/sh\nprintf "token=%s args=%s\\n" "$GH_TOKEN" "$*"\n',
      { mode: 0o755 },
    );
  });

  after(() => fs.rmSync(fakeBin, { recursive: true, force: true }));

  for (const [label, args, env] of [
    ["-R", ["-R", "owner-a/repo-a", "pr", "list"], {}],
    ["--repo=", ["--repo=https://github.com/owner-a/repo-a.git", "pr", "list"], {}],
    ["GH_REPO", ["pr", "list"], { GH_REPO: "github.com/owner-a/repo-a" }],
  ]) {
    it(`forwards the target repository from ${label} and runs gh with the issued token`, async () => {
      reply = { status: 200, body: available };
      const result = await run(GH_WRAPPER, args, {
        env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, ...env },
        cwd: fakeBin,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(requests.length, 1);
      assert.deepEqual(JSON.parse(requests[0].body), { repository: "owner-a/repo-a" });
      assert.match(result.stdout, new RegExp(`^token=${TEST_TOKEN} args=`));
    });
  }

  it("runs gh without a token when the broker refuses", async () => {
    reply = { status: 200, body: { status: "unavailable", source: "shared", reason: "not allowed", env: {} } };
    const result = await run(GH_WRAPPER, ["-R", "owner-b/repo-b", "pr", "list"], {
      env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
      cwd: fakeBin,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(requests[0].body), { repository: "owner-b/repo-b" });
    assert.match(result.stdout, /^token= args=/);
    assert.match(result.stderr, /GitHub access unavailable: not allowed/);
  });
});
