"use strict";
// myrmidon(1.6.5 BOT-DISK-H2c): `myr-ws list` — the inventory command of the
// H0 contract (C2): over the registry, the bases' `git worktree list
// --porcelain` and the workspace/scratch roots it prints every copy with
// {key, path, class, repo?, branch?, openedAt, clean, pushed}. `--json` emits
// exactly myrWsListResultSchema; the human output is one line per copy.
// Missing registry targets (a copy the bot deleted with rm -rf) are listed
// with clean/pushed unknown and marked missing. Errors are MyrWsError: bad
// arguments exit 2 (EXIT.usage), unexpected failures exit 1.

const { inventory, toListEntry } = require("./inventory.js");
const { MyrWsError } = require("./errors.js");
const { EXIT } = require("./base.js");

const USAGE = "usage: myr-ws list [--json]";

function humanLines(entries) {
  return entries
    .map((e) => {
      const flags = [];
      if (e.missing) flags.push("missing");
      else {
        flags.push(e.clean ? "clean" : "dirty");
        flags.push(e.pushed ? "pushed" : "unpushed");
      }
      return `${e.key}\t${e.class}\t${e.path}${e.branch ? `\t${e.branch}` : ""}\t${flags.join(",")}\n`;
    })
    .join("");
}

/** cli handler: ({ positionals, flags, env }) -> { entries, human } */
function list({ positionals, env }) {
  if (positionals.length > 0) throw new MyrWsError(EXIT.usage, `${USAGE}; unknown argument: ${positionals[0]}`);
  let inv;
  try {
    inv = inventory({ env });
  } catch (err) {
    throw new MyrWsError(1, `myr-ws list: ${err && err.message ? err.message : String(err)}`);
  }
  const entries = inv.copies.map(toListEntry);
  return { entries, human: humanLines(entries) };
}

module.exports = { list };
