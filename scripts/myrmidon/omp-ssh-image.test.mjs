// myrmidon(OPE-12633 OMP-SSH-RUNNER): contract of the omp SSH runner image —
// pinned toolchain, key-only sshd, and the signed CI image lane.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

const dockerfile = fs.readFileSync("docker/agent-runtime/Dockerfile.omp-ssh", "utf8");
const sshd = fs.readFileSync("docker/agent-runtime/omp-ssh/sshd_config", "utf8");
const entrypoint = fs.readFileSync("docker/agent-runtime/omp-ssh/entrypoint.sh", "utf8");
const compose = fs.readFileSync("docker/agent-runtime/omp-ssh/compose.yml", "utf8");
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
  });

  it("publishes only through the signed CI image lane", () => {
    assert.match(bake, /target "omp-ssh"/);
    assert.match(bake, /agent-runtime-omp-ssh:\$\{VERSION\}/);
    assert.match(workflow, /docker buildx bake[\s\S]*?omp omp-ssh/);
    assert.match(workflow, /Cosign sign omp-ssh/);
    assert.match(workflow, /agent-runtime-omp-ssh@\$\{\{ steps\.bake\.outputs\.omp_ssh_digest \}\}/);
  });
});
