// myrmidon(OPE-12633 OMP-SSH-RUNNER): contract of the omp SSH runner image —
// pinned toolchain, key-only sshd, and the signed CI image lane.
// myrmidon(OPE-12722 OMP-RUNNER-SHARED-CACHE, OPE-13018 OMP-RUNNER-DISK):
// the shared package cache — board git mirrors read through the wrapper, the
// runners' own pnpm metadata cache, the shared pnpm store mount, and the
// per-runner pnpm store in the workspace volume as a fallback.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const dockerfile = fs.readFileSync("docker/agent-runtime/Dockerfile.omp-ssh", "utf8");
const sshd = fs.readFileSync("docker/agent-runtime/omp-ssh/sshd_config", "utf8");
const entrypoint = fs.readFileSync("docker/agent-runtime/omp-ssh/entrypoint.sh", "utf8");
const compose = fs.readFileSync("docker/agent-runtime/omp-ssh/compose.yml", "utf8");
const wrapper = fs.readFileSync("docker/agent-runtime/omp-ssh/git-reference/git", "utf8");
const wrapperPkg = JSON.parse(fs.readFileSync("docker/agent-runtime/omp-ssh/git-reference/package.json", "utf8"));
const readme = fs.readFileSync("docker/agent-runtime/README.md", "utf8");
const readmeRu = fs.readFileSync("docker/agent-runtime/README.ru.md", "utf8");
const bake = fs.readFileSync("docker/agent-runtime/buildx-bake.hcl", "utf8");
const workflow = fs.readFileSync(".github/workflows/agent-runtime-images.yml", "utf8");
const boardDockerfile = fs.readFileSync("Dockerfile", "utf8");

function argValue(text, name) {
  const match = text.match(new RegExp(`^ARG ${name}=(\\S+)$`, "m"));
  return match ? match[1] : null;
}

describe("omp SSH runner image", () => {
  it("builds on agent-runtime-base and pins Bun and omp exactly like the board image", () => {
    assert.match(dockerfile, /^FROM paperclipai\/agent-runtime-base:\$\{BASE_TAG\}$/m);
    for (const name of ["BUN_VERSION", "BUN_SHA256", "OMP_VERSION"]) {
      assert.ok(argValue(dockerfile, name), `missing ARG ${name}`);
      assert.equal(argValue(dockerfile, name), argValue(boardDockerfile, name), `${name} differs from the board image`);
    }
    assert.match(dockerfile, /sha256sum -c -/);
    assert.match(dockerfile, /bun add --global "@oh-my-pi\/pi-coding-agent@\$\{OMP_VERSION\}"/);
    assert.doesNotMatch(dockerfile, /@latest/);
  });

  it("pins pnpm to the repository's packageManager and the GitHub CLI by checksum", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    assert.equal(`pnpm@${argValue(dockerfile, "PNPM_VERSION")}`, pkg.packageManager);
    assert.match(argValue(dockerfile, "GH_SHA256") ?? "", /^[0-9a-f]{64}$/);
  });

  it("smoke-checks the toolchain and the sshd configuration at build time", () => {
    for (const check of ["omp --version", "bun --version", "pnpm --version", "gh --version", "command -v git", "command -v tar", "sshd -t -f /etc/ssh/omp-runner/sshd_config"]) {
      assert.ok(dockerfile.includes(check), `missing smoke check: ${check}`);
    }
    assert.match(dockerfile, /usermod -p '\*' paperclip/, "a locked account refuses key logins with UsePAM off");
    assert.match(dockerfile, /rm -f \/etc\/ssh\/ssh_host_\*/, "no host key may be baked into the image");
  });

  it("allows only key authentication for paperclip", () => {
    assert.match(sshd, /^Port 2222$/m);
    assert.match(sshd, /^PasswordAuthentication no$/m);
    assert.match(sshd, /^KbdInteractiveAuthentication no$/m);
    assert.match(sshd, /^PermitRootLogin no$/m);
    assert.match(sshd, /^AllowUsers paperclip$/m);
    assert.match(sshd, /^AuthorizedKeysFile \/etc\/ssh\/omp-runner\/authorized_keys$/m);
    assert.match(sshd, /^AllowAgentForwarding no$/m);
    assert.match(sshd, /^PermitUserEnvironment no$/m);
  });

  it("keeps the host key in a volume and refuses to start without an authorized key", () => {
    assert.match(entrypoint, /\/var\/lib\/omp-runner\/hostkeys/);
    assert.match(entrypoint, /if \[ ! -s "\$authorized_keys" \]/);
    assert.match(entrypoint, /exec \/usr\/sbin\/sshd -D -e/);
    assert.match(compose, /hostkeys:\/var\/lib\/omp-runner\/hostkeys/);
  });

  it("runs the container with limits, without host paths in the workspace and without a published port", () => {
    for (const key of ["mem_limit", "memswap_limit", "cpus", "pids_limit"]) assert.match(compose, new RegExp(`^\\s+${key}:`, "m"));
    assert.match(compose, /cap_drop: \[ALL\]/);
    assert.match(compose, /no-new-privileges:true/);
    assert.doesNotMatch(compose, /^\s+ports:/m);
    assert.doesNotMatch(compose, /docker\.sock/);
    assert.match(compose, /- workspace:\/workspace$/m);
    assert.match(compose, /^\s+- tmp:\/tmp$/m);
    // the runner data never lands in /var/lib/docker on the root disk (10.11: +10 GB on the root in an hour)
    // OPE-12966: so does /tmp, where tests and task tooling write gigabytes
    for (const v of ["workspace", "home", "hostkeys", "tmp"]) {
      assert.match(compose, new RegExp(`device: "\\$\\{OMP_RUNNER_DATA_DIR:\\?[^}]*\\}/${v}"`));
    }
  });

  it("publishes only through the signed CI image lane", () => {
    assert.match(bake, /target "omp-ssh"/);
    assert.match(bake, /agent-runtime-omp-ssh:\$\{VERSION\}/);
    assert.match(workflow, /docker buildx bake[\s\S]*?omp omp-ssh/);
    assert.match(workflow, /Cosign sign omp-ssh/);
    assert.match(workflow, /agent-runtime-omp-ssh@\$\{\{ steps\.bake\.outputs\.omp_ssh_digest \}\}/);
  });
});

// myrmidon(OPE-12722 OMP-RUNNER-SHARED-CACHE, OPE-13018 OMP-RUNNER-DISK):
// the runner shares the board's package cache the way the bot containers do —
// git mirrors read-only through a wrapper, the runners' own pnpm metadata
// cache read-write, and the pnpm STORE mounted at /cache/pnpm-store (a shared
// store across all runners on the host, on the same XFS filesystem as the
// runner volumes, so reflink works). A runner whose compose predates the
// shared store falls back to the legacy per-runner store inside the workspace
// volume, inside `.paperclip-runtime`, the one directory the board's cleanups
// spare.
describe("omp SSH runner shared cache (OPE-12722, OPE-13018)", () => {
  // ${OMP_RUNNER_CACHE_DIR:-${OMP_RUNNER_DATA_DIR:?...}/cache}
  const cacheRoot = String.raw`\$\{OMP_RUNNER_CACHE_DIR:-\$\{OMP_RUNNER_DATA_DIR:\?[^}]*\}/cache\}`;

  it("mounts the shared cache: git mirrors read-only, the runners' own download cache and the shared pnpm store writable", () => {
    assert.match(compose, new RegExp(`^\\s+- ${cacheRoot}/git:/cache/git:ro$`, "m"));
    assert.match(compose, new RegExp(`^\\s+- ${cacheRoot}/pnpm-omp:/cache/pnpm$`, "m"));
    assert.match(compose, new RegExp(`^\\s+- ${cacheRoot}/pnpm-store-omp:/cache/pnpm-store$`, "m"));
    // the bots' <cache>/pnpm (uid 10001, re-owned by their prepare step) is never mounted by a runner
    assert.doesNotMatch(compose, /^\s+- [^\n]*\/pnpm:\/cache\//m);
    // the cache directory is optional: an existing env file keeps working
    assert.doesNotMatch(compose, /OMP_RUNNER_CACHE_DIR:\?/);
  });

  it("documents the cache directories and the store location in the compose header", () => {
    assert.match(compose, /OMP_RUNNER_CACHE_DIR +\(myrmidon OPE-12722/);
    assert.match(compose, /install -d -o <board uid> -m 0755 <cache>\/git/);
    assert.match(compose, /install -d -o 1000 -g 1000 -m 0755 <cache>\/pnpm-omp/);
    assert.match(compose, /install -d -o 1000 -g 1000 -m 0755 <cache>\/pnpm-store-omp/);
    assert.match(compose, /\/workspace\/\.paperclip-runtime\/pnpm-store/);
    assert.match(compose, /git clean -fdx -e \.paperclip-runtime/);
    // the old claim that no host path but the key is mounted is false once the cache is bound
    assert.doesNotMatch(compose, /No host path other than the public key is mounted/);
  });

  it("ships a consume-only git wrapper that references the board's mirror", () => {
    // the wrapper is CommonJS (the repo root package.json is "type": "module");
    // the sibling marker matches the bot wrapper's (984781988)
    assert.equal(wrapperPkg.type, "commonjs");
    // an absolute interpreter: git runs from hooks and `env -i` shells without node on PATH
    assert.equal(wrapper.split("\n")[0], "#!/usr/bin/node");
    assert.match(wrapper, /--reference-if-able/);
    assert.match(wrapper, /MYRMIDON_GIT_MIRROR_ROOT \|\| "\/cache\/git"/);
    assert.match(wrapper, /MYRMIDON_GIT_WRAPPED/, "fork-loop guard for MYRMIDON_GIT_REAL");
    assert.match(wrapper, /GIT_TERMINAL_PROMPT/);
    // the wrapper only reads: no mirror creation, refresh or size cap here
    assert.doesNotMatch(wrapper, /ensureLocalMirror|refreshDue|recordStoreEvent/);
    // GitHub-only URL match, so no URL can point git at another path
    assert.match(wrapper, /github\.com/);
    assert.match(wrapper, /OWNER_RE|OWNER/);
  });

  it("installs the wrapper on PATH ahead of the real git and RUNS it in the build smoke", () => {
    assert.match(dockerfile, /^COPY docker\/agent-runtime\/omp-ssh\/git-reference\/git \/usr\/local\/bin\/git$/m);
    assert.match(dockerfile, /chmod 0755 \/usr\/local\/bin\/omp-runner-entrypoint \/usr\/local\/bin\/git/);
    assert.match(dockerfile, /node --check \/usr\/local\/bin\/git/);
    assert.doesNotMatch(dockerfile, /dpkg-divert/);
    // the interpreter the shebang names is really there
    assert.match(dockerfile, /test -x \/usr\/bin\/node/);
    assert.match(dockerfile, /test "\$\(head -n 1 \/usr\/local\/bin\/git\)" = '#!\/usr\/bin\/node'/);
    // the shadowing proof: with the image PATH, git resolves to the wrapper
    assert.match(dockerfile, /test "\$\(env -i PATH=\/usr\/local\/bin:\/usr\/bin:\/bin sh -c 'command -v git'\)" = \/usr\/local\/bin\/git/);
    // the wrapper runs: `git --version` through it equals the real git's
    assert.match(dockerfile, /real_git="\$\(\/usr\/bin\/git --version\)"/);
    assert.match(dockerfile, /wrapped_git="\$\(env -i PATH=\/usr\/local\/bin:\/usr\/bin:\/bin sh -c 'git --version'\)"/);
    assert.match(dockerfile, /test "\$wrapped_git" = "\$real_git"/);
    // ... and it is the wrapper that answers (a missing interpreter falls through to /usr/bin/git on PATH)
    assert.match(dockerfile, /test "\$\(env -i PATH=\/usr\/local\/bin:\/usr\/bin:\/bin MYRMIDON_GIT_REAL=\/bin\/echo sh -c 'git wrapper-ran'\)" = wrapper-ran/);
    // a check wrapped in echo cannot fail the build (a failed substitution still exits 0)
    assert.doesNotMatch(dockerfile, /echo "[^"\n]*\$\((?:env -i|\/usr\/bin\/git)/);
  });

  it("wires the pnpm store into the shared mount and falls back to the workspace volume per start", () => {
    // ENV cannot reach SSH sessions (PermitUserEnvironment no): the entrypoint
    // writes profile.d files, which /etc/profile sources for every command.
    assert.doesNotMatch(dockerfile, /^ENV npm_config_/m);
    assert.match(entrypoint, /\/etc\/profile\.d\/omp-runner-pnpm\.sh/);
    // OPE-13018: the shared store mount wins when the compose binds it; the
    // legacy per-runner store inside .paperclip-runtime is the fallback
    assert.match(entrypoint, /if \[ -d \/cache\/pnpm-store \]; then/);
    assert.match(entrypoint, /store_dir=\/cache\/pnpm-store/);
    assert.match(entrypoint, /npm_config_store_dir=\$store_dir/);
    assert.match(entrypoint, /store_dir=\/workspace\/\.paperclip-runtime\/pnpm-store/);
    assert.doesNotMatch(entrypoint, /^export npm_config_store_dir=\/workspace\/\.pnpm-store/m);
    // pnpm 9 copies silently when a reflink is refused: clone-or-copy everywhere, never `clone` alone
    assert.match(entrypoint, /^export npm_config_package_import_method=clone-or-copy$/m);
    assert.doesNotMatch(entrypoint, /package_import_method=clone(?![-\w])/);
    assert.doesNotMatch(entrypoint, /fail loudly/i);
    assert.match(entrypoint, /if \[ -d \/cache\/pnpm \]/);
    assert.match(entrypoint, /export npm_config_cache_dir=\/cache\/pnpm/);
    // npm's own cache variable points at the same shared directory: npm reads
    // `cache`, not pnpm's `cache-dir`, and its downloads would otherwise stay
    // in a per-runner ~/.npm (review criterion 2)
    assert.match(entrypoint, /^export npm_config_cache=\/cache\/pnpm$/m);
    assert.match(entrypoint, /npm reads it as cache/);
    // /cache/pnpm is chowned only while root owns it: a directory of another uid is never re-owned
    assert.match(entrypoint, /if \[ "\$cache_uid" = 0 \]; then\s+chown 1000:1000 \/cache\/pnpm/);
    assert.equal(entrypoint.match(/^\s*chown [^\n]*\/cache\/pnpm(?!-store)/gm)?.length, 1);
    // the store mount gets the same chown-guard as the cache mount
    assert.match(entrypoint, /chown 1000:1000 \/cache\/pnpm-store/);
    assert.match(entrypoint, /if \[ "\$cache_uid" = 1000 \]/);
    // the workspace must stay writable by uid 1000, or the store breaks
    assert.match(entrypoint, /chown 1000:1000 \/workspace/);
  });

  it("documents the cache, its rollout and the df measure in both README languages", () => {
    for (const doc of [readme, readmeRu]) {
      assert.match(doc, /OMP_RUNNER_CACHE_DIR/);
      assert.match(doc, /\/cache\/git/);
      assert.match(doc, /\/cache\/pnpm-store/);
      assert.match(doc, /\/workspace\/\.paperclip-runtime\/pnpm-store/);
      assert.match(doc, /<OMP_RUNNER_CACHE_DIR>\/pnpm-omp/);
      assert.match(doc, /<OMP_RUNNER_CACHE_DIR>\/pnpm-store-omp/);
      assert.match(doc, /install -d -o <(?:board uid|uid доски)> -m 0755 <OMP_RUNNER_CACHE_DIR>\/git/);
      assert.match(doc, /install -d -o 1000 -g 1000 -m 0755 <OMP_RUNNER_CACHE_DIR>\/pnpm-omp/);
      assert.match(doc, /install -d -o 1000 -g 1000 -m 0755 <OMP_RUNNER_CACHE_DIR>\/pnpm-store-omp/);
      assert.match(doc, /clone-or-copy/);
      assert.doesNotMatch(doc, /fail loudly/i);
      // the acceptance measure is the disk's used space, not `du` (it counts every link)
      assert.match(doc, /df --output=used -B1M/);
      assert.doesNotMatch(doc, /du -xs/);
    }
    // both tools' variables are documented: npm reads `cache`, pnpm `cache-dir`
    assert.match(readme, /npm_config_cache=\/cache\/pnpm/);
    assert.match(readmeRu, /npm_config_cache=\/cache\/pnpm/);
    assert.match(readme, /shared package download cache at \/cache\/pnpm/);
    assert.match(readmeRu, /shared package download cache at \/cache\/pnpm/);
    assert.match(readme, /### Updating a runner that already runs/);
    assert.match(readmeRu, /### Обновление работающего исполнителя/);
    // the OPE-13018 migration path is documented in both languages
    assert.match(readme, /### Migrating an existing runner to the shared pnpm store/);
    assert.match(readmeRu, /### Перенос работающего исполнителя на общее хранилище pnpm/);
  });
});

// The wrapper is CommonJS under a "type": "module" repository root, so the test
// loads a copy with a .cjs name from a temp directory. Nothing here needs git,
// Docker or the network: the "real git" of the process tests is a shell script.
describe("omp SSH runner git wrapper behaviour (OPE-12722)", () => {
  const WRAPPER_SRC = "docker/agent-runtime/omp-ssh/git-reference/git";
  const URL = "https://github.com/owner/repo.git";
  let tmp;
  let root; // mirror root with owner/repo.git (finished) and two half-written mirrors
  let mirror;
  let wrapperPath;
  let lib;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-git-wrapper-test-"));
    root = path.join(tmp, "mirrors");
    mirror = path.join(root, "owner", "repo.git");
    fs.mkdirSync(path.join(mirror, "objects"), { recursive: true });
    fs.writeFileSync(path.join(mirror, "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(root, "owner", "nohead.git", "objects"), { recursive: true });
    fs.mkdirSync(path.join(root, "owner", "noobjects.git"), { recursive: true });
    fs.writeFileSync(path.join(root, "owner", "noobjects.git", "HEAD"), "ref: refs/heads/main\n");
    wrapperPath = path.join(tmp, "git-wrapper.cjs");
    fs.copyFileSync(WRAPPER_SRC, wrapperPath);
    lib = createRequire(import.meta.url)(wrapperPath);
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** rewriteArgs against the test mirror root; the input array is frozen to prove it is never mutated. */
  const rewrite = (...argv) => lib.rewriteArgs(Object.freeze([...argv]), root);
  const withMirror = (...rest) => ["--reference-if-able", mirror, ...rest];

  it("adds --reference-if-able right after clone for a GitHub clone whose mirror exists", () => {
    assert.deepEqual(rewrite("clone", URL), ["clone", ...withMirror(URL)]);
    assert.deepEqual(rewrite("clone", URL, "dest"), ["clone", ...withMirror(URL, "dest")]);
    assert.deepEqual(rewrite("clone", "--branch", "main", "-q", URL, "dest"), ["clone", ...withMirror("--branch", "main", "-q", URL, "dest")]);
    assert.deepEqual(rewrite("clone", "--", URL, "dest"), ["clone", ...withMirror("--", URL, "dest")]);
  });

  it("recognises https, ssh and scp-like GitHub URLs, case-insensitively, onto the lower-case mirror path", () => {
    for (const url of [
      "https://github.com/owner/repo",
      "https://github.com/owner/repo.git",
      "https://github.com/Owner/Repo",
      "https://www.github.com/owner/repo/",
      "git@github.com:owner/repo.git",
      "ssh://git@github.com/owner/repo",
    ]) {
      assert.deepEqual(rewrite("clone", url), ["clone", ...withMirror(url)], url);
    }
  });

  it("skips global options and their values when it looks for the subcommand", () => {
    assert.deepEqual(rewrite("-C", "/work", "-c", "protocol.version=2", "clone", URL), ["-C", "/work", "-c", "protocol.version=2", "clone", ...withMirror(URL)]);
    assert.deepEqual(rewrite("--no-pager", "clone", URL), ["--no-pager", "clone", ...withMirror(URL)]);
    // a value that spells `clone` is not the subcommand
    assert.deepEqual(rewrite("-C", "clone", "status"), ["-C", "clone", "status"]);
    assert.deepEqual(rewrite("-c", "clone=x", "status"), ["-c", "clone=x", "status"]);
  });

  it("finds the URL past clone options that take a value, and keeps limits and named references", () => {
    assert.deepEqual(rewrite("clone", "-c", "core.autocrlf=false", URL), ["clone", ...withMirror("-c", "core.autocrlf=false", URL)]);
    assert.deepEqual(rewrite("clone", "--depth", "1", URL), ["clone", ...withMirror("--depth", "1", URL)]);
    assert.deepEqual(rewrite("clone", "--depth=1", "--no-local", URL), ["clone", ...withMirror("--depth=1", "--no-local", URL)]);
    // a caller's own --reference does not decide where objects live: the mirror is added next to it
    assert.deepEqual(rewrite("clone", "--reference", "/elsewhere/x.git", URL), ["clone", ...withMirror("--reference", "/elsewhere/x.git", URL)]);
  });

  it("leaves clones that decide the storage of their own objects alone", () => {
    for (const opt of [["--dissociate"], ["--shared"], ["-s"], ["--local"], ["-l"], ["--mirror"], ["--filter=blob:none"], ["--filter", "blob:none"]]) {
      const argv = ["clone", ...opt, URL];
      assert.deepEqual(rewrite(...argv), argv, opt.join(" "));
    }
  });

  it("changes nothing for other hosts, other subcommands and incomplete input", () => {
    for (const argv of [
      ["clone", "https://gitlab.com/owner/repo.git"],
      ["clone", "https://github.com.evil.example/owner/repo.git"],
      ["clone", "https://github.com/owner"],
      ["clone", "https://github.com/owner/repo/extra"],
      ["clone", "/local/path/repo"],
      ["clone", "file:///srv/repo.git"],
      ["fetch", URL],
      ["remote", "add", "origin", URL],
      ["submodule", "add", URL],
      ["status"],
      ["--version"],
      ["clone"],
      ["clone", "--branch"],
      [],
    ]) {
      assert.deepEqual(rewrite(...argv), argv, argv.join(" "));
    }
  });

  it("cannot be pointed at another path by the URL, and ignores a mirror that is not finished", () => {
    for (const url of [
      "https://github.com/owner/..",
      "https://github.com/../repo",
      "https://github.com/-owner/repo",
      "https://github.com/owner/re po",
    ]) {
      assert.deepEqual(rewrite("clone", url), ["clone", url], url);
    }
    // no mirror, no HEAD, no objects directory: the clone runs unchanged
    for (const name of ["missing", "nohead", "noobjects"]) {
      const argv = ["clone", `https://github.com/owner/${name}.git`];
      assert.deepEqual(rewrite(...argv), argv, name);
    }
    assert.equal(lib.mirrorFor("owner/repo", root), mirror);
    assert.equal(lib.mirrorFor("owner/nohead", root), null);
    assert.equal(lib.githubRepo("https://github.com/Owner/Repo.git"), "owner/repo");
    assert.equal(lib.githubRepo("https://example.com/owner/repo"), null);
  });

  // Process level: the wrapper's main() with a shell script as the "real git".
  const fake = (name, body) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const run = (argv, env) =>
    spawnSync(process.execPath, [wrapperPath, ...argv], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, MYRMIDON_GIT_MIRROR_ROOT: root, ...env },
    });

  it("runs the real git with the rewritten argv, no prompts, and passes its exit status through", () => {
    const out = path.join(tmp, "argv.txt");
    const real = fake("real-git", `printf '%s\\n' "$@" > "${out}"; printf 'prompt=%s wrapped=%s\\n' "$GIT_TERMINAL_PROMPT" "$MYRMIDON_GIT_WRAPPED" >> "${out}"; exit "\${FAKE_EXIT:-0}"`);
    const ok = run(["clone", URL, "dest"], { MYRMIDON_GIT_REAL: real });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(fs.readFileSync(out, "utf8").trim().split("\n"), ["clone", "--reference-if-able", mirror, URL, "dest", "prompt=0 wrapped=1"]);
    const failed = run(["status"], { MYRMIDON_GIT_REAL: real, FAKE_EXIT: "7" });
    assert.equal(failed.status, 7);
    assert.deepEqual(fs.readFileSync(out, "utf8").trim().split("\n"), ["status", "prompt=0 wrapped=1"]);
  });

  it("falls back to the image git under the fork-loop mark and reports a git that cannot start", () => {
    const real = fake("real-git-2", "echo REAL");
    const image = fake("image-git", "echo IMAGE");
    // a MYRMIDON_GIT_REAL that runs `git` from PATH again lands back in the wrapper: it must not start it twice
    const marked = run(["--version"], { MYRMIDON_GIT_REAL: real, MYRMIDON_GIT_IMAGE: image, MYRMIDON_GIT_WRAPPED: "1" });
    assert.equal(marked.stdout.trim(), "IMAGE");
    const unmarked = run(["--version"], { MYRMIDON_GIT_REAL: real, MYRMIDON_GIT_IMAGE: image });
    assert.equal(unmarked.stdout.trim(), "REAL");
    const missing = run(["--version"], { MYRMIDON_GIT_IMAGE: path.join(tmp, "no-such-git") });
    assert.equal(missing.status, 127);
    assert.match(missing.stderr, /git: cannot run /);
  });
});
