"use strict";
// myrmidon(1.6.5 BOT-DISK-H2a): the shared CLI frame of `myr-ws` — command
// parsing, exit codes (contract C2) and --json output. open/list/close/restore
// are stubs here ("not implemented", exit 2); their tasks replace the handlers
// in COMMANDS.

const { MyrWsError, EXIT } = require("./base.js");

const COMMANDS = {
  open: notImplemented("open"),
  list: notImplemented("list"),
  close: notImplemented("close"),
  restore: notImplemented("restore"),
};

function notImplemented(name) {
  return () => {
    throw new MyrWsError(EXIT.usage, `myr-ws ${name}: not implemented`);
  };
}

const USAGE =
  "usage: myr-ws <open <KEY> [owner/repo] [--base <ref>] [--scratch] | list | close <KEY> [--force] | restore <KEY>> [--json]";

/** Splits argv into { command, positionals, flags } (flags: --json, --scratch, --force, --base <ref>). */
function parseArgs(argv) {
  const positionals = [];
  const flags = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--scratch") flags.scratch = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--base") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new MyrWsError(EXIT.usage, "--base needs a ref");
      flags.base = v;
    } else if (a.startsWith("--")) throw new MyrWsError(EXIT.usage, `unknown option ${a}`);
    else positionals.push(a);
  }
  const [command, ...rest] = positionals;
  return { command, positionals: rest, flags };
}

/**
 * Runs the CLI. Returns { exitCode, stdout, stderr } without touching the
 * process, so tests and the entry point share it. With --json a failure prints
 * the contract error shape { ok:false, error, exitCode } on stdout.
 */
function run(argv, ctx = {}) {
  const commands = ctx.commands || COMMANDS;
  let json = argv.includes("--json");
  try {
    const { command, positionals, flags } = parseArgs(argv);
    json = flags.json;
    if (!command || !Object.prototype.hasOwnProperty.call(commands, command)) {
      throw new MyrWsError(EXIT.usage, command ? `unknown command "${command}". ${USAGE}` : USAGE);
    }
    const result = commands[command]({ positionals, flags, env: ctx.env || process.env });
    const body = { ok: true, ...(result || {}) };
    return { exitCode: EXIT.ok, stdout: json ? `${JSON.stringify(body)}\n` : humanLine(body), stderr: "" };
  } catch (e) {
    const exitCode = e instanceof MyrWsError ? e.exitCode : 1;
    const error = (e && e.message) || String(e);
    if (json) return { exitCode, stdout: `${JSON.stringify({ ok: false, error, exitCode })}\n`, stderr: "" };
    return { exitCode, stdout: "", stderr: `myr-ws: ${error}\n` };
  }
}

function humanLine(body) {
  return body.path ? `${body.path}\n` : "ok\n";
}

module.exports = { run, parseArgs, COMMANDS, USAGE };
