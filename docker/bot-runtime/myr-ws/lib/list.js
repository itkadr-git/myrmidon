// myrmidon(1.6.5 BOT-DISK-H2c): `myr-ws list` — the inventory command of the
// H0 contract (C2): over the registry, the bases' `git worktree list
// --porcelain` and the workspace/scratch roots it prints every copy with
// {key, path, class, repo?, branch?, openedAt, clean, pushed}. `--json` emits
// exactly myrWsListResultSchema; the human output is one line per copy.
// Missing registry targets (a copy the bot deleted with rm -rf) are listed
// with clean/pushed unknown and marked missing. Exit codes come from the
// contract's MYR_WS_EXIT (0 ok, 2 bad arguments; unexpected failures are
// reported as exitCode 1 in the error shape).

import { inventory, toListEntry } from "./inventory.js";

const USAGE = "usage: myr-ws list [--json]";

function fail(json, error, exitCode) {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, error, exitCode }) + "\n");
  } else {
    process.stderr.write(error + "\n");
  }
  process.exit(exitCode);
}

export function runList(argv, io = process) {
  const json = argv.includes("--json");
  for (const arg of argv) {
    if (arg !== "--json") {
      fail(true, `${USAGE}; unknown argument: ${arg}`, 2);
    }
  }
  let inv;
  try {
    inv = inventory({ env: io.env });
  } catch (err) {
    fail(json, `myr-ws list: ${err && err.message ? err.message : String(err)}`, 1);
  }
  const entries = inv.copies.map(toListEntry);
  if (json) {
    io.stdout.write(JSON.stringify({ ok: true, entries }) + "\n");
  } else {
    for (const e of entries) {
      const flags = [];
      if (e.missing) flags.push("missing");
      else {
        flags.push(e.clean ? "clean" : "dirty");
        flags.push(e.pushed ? "pushed" : "unpushed");
      }
      io.stdout.write(
        `${e.key}\t${e.class}\t${e.path}${e.branch ? `\t${e.branch}` : ""}\t${flags.join(",")}\n`,
      );
    }
  }
  return 0;
}
