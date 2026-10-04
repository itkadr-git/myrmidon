// docker/bot-runtime/build-wrappers/blocked-tool.js
//
// myrmidon(1.6.1 BUILD-OFFLOAD A): the generic wrapper body for tools
// whose EVERY invocation is a heavy build operation — tsc (monorepo
// typecheck), vitest (test suites), gradle (JVM builds), go (compiler
// builds and test compilations). Unlike pnpm none of them has a
// lightweight subcommand worth letting through beyond a version probe,
// and a full `tsc --noEmit` on the monorepo is exactly the workload
// that must move to the build VPS.
//
// Used by the wrapper scripts in this directory (tsc, vitest, gradle,
// go), each of which names itself and points at the real binary (by
// absolute path or by a PATH walk that skips the wrapper's own
// directory). When the devbuild gateway (/usr/local/bin/devbuild,
// mounted by the BUILD-OFFLOAD part-B driver) is present, the wrapper
// execs the real binary; otherwise it refuses with exit 1 and a stderr
// message naming the exact devbuild replacement command.
//
// `--version`/`-v`/`--help` pass through even without the gateway: a
// version probe is not a build, and scripts that only ask a tool what
// it is must keep working in the ordinary bot container.
//
// No secrets and no addresses: the wrapper reads only argv, the
// gateway file and the real binary's path it was configured with.
//
// CJS on purpose (see devbuild-gate.js): in the image this file lives
// at /opt/paperclip/bin/, which no package.json reaches.

"use strict";

const { spawn } = require("node:child_process");
const { devbuildPresent, refusalMessage } = require("./devbuild-gate.js");

const VERSION_PROBES = new Set(["--version", "-v", "version", "-V", "--help", "-h", "help"]);

// A bare version/help probe: every argument is a probe flag.
function isVersionProbe(argv) {
  return argv.length > 0 && argv.every((a) => VERSION_PROBES.has(a) || a.startsWith("-"));
}

function runReal(realPath, argv) {
  const child = spawn(realPath, argv, { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.once("error", (err) => {
    process.stderr.write(`${process.argv[0]} wrapper: cannot exec ${realPath}: ${err.message}\n`);
    process.exitCode = 127;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code === null ? (signal ? 128 : 1) : code;
  });
}

// makeWrapper(tool, realPath) builds the wrapper entry point for one
// tool. `tool` is what the user typed (and what the refusal message
// quotes back); `realPath` is the absolute path of the real binary.
function makeWrapper(tool, realPath) {
  return function main() {
    const argv = process.argv.slice(2);
    if (devbuildPresent() || isVersionProbe(argv)) {
      runReal(realPath, argv);
      return;
    }
    process.stderr.write(refusalMessage(tool, argv) + "\n");
    process.exitCode = 1;
  };
}

module.exports = { makeWrapper, runReal, isVersionProbe, devbuildPresent };
