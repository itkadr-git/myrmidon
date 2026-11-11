// myrmidon(OPE-12633 OMP-SSH-RUNNER): contract of the omp SSH runner image —
// pinned toolchain, key-only sshd, and the signed CI image lane.
// myrmidon(OPE-12722 OMP-RUNNER-SHARED-CACHE): the shared package cache —
// board git mirrors read through the wrapper, the npm/pnpm download cache,
// and the per-runner pnpm store in the workspace volume.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

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
    // the runner data never lands in /var/lib/docker on the root disk (10.11: +10 GB on the root in an hour)
    for (const v of ["workspace", "home", "hostkeys"]) {
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

// myrmidon(OPE-12722 OMP-RUNNER-SHARED-CACHE): the runner shares the board's
// package cache the way the bot containers do — git mirrors read-only through
// a wrapper, the npm/pnpm download cache read-write, and the pnpm STORE in the
// workspace volume (a link cannot cross a filesystem boundary).
describe("omp SSH runner shared cache (OPE-12722)", () => {
  it("mounts the shared cache: git mirrors read-only, the download cache writable", () => {
    assert.match(compose, /\$\{OMP_RUNNER_CACHE_DIR:\?set OMP_RUNNER_CACHE_DIR\}\/git:\/cache\/git:ro/);
    assert.match(compose, /\$\{OMP_RUNNER_CACHE_DIR:\?set OMP_RUNNER_CACHE_DIR\}\/pnpm:\/cache\/pnpm$/m);
    // the store must never be reached through the /cache bind (EXDEV, BOT-DISK-D)
    assert.doesNotMatch(compose, /pnpm-store/);
    assert.match(compose, /OMP_RUNNER_CACHE_DIR +is the/);
    assert.match(compose, /install -d -o 1000 -g 1000/);
  });
  it("ships a consume-only git wrapper that references the board's mirror", () => {
    // the wrapper is CommonJS (the repo root package.json is "type": "module");
    // the sibling marker matches the bot wrapper's (984781988)
    assert.equal(wrapperPkg.type, "commonjs");
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

  it("installs the wrapper on PATH ahead of the real git and smoke-checks it", () => {
    assert.match(dockerfile, /^COPY docker\/agent-runtime\/omp-ssh\/git-reference\/git \/usr\/local\/bin\/git$/m);
    assert.match(dockerfile, /chmod 0755 \/usr\/local\/bin\/omp-runner-entrypoint \/usr\/local\/bin\/git/);
    assert.match(dockerfile, /node --check \/usr\/local\/bin\/git/);
    // the shadowing proof: with the image PATH, git resolves to the wrapper
    assert.match(dockerfile, /env -i PATH=\/usr\/local\/bin:\/usr\/bin:\/bin sh -c 'command -v git'/);
    assert.match(dockerfile, /\/usr\/bin\/git --version/);
    assert.doesNotMatch(dockerfile, /dpkg-divert/);
  });

  it("wires the pnpm store into the workspace volume and the download cache per start", () => {
    // ENV cannot reach SSH sessions (PermitUserEnvironment no): the entrypoint
    // writes profile.d files, which /etc/profile sources for every command.
    assert.doesNotMatch(dockerfile, /^ENV npm_config_/m);
    assert.match(entrypoint, /\/etc\/profile\.d\/omp-runner-pnpm\.sh/);
    assert.match(entrypoint, /export npm_config_store_dir=\/workspace\/\.pnpm-store/);
    assert.match(entrypoint, /export npm_config_package_import_method=clone/);
    assert.match(entrypoint, /if \[ -d \/cache\/pnpm \]/);
    assert.match(entrypoint, /export npm_config_cache_dir=\/cache\/pnpm/);
    assert.match(entrypoint, /chown 1000:1000 \/cache\/pnpm/);
    // the workspace must stay writable by uid 1000, or the store breaks
    assert.match(entrypoint, /chown 1000:1000 \/workspace/);
  });

  it("documents the cache in both README languages", () => {
    for (const doc of [readme, readmeRu]) {
      assert.match(doc, /OMP_RUNNER_CACHE_DIR/);
      assert.match(doc, /\/cache\/git/);
      assert.match(doc, /\/workspace\/\.pnpm-store/);
    }
    // the acceptance measure named in the issue
    assert.match(readme, /du -xs/);
    assert.match(readmeRu, /du -xs/);
  });
});
