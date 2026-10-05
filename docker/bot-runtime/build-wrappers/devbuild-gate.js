// docker/bot-runtime/build-wrappers/devbuild-gate.js
//
// myrmidon(1.6.1 BUILD-OFFLOAD A): the shared gate every build-wrapper
// (pnpm / tsc / vitest / gradle / go) consults before running anything.
// Heavy repository operations — package installs, monorepo typechecks,
// test suites, compiler builds — belong on the build VPS through the
// `devbuild` CLI, not inside a bot container, where they are slow, CPU-
// and memory-starving and fight the gateway for the container's budget.
// The wrappers turn that policy into a physical barrier: the real
// binaries stay reachable (by the absolute paths each wrapper records),
// but the bare names on PATH refuse until the devbuild gateway is
// present.
//
// The gateway is a FILE, not an env variable: devbuild itself is only
// ever mounted into a container by the build-VPS side (part B of
// BUILD-OFFLOAD mounts /usr/local/bin/devbuild into the per-invocation
// container). An env-based gate would need a variable baked into the
// image (dockergate forbids ENV/BASH_ENV) or set per run — and the
// whole point is that the wrapper must stay closed inside the ordinary
// bot container, where no such variable can appear. The presence of the
// devbuild executable is the one condition both sides can check
// without sharing any secret, address or token: the wrapper never
// learns the build host's name, and the image carries no internal
// addresses (they arrive with devbuild's own environment, part B).
//
// Exits non-zero with a stderr message naming the command that was
// refused and its devbuild replacement. Nothing is printed to stdout
// and no command runs: refusal must be loud, not partial.
//
// CJS on purpose, like the github-broker wrappers: in the image this
// file lives at /opt/paperclip/bin/ (no package.json above /opt), so
// Node loads it as CommonJS. The repository's "type": "module" does
// not reach there — module resolution walks up from the file's own
// path, not from the caller's cwd.

"use strict";

const fs = require("node:fs");

// The single gateway condition. devbuild is mounted at a fixed path by
// the build-VPS driver (see the task-B container driver); the file must
// exist AND be executable — a plain placeholder file is not a gateway.
function devbuildPresent() {
  const DEVBUILD_PATH = "/usr/local/bin/devbuild";
  try {
    const stat = fs.statSync(DEVBUILD_PATH);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

// Message for a refusal: what ran, why it is refused, what to run
// instead. `tool` is the name the user typed; `argv` carries the rest.
function refusalMessage(tool, argv = []) {
  const args = argv.join(" ");
  const invocation = args ? `${tool} ${args}` : tool;
  return [
    `${tool}: heavy build operations are blocked inside the bot container (1.6.1 BUILD-OFFLOAD).`,
    `Refused: ${invocation}`,
    "Installs, monorepo typechecks, test suites and compiler builds run on the build VPS.",
    `Instead run:  devbuild ${invocation}`,
    "(devbuild mounts this workspace into a build container and runs the same command there;",
    "the devbuild gateway is not present in this container, so local execution is disabled.)",
  ].join("\n");
}

module.exports = { devbuildPresent, refusalMessage };

// Direct execution prints the gate's own state — used by the build-time
// contract check to prove the gate is closed by default.
if (require.main === module) {
  process.stderr.write(
    [
      "devbuild-gate: heavy build operations are blocked inside the bot container (1.6.1 BUILD-OFFLOAD).",
      devbuildPresent()
        ? "The devbuild gateway is PRESENT (/usr/local/bin/devbuild): wrapped tools pass through."
        : "The devbuild gateway is ABSENT: wrapped tools (pnpm install, tsc, vitest, gradle, go) refuse.",
      "Run the heavy command through devbuild instead: devbuild <tool> <args...>",
    ].join("\n") + "\n",
  );
}
