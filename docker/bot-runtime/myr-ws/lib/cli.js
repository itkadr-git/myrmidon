"use strict";
// myrmidon(1.6.5 BOT-DISK-H2a): the shared CLI frame of `myr-ws` — command
// parsing, exit codes (contract C2) and --json output. open/list/close/restore/
// migrate are stubs here ("not implemented", exit 2); their tasks replace the handlers
// in COMMANDS.

const { EXIT } = require("./base.js");
const { MyrWsError } = require("./errors.js");

// Each verb lives in its own module lib/<verb>.js. A verb module exports its
// core function; cli.js adapts the parsed command line ({ positionals, flags,
// env }) to it. Handlers return the body of the --json answer (without "ok")
// and throw MyrWsError (exitCode) on failure.
function requireVerb(name) {
  try {
    return require(`./${name}.js`);
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND" && String(e.message).includes(`/${name}.js`)) return null;
    throw e;
  }
}

const ADAPTERS = {
  open: (mod) => ({ positionals, flags, env }) =>
    mod.open(
      mod.resolveOpenRequest({ positional: positionals, base: flags.base ?? null, scratch: flags.scratch === true, scratchName: null, json: false }),
      { env },
    ),
  list: (mod) => mod.list,
  close: (mod) => mod.close,
  restore: (mod) => ({ positionals, env }) => mod.restore(mod.resolveRestoreRequest({ positional: positionals }), { env }),
  migrate: (mod) => mod.command,
};

function loadVerb(name) {
  const mod = requireVerb(name);
  return mod ? ADAPTERS[name](mod) : notImplemented(name);
}

const COMMANDS = {
  open: loadVerb("open"),
  list: loadVerb("list"),
  close: loadVerb("close"),
  restore: loadVerb("restore"),
  migrate: loadVerb("migrate"),
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
    } else if (a.startsWith("--")) throw new MyrWsError(EXIT.usage, `unknown argument ${a}`);
    else positionals.push(a);
  }
  const [command, ...rest] = positionals;
  return { command, positionals: rest, flags };
}

/**
 * Runs the CLI (async: handlers may return promises). Resolves to { exitCode, stdout, stderr } without touching the
 * process, so tests and the entry point share it. With --json a failure prints
 * the contract error shape { ok:false, error, exitCode } on stdout.
 */
async function run(argv, ctx = {}) {
  const commands = ctx.commands || COMMANDS;
  let json = argv.includes("--json");
  try {
    if (argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) return { exitCode: EXIT.ok, stdout: `${USAGE}\n`, stderr: "" };
    const { command, positionals, flags } = parseArgs(argv);
    json = flags.json;
    if (!command || !Object.prototype.hasOwnProperty.call(commands, command)) {
      throw new MyrWsError(EXIT.usage, command ? `unknown command "${command}". ${USAGE}` : USAGE);
    }
    const result = await commands[command]({ positionals, flags, env: ctx.env || process.env });
    const { human, ...rest } = result || {};
    const body = { ok: true, ...rest };
    return { exitCode: EXIT.ok, stdout: json ? `${JSON.stringify(body)}\n` : humanLine(body, human), stderr: "" };
  } catch (e) {
    const exitCode = e && Number.isInteger(e.exitCode) ? e.exitCode : 1;
    const error = (e && e.message) || String(e);
    if (json) return { exitCode, stdout: `${JSON.stringify({ ok: false, error, exitCode })}\n`, stderr: "" };
    return { exitCode, stdout: "", stderr: `myr-ws: ${error}\n` };
  }
}

function humanLine(body, human) {
  if (typeof human === "string") return human;
  return body.path ? `${body.path}\n` : "ok\n";
}

module.exports = { run, parseArgs, COMMANDS, USAGE };
