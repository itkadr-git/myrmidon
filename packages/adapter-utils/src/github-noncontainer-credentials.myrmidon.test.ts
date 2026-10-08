import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { GITHUB_CREDENTIAL_HELPER_PROGRAM, githubCredentialHelperSource } from "./github-credential-helper.js";
import { githubLauncherSource } from "./github-launcher.js";
import {
  githubBrokerCandidatesLauncherSource,
  githubBrokerRepositoryLauncherSource,
} from "./myrmidon-github-broker.js";

// GITHUB-SHARED-IDENTITY: a NON-CONTAINER run (local or SSH execution target)
// must name the repository of each git/gh operation to the board's broker,
// otherwise a run whose only identity is a self-hosted GitHub App never gets a
// token. The launcher stages the credential helper next to git/gh and points
// Git at it with useHttpPath, and the gh wrapper resolves the repository from
// -R/--repo, GH_REPO or the origin remote — the same rules the bot image's
// wrappers apply.

const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TEST_TOKEN = "test-token-value-not-a-secret";

type Repository = {
  normalizeRepository: (value: unknown) => string | null;
  repositoryFromArgs: (args: string[]) => string | null;
  repositoryFromGitArgs: (args: string[]) => { repository: string | null; cwd: string };
  targetRepository: (
    program: string,
    args: string[],
    env: Record<string, string | undefined>,
    originalPath: string[],
  ) => string | null;
};

/** The repository resolution with a stubbed `require` for the origin-remote lookup. */
function loadRepository(options: { originUrl?: string | null; cwd?: string } = {}) {
  const childProcess = {
    spawnSync: () => ({ status: options.originUrl ? 0 : 1, stdout: `${options.originUrl ?? ""}\n` }),
  };
  const context = vm.createContext({
    process: { cwd: () => options.cwd ?? "/work/repo" },
    require: (name: string) => (name === "node:child_process" ? childProcess : { delimiter: ":" }),
    URL,
    JSON,
    RegExp,
    String,
    Array,
    Object,
  });
  return vm.runInContext(
    `${githubBrokerRepositoryLauncherSource()}\n({ normalizeRepository: paperclipNormalizeRepository, repositoryFromArgs: paperclipRepositoryFromArgs, repositoryFromGitArgs: paperclipRepositoryFromGitArgs, targetRepository: paperclipTargetRepository })`,
    context,
  ) as Repository;
}

/** The broker walk with a scripted fetch, to read the request body it sends. */
function loadWalk() {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fakeFetch = async (url: string, init: { body: unknown }) => {
    calls.push({ url, body: init.body });
    return {
      status: 200,
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
      json: async () => ({ status: "available", env: { GH_TOKEN: TEST_TOKEN } }),
    };
  };
  const context = vm.createContext({
    fetch: fakeFetch,
    AbortSignal: { timeout: () => ({}) },
    setTimeout,
    Date,
    JSON,
    Math,
    Set,
    Array,
    String,
    Promise,
    Object,
  });
  const walk = vm.runInContext(
    `${githubBrokerCandidatesLauncherSource()}\n({ paperclipRequestBrokerCredentials })`,
    context,
  ) as {
    paperclipRequestBrokerCredentials: (
      env: Record<string, string>,
      urls: string[],
      limits: unknown,
      repository?: string | null,
    ) => Promise<{ response: unknown; tried: string[] }>;
  };
  return { walk, calls };
}

describe("non-container GitHub repository resolution (GITHUB-SHARED-IDENTITY)", () => {
  it("accepts github.com only, in every form gh and git write it", () => {
    const repository = loadRepository();
    expect(repository.normalizeRepository("https://github.com/owner-a/repo-a.git")).toBe("owner-a/repo-a");
    expect(repository.normalizeRepository("git@github.com:owner-a/repo-a.git")).toBe("owner-a/repo-a");
    expect(repository.normalizeRepository("ssh://git@github.com/owner-a/repo-a")).toBe("owner-a/repo-a");
    expect(repository.normalizeRepository("github.com/owner-a/repo-a")).toBe("owner-a/repo-a");
    expect(repository.normalizeRepository("owner-a/repo-a")).toBe("owner-a/repo-a");
    expect(repository.normalizeRepository("https://gitlab.com/owner-a/repo-a")).toBeNull();
    expect(repository.normalizeRepository("https://github.com/owner-a")).toBeNull();
    expect(repository.normalizeRepository("")).toBeNull();
  });

  it("does not read a git branch or remote name as a repository", () => {
    const repository = loadRepository({ originUrl: null });
    // 'origin/main' has two segments but names a remote-tracking ref, never a repo.
    expect(repository.repositoryFromGitArgs(["push", "origin", "main"]).repository).toBeNull();
    expect(repository.repositoryFromGitArgs(["push", "origin/main"]).repository).toBeNull();
    expect(repository.repositoryFromGitArgs(["checkout", "main"]).repository).toBeNull();
    expect(repository.repositoryFromGitArgs(["clone", "https://github.com/owner-c/repo-c.git"]).repository).toBe("owner-c/repo-c");
    expect(repository.repositoryFromGitArgs(["fetch", "git@github.com:owner-d/repo-d.git"]).repository).toBe("owner-d/repo-d");
    expect(repository.repositoryFromGitArgs(["push", "https://github.com/owner-e/repo-e"]).repository).toBe("owner-e/repo-e");
  });

  it("falls back to the origin remote, honouring -C, and never to another host", () => {
    const repository = loadRepository({ originUrl: "https://github.com/owner-a/repo-a.git" });
    expect(repository.targetRepository("git", ["status"], {}, ["/usr/bin"])).toBe("owner-a/repo-a");
    expect(repository.targetRepository("gh", ["pr", "list"], {}, ["/usr/bin"])).toBe("owner-a/repo-a");
    expect(repository.repositoryFromGitArgs(["-C", "/elsewhere", "status"]).cwd).toBe("/elsewhere");
    const elsewhere = loadRepository({ originUrl: "https://bitbucket.org/owner-a/repo-a.git" });
    expect(elsewhere.targetRepository("git", ["status"], {}, ["/usr/bin"])).toBeNull();
  });

  it("prefers the explicit repository of a gh invocation and never falls through a bad one", () => {
    const repository = loadRepository({ originUrl: "https://github.com/owner-a/repo-a.git" });
    expect(repository.targetRepository("gh", ["-R", "owner-b/repo-b", "pr", "list"], {}, [])).toBe("owner-b/repo-b");
    expect(repository.targetRepository("gh", ["--repo=https://github.com/owner-b/repo-b.git", "pr", "list"], {}, [])).toBe("owner-b/repo-b");
    expect(repository.targetRepository("gh", ["pr", "list"], { GH_REPO: "github.com/owner-b/repo-b" }, [])).toBe("owner-b/repo-b");
    expect(repository.targetRepository("gh", ["-R", "gitlab.com/owner-b/repo-b", "pr", "list"], {}, [])).toBeNull();
  });

  it("sends the repository as the broker request body, and nothing when there is none", async () => {
    const { walk, calls } = loadWalk();
    const env = { PAPERCLIP_GITHUB_BROKER_TOKEN: "capability", PAPERCLIP_GITHUB_BROKER_URL: "http://127.0.0.1:3100" };
    await walk.paperclipRequestBrokerCredentials(env, ["http://127.0.0.1:3100"], undefined, "owner-a/repo-a");
    await walk.paperclipRequestBrokerCredentials(env, ["http://127.0.0.1:3100"], undefined, null);
    expect(calls.map((call) => JSON.parse(String(call.body)))).toEqual([
      { repository: "owner-a/repo-a" },
      {},
    ]);
  });
});

describe("non-container GitHub launcher (GITHUB-SHARED-IDENTITY)", () => {
  async function stagedRun(options: { originUrl?: string | null } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-launcher-repo-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    const realBin = path.join(root, "real");
    const repo = path.join(root, "repo");
    await mkdir(bin, { recursive: true });
    await mkdir(realBin, { recursive: true });
    await mkdir(repo, { recursive: true });
    await exec("git", ["init", repo]);
    if (options.originUrl) await exec("git", ["-C", repo, "remote", "add", "origin", options.originUrl]);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(bin, "gh"), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(bin, GITHUB_CREDENTIAL_HELPER_PROGRAM), githubCredentialHelperSource(), { mode: 0o700 });
    // The real commands, found after the staged launchers.
    await writeFile(
      path.join(realBin, "git"),
      `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'dump-env') {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(GIT_CONFIG_|GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_|GIT_COMMITTER_|GIT_TERMINAL_PROMPT)/.test(key)) env[key] = value;
  }
  process.stdout.write(JSON.stringify(env));
} else {
  execFileSync('/usr/bin/git', args, { stdio: 'inherit', env: process.env });
}
`,
      { mode: 0o700 },
    );
    await writeFile(
      path.join(realBin, "gh"),
      `#!/usr/bin/env node
process.stdout.write('token=' + (process.env.GH_TOKEN || '') + ' args=' + process.argv.slice(2).join(' ') + '\\n');
`,
      { mode: 0o700 },
    );
    const requests: Array<{ body: string; capability: string | undefined; authorization: string | undefined }> = [];
    const server: Server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push({
          body,
          capability: request.headers["x-paperclip-github-capability"] as string | undefined,
          authorization: request.headers.authorization,
        });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          status: "available",
          source: "app",
          login: "myrmidon",
          env: {
            GH_TOKEN: TEST_TOKEN,
            GITHUB_TOKEN: TEST_TOKEN,
            GIT_AUTHOR_NAME: "Agent A",
            GIT_AUTHOR_EMAIL: "agent-a@example.test",
            GIT_COMMITTER_NAME: "Agent A",
            GIT_COMMITTER_EMAIL: "agent-a@example.test",
            // A broker-supplied credential helper must never replace the staged one.
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
            GIT_CONFIG_VALUE_0: "/bin/false",
          },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
    const { port } = server.address() as { port: number };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      PATH: `${bin}${path.delimiter}${realBin}${path.delimiter}${process.env.PATH}`,
      PAPERCLIP_GITHUB_BROKER_URL: `http://127.0.0.1:${port}`,
      PAPERCLIP_GITHUB_BROKER_TOKEN: "run-capability-value",
      GH_TOKEN: "static-host-token",
    };
    return { root, bin, repo, requests, env };
  }

  it("names the origin repository and installs the staged helper with useHttpPath", async () => {
    const { bin, repo, requests, env } = await stagedRun({ originUrl: "https://github.com/owner-a/repo-a.git" });
    const dump = await exec(path.join(bin, "git"), ["dump-env"], { cwd: repo, env });
    expect(requests.map((request) => JSON.parse(request.body))).toEqual([{ repository: "owner-a/repo-a" }]);
    expect(requests[0]!.capability).toBe("run-capability-value");
    const gitEnv = JSON.parse(dump.stdout) as Record<string, string>;
    const entries: Record<string, string[]> = {};
    for (let index = 0; index < Number(gitEnv.GIT_CONFIG_COUNT); index += 1) {
      const key = gitEnv[`GIT_CONFIG_KEY_${index}`]!;
      entries[key] = [...(entries[key] ?? []), gitEnv[`GIT_CONFIG_VALUE_${index}`]!];
    }
    expect(entries["credential.https://github.com.useHttpPath"]).toEqual(["true"]);
    expect(entries["credential.https://github.com.helper"]).toEqual([path.join(bin, GITHUB_CREDENTIAL_HELPER_PROGRAM)]);
    expect(entries["credential.helper"]).toEqual([""]);
    // The broker's own helper never reaches the child Git.
    expect(JSON.stringify(entries)).not.toContain("/bin/false");
    expect(gitEnv.GH_TOKEN).toBe(TEST_TOKEN);
    expect(gitEnv.GIT_AUTHOR_EMAIL).toBe("agent-a@example.test");
  });

  it("resolves the credential of a git operation through the staged helper", async () => {
    const { bin, repo, requests, env } = await stagedRun({ originUrl: "https://github.com/owner-a/repo-a.git" });
    const dump = await exec(path.join(bin, "git"), ["dump-env"], { cwd: repo, env });
    const gitEnv = JSON.parse(dump.stdout) as Record<string, string>;
    const before = requests.length;
    const fill = await new Promise<{ stdout: string }>((resolve) => {
      const child = execFile(
        "/usr/bin/git",
        ["credential", "fill"],
        { cwd: repo, env: { ...env, ...gitEnv } },
        (_error, stdout) => resolve({ stdout }),
      );
      child.stdin!.end("protocol=https\nhost=github.com\npath=owner-a/repo-a.git\n\n");
    });
    expect(fill.stdout).toContain("username=x-access-token");
    expect(fill.stdout).toContain(`password=${TEST_TOKEN}`);
    expect(requests.slice(before).map((request) => JSON.parse(request.body))).toEqual([{ repository: "owner-a/repo-a" }]);
  });

  it("names the repository of a gh invocation and of a remote named in the arguments", async () => {
    const { bin, root, repo, requests, env } = await stagedRun({ originUrl: "https://github.com/owner-a/repo-a.git" });
    const gh = await exec(path.join(bin, "gh"), ["-R", "owner-b/repo-b", "pr", "list"], { cwd: repo, env });
    expect(gh.stdout.trim()).toBe(`token=${TEST_TOKEN} args=-R owner-b/repo-b pr list`);
    expect(JSON.parse(requests.at(-1)!.body)).toEqual({ repository: "owner-b/repo-b" });
    const beforeClone = requests.length;
    await exec(path.join(bin, "git"), ["clone", "https://github.com/owner-c/repo-c.git"], { cwd: root, env }).catch(() => undefined);
    const cloneBodies = requests.slice(beforeClone).map((request) => JSON.parse(request.body));
    expect(cloneBodies.length).toBeGreaterThan(0);
    for (const body of cloneBodies) expect(body).toEqual({ repository: "owner-c/repo-c" });
    // 'origin/main' stays a ref, not a repository: the origin remote is named.
    const beforePush = requests.length;
    await exec(path.join(bin, "git"), ["push", "origin", "HEAD:refs/heads/main"], { cwd: repo, env }).catch(() => undefined);
    const pushBodies = requests.slice(beforePush).map((request) => JSON.parse(request.body));
    expect(pushBodies.length).toBeGreaterThan(0);
    for (const body of pushBodies) expect(body).toEqual({ repository: "owner-a/repo-a" });
  });

  it("names no repository when neither the arguments nor the directory carry one", async () => {
    const { bin, repo, requests, env } = await stagedRun({ originUrl: null });
    const dump = await exec(path.join(bin, "git"), ["dump-env"], { cwd: repo, env });
    expect(requests.map((request) => JSON.parse(request.body))).toEqual([{}]);
    const gitEnv = JSON.parse(dump.stdout) as Record<string, string>;
    // Every entry the launcher sets reaches the child Git: the image's
    // credential wiring plus the identity guard of a non-container target.
    expect(gitEnv.GIT_CONFIG_COUNT).toBe("9");
    const entries: Record<string, string> = {};
    for (let index = 0; index < Number(gitEnv.GIT_CONFIG_COUNT); index += 1) {
      entries[gitEnv[`GIT_CONFIG_KEY_${index}`]!] = gitEnv[`GIT_CONFIG_VALUE_${index}`]!;
    }
    expect(entries["user.useConfigOnly"]).toBe("true");
    expect(entries["credential.helper"]).toBe("");
  });
});