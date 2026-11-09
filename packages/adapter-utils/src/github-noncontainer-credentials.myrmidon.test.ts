import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  const spawnCalls: string[] = [];
  const childProcess = {
    spawnSync: (executable: string, _args: string[]) => {
      spawnCalls.push(executable);
      return { status: options.originUrl ? 0 : 1, stdout: `${options.originUrl ?? ""}\n` };
    },
  };
  const context = vm.createContext({
    process: { cwd: () => options.cwd ?? "/work/repo" },
    spawnCalls,
    require: (name: string) => {
      if (name === "node:child_process") return childProcess;
      if (name === "node:path") return {
        delimiter: ":",
        resolve: (value: string) => value.startsWith("/") ? value : `/work/repo/${value}`,
        join: (directory: string, file: string) => `${directory}/${file}`,
      };
      return { delimiter: ":" };
    },
    URL,
    JSON,
    RegExp,
    String,
    Array,
    Object,
  });
  return vm.runInContext(
    `${githubBrokerRepositoryLauncherSource()}\n({ normalizeRepository: paperclipNormalizeRepository, repositoryFromArgs: paperclipRepositoryFromArgs, repositoryFromGitArgs: paperclipRepositoryFromGitArgs, targetRepository: paperclipTargetRepository, spawnCalls })`,
    context,
  ) as Repository & { spawnCalls: string[] };
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

  it("rejects a configured git wrapper in the broker origin lookup", () => {
    const repository = loadRepository({ originUrl: "https://github.com/owner-a/repo-a.git" });
    const wrapper = "/work/repo/wrapper/git";
    expect(repository.targetRepository(
      "git",
      ["status"],
      { MYRMIDON_GIT_REAL: wrapper },
      ["/usr/bin"],
    )).toBe("owner-a/repo-a");
    expect(repository.spawnCalls).toEqual(["/opt/paperclip/libexec/git"]);
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
if (args[0] === 'config' && args[1] === '--get' && args[2] === 'remote.origin.url') {
  const result = execFileSync('/usr/bin/git', args, { encoding: 'utf8', env: process.env });
  process.stdout.write(result);
} else if (args[0] === 'dump-env') {
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

describe("git shim recursion guard (GIT-SHIM-RECURSION)", () => {
  // The incident (OPE-12510, adm-dev-eng-20, 09.11): on the bot image the
  // staged launcher directory sits on a PATH whose NEXT `git` is the IMAGE'S
  // git wrapper (/opt/paperclip/bin/git), not the real binary. The launcher's
  // origin-remote lookup then spawned that wrapper, which intercepted the same
  // `git config --get remote.origin.url` again, and the two shims called each
  // other by absolute paths until the PID limit killed the container. The
  // launcher must resolve the origin remote through the real git: an absolute
  // MYRMIDON_GIT_REAL when it names a real binary, else the first PATH entry
  // that is NOT a known git wrapper (the staged directory, the image wrapper,
  // the /usr/local/bin shadow), else the image's libexec path.
  async function stagedImageLikeRun(options: { originUrl?: string | null } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-shim-recur-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const launcherBin = path.join(root, "launcher");
    const imageWrapperBin = path.join(root, "image-wrapper");
    const realBin = path.join(root, "real");
    const nodeBin = path.join(root, "node-bin");
    const repo = path.join(root, "repo");
    await mkdir(launcherBin, { recursive: true });
    await mkdir(imageWrapperBin, { recursive: true });
    await mkdir(realBin, { recursive: true });
    await mkdir(nodeBin, { recursive: true });
    await mkdir(repo, { recursive: true });
    // Every staged program here carries an /usr/bin/env node shebang: the
    // fixture PATH must keep node reachable (the bot image guarantees it), and
    // a runner may have node only in its own tool directories.
    await symlink(process.execPath, path.join(nodeBin, "node"));
    await exec("git", ["init", repo]);
    if (options.originUrl) await exec("git", ["-C", repo, "remote", "add", "origin", options.originUrl]);
    await writeFile(path.join(launcherBin, "git"), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(launcherBin, "gh"), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(launcherBin, GITHUB_CREDENTIAL_HELPER_PROGRAM), githubCredentialHelperSource(), { mode: 0o700 });
    // The image's git wrapper: re-executes itself for the very command the
    // incident looped on (a stand-in for /opt/paperclip/bin/git, which adds
    // --reference-if-able to clones and execs /opt/paperclip/libexec/git).
    await writeFile(
      path.join(imageWrapperBin, "git"),
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'config' && args[1] === '--get' && args[2] === 'remote.origin.url') {
  process.stderr.write('wrapper-reentry\\n');
}
const result = spawnSync(process.argv[1], args, { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    // The real git: prints a marker so the test can tell WHICH binary answered,
    // and answers `config --get remote.origin.url` like the real one.
    await writeFile(
      path.join(realBin, "git"),
      `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('real-git-marker\\n'); process.exit(0); }
const result = execFileSync('/usr/bin/git', args, { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
if (args[0] === 'config' && args[1] === '--get' && args[2] === 'remote.origin.url') process.stdout.write(result);
`,
      { mode: 0o700 },
    );
    const requests: Array<{ body: string }> = [];
    const server: Server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push({ body });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "available", env: { GH_TOKEN: TEST_TOKEN } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    // The PATH of a bot-image run: launcher dir first (the gateway's staged
    // directory), then the image wrapper's directory (what /opt/paperclip/bin
    // is on the image), then the real binaries. MYRMIDON_GIT_REAL is unset —
    // on the image only the wrapper's own default points at libexec.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      PATH: `${launcherBin}${path.delimiter}${imageWrapperBin}${path.delimiter}${realBin}${path.delimiter}${nodeBin}${path.delimiter}${process.env.PATH}`,
      PAPERCLIP_GITHUB_BROKER_URL: `http://127.0.0.1:${port}`,
      PAPERCLIP_GITHUB_BROKER_TOKEN: "run-capability-value",
    };
    delete env.MYRMIDON_GIT_REAL;
    return { root, launcherBin, imageWrapperBin, realBin, nodeBin, repo, requests, env };
  }

  it("answers `git status` from the real binary and never re-enters the image git wrapper", async () => {
    const { launcherBin, repo, requests, env } = await stagedImageLikeRun({ originUrl: "https://github.com/owner-a/repo-a.git" });
    const result = await exec(path.join(launcherBin, "git"), ["status", "--short"], { cwd: repo, env, timeout: 30_000 });
    // The origin remote was resolved for the broker request through the real
    // binary, so the repository is named without re-entering the wrapper.
    expect(requests.map((request) => JSON.parse(request.body))).toEqual([{ repository: "owner-a/repo-a" }]);
    expect(result.stderr).not.toContain("wrapper-reentry");
  });

  it("falls back to the image libexec git when MYRMIDON_GIT_REAL is unset and PATH holds only wrappers", async () => {
    const { launcherBin, nodeBin, repo, env } = await stagedImageLikeRun({ originUrl: "https://github.com/owner-a/repo-a.git" });
    // Only the launcher's own directory plus a node directory for the env
    // shebangs: no wrapper stand-in and no real git on the fixture path, so the
    // launcher's PATH-walk finds no candidate at all and must land on the
    // image fallback (/opt/paperclip/libexec/git here, /usr/bin/git on the
    // runner). /usr/bin and /bin stay OFF the path: the container's
    // /usr/bin/git is the wrapper symlink and the runner's is the real binary,
    // so either would blur the contract under test.
    const wrapperOnly: NodeJS.ProcessEnv = {
      ...env,
      PATH: `${launcherBin}${path.delimiter}${nodeBin}`,
    };
    const result = await exec(path.join(launcherBin, "git"), ["--version"], { cwd: repo, env: wrapperOnly, timeout: 30_000 });
    // The libexec fallback answered (here /opt/paperclip/libexec/git is the
    // container's real git; on the runner the fallback is /usr/bin/git), so the
    // output is a real `git version` line and never the stand-in's marker.
    expect(result.stdout).toContain("git version");
    expect(result.stdout).not.toContain("real-git-marker");
  });

  it("answers direct `git config --get remote.origin.url` through the wrapper without recursion", async () => {
    const { launcherBin, repo, requests, env } = await stagedImageLikeRun({ originUrl: "https://github.com/owner-a/repo-a.git" });
    const result = await exec(path.join(launcherBin, "git"), ["config", "--get", "remote.origin.url"], { cwd: repo, env, timeout: 30_000 });
    expect(result.stdout.trim()).toBe("https://github.com/owner-a/repo-a.git");
    expect(result.stderr).not.toContain("wrapper-reentry");
    // Direct invocation does not trigger broker loop
    expect(requests.length).toBeLessThanOrEqual(1);
  });

  it("bypasses broker and spawns real git directly on re-entrant invocation (PAPERCLIP_GITHUB_OPERATION_ACTIVE=1)", async () => {
    const { launcherBin, repo, requests, env } = await stagedImageLikeRun({ originUrl: "https://github.com/owner-a/repo-a.git" });
    const reentrantEnv: NodeJS.ProcessEnv = {
      ...env,
      PAPERCLIP_GITHUB_OPERATION_ACTIVE: "1",
    };
    const result = await exec(path.join(launcherBin, "git"), ["config", "--get", "remote.origin.url"], { cwd: repo, env: reentrantEnv, timeout: 30_000 });
    expect(result.stdout.trim()).toBe("https://github.com/owner-a/repo-a.git");
    expect(result.stderr).not.toContain("wrapper-reentry");
    // In re-entrant mode, the broker was never called at all
    expect(requests).toEqual([]);
  });

  it("rejects MYRMIDON_GIT_REAL when it is a symlink pointing back to the wrapper", async () => {
    const { root, launcherBin, repo, env } = await stagedImageLikeRun({ originUrl: "https://github.com/owner-a/repo-a.git" });
    const symlinkWrapper = path.join(root, "symlink-wrapper");
    await symlink(path.join(launcherBin, "git"), symlinkWrapper);
    const symlinkEnv: NodeJS.ProcessEnv = {
      ...env,
      MYRMIDON_GIT_REAL: symlinkWrapper,
    };
    // Must resolve realpath, reject the wrapper symlink, and use fallback without recursion or timeout
    const result = await exec(path.join(launcherBin, "git"), ["status", "--short"], { cwd: repo, env: symlinkEnv, timeout: 30_000 });
    expect(result.stderr).not.toContain("wrapper-reentry");
  });
});