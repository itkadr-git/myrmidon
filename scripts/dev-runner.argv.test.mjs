import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import * as url from "node:url";

const sourceUrl = new URL("./dev-runner.mjs", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const bootstrap = "\nawait maybePreflightMigrations();";
assert.equal(source.split(bootstrap).length, 2);

async function launch(args = [], hostEnv = {}) {
  const before = { ...hostEnv };
  const calls = [];
  const processMock = {
    argv: ["node", url.fileURLToPath(sourceUrl), ...args],
    env: hostEnv,
    platform: "linux",
    on() {},
    exit() { throw new Error("unexpected process.exit"); },
    stderr: { write() { throw new Error("unexpected stderr"); } },
  };
  const fail = () => { throw new Error("unexpected external call"); };
  const spawn = (command, argv, options) => {
    calls.push({ command, argv: [...argv], env: { ...options.env } });
    const child = new EventEmitter();
    if (argv.includes("src/migration-status.ts")) {
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
    }
    if (argv.includes("build") || argv.includes("src/migration-status.ts")) {
      queueMicrotask(() => {
        if (child.stdout) child.stdout.emit("data", Buffer.from('{"status":"current"}'));
        child.emit("exit", 0, null);
      });
    }
    child.kill = fail;
    return child;
  };
  const fsMock = { existsSync: () => false, mkdirSync() {}, readdirSync: fail, rmSync: fail, statSync: fail, writeFileSync() {} };
  const output = await import("./dev-runner-output.mjs");
  const paths = await import("./dev-runner-paths.mjs");
  const imports = {
    "node:child_process": { spawn },
    "node:crypto": { randomUUID: () => "test-token" },
    "node:fs": fsMock,
    "node:path": { default: path },
    "node:readline/promises": { createInterface: fail },
    "node:process": { stdin: {}, stdout: {} },
    "node:url": { fileURLToPath: url.fileURLToPath },
    "./dev-runner-output.mjs": output,
    "./dev-runner-paths.mjs": paths,
  };
  const context = vm.createContext({ process: processMock, console: { log() {}, error: fail }, fetch: fail,
    setTimeout: fail, clearTimeout: fail, setInterval: fail, clearInterval: fail, Buffer });
  const module = new vm.SourceTextModule(source.slice(0, source.indexOf(bootstrap)) + "\nexport { startServerChild };\n", {
    context, identifier: sourceUrl.href, initializeImportMeta(meta) { meta.url = sourceUrl.href; },
  });
  await module.link((specifier) => {
    assert.ok(Object.hasOwn(imports, specifier), `unexpected import ${specifier}`);
    const values = imports[specifier];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  await module.namespace.startServerChild();
  assert.deepEqual(hostEnv, before, "runner must not mutate host environment");
  assert.deepEqual(calls.map((call) => call.argv.slice(0, 3)), [
    ["--filter", "@myrmidon/plugin-sdk", "build"],
    ["--filter", "@myrmidon/server", args[0] === "watch" ? "dev:watch" : "dev"],
    ["--filter", "@myrmidon/db", "exec"],
  ]);
  return calls[1];
}

const authValues = {
  PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
  PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
  PAPERCLIP_AUTH_BASE_URL_MODE: "auto",
  HOST: "0.0.0.0",
};

test("missing and unknown modes use dev; unknown forwarded arguments retain order", async () => {
  for (const args of [[], ["unknown", "--other", "value", "--last"]]) {
    const call = await launch(args);
    assert.deepEqual(call.argv, ["--filter", "@myrmidon/server", "dev", ...args.slice(1)]);
    assert.equal(call.env.PAPERCLIP_UI_DEV_MIDDLEWARE, "true");
    assert.equal(call.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN, "test-token");
    assert.equal(call.env.PAPERCLIP_DEV_SERVER_STATUS_FILE, path.join(path.dirname(url.fileURLToPath(sourceUrl)), "..", ".paperclip", "dev-server-status.json"));
  }
});

test("watch removes token and uses defaults only for absent migration values", async () => {
  for (const [input, prompt, auto] of [
    [{ PAPERCLIP_DEV_SERVER_STATUS_TOKEN: "old" }, "never", "true"],
    [{ PAPERCLIP_DEV_SERVER_STATUS_TOKEN: "old", PAPERCLIP_MIGRATION_PROMPT: "ask", PAPERCLIP_MIGRATION_AUTO_APPLY: "false" }, "ask", "false"],
    [{ PAPERCLIP_MIGRATION_PROMPT: "", PAPERCLIP_MIGRATION_AUTO_APPLY: "" }, "", ""],
  ]) {
    const call = await launch(["watch", "--extra"], input);
    assert.deepEqual(call.argv, ["--filter", "@myrmidon/server", "dev:watch", "--extra"]);
    assert.equal(Object.hasOwn(call.env, "PAPERCLIP_DEV_SERVER_STATUS_TOKEN"), false);
    assert.equal(call.env.PAPERCLIP_MIGRATION_PROMPT, prompt);
    assert.equal(call.env.PAPERCLIP_MIGRATION_AUTO_APPLY, auto);
  }
});

test("both tailscale aliases are removed without changing other argument order", async () => {
  for (const flag of ["--tailscale-auth", "--authenticated-private"]) {
    const call = await launch(["dev", "one", flag, "--unknown", flag, "two"], { HOST: "old" });
    assert.deepEqual(call.argv, ["--filter", "@myrmidon/server", "dev", "one", "--unknown", "two"]);
    for (const [key, value] of Object.entries(authValues)) assert.equal(call.env[key], value);
  }
  const both = await launch(["watch", "a", "--tailscale-auth", "b", "--authenticated-private", "c"]);
  assert.deepEqual(both.argv, ["--filter", "@myrmidon/server", "dev:watch", "a", "b", "c"]);
});

test("each npm config flag enables auth only for the exact true value", async () => {
  for (const key of ["npm_config_tailscale_auth", "npm_config_authenticated_private"]) {
    for (const value of ["true", "false", "TRUE", ""]) {
      const original = { [key]: value, PAPERCLIP_DEPLOYMENT_MODE: "existing", PAPERCLIP_DEPLOYMENT_EXPOSURE: "existing", PAPERCLIP_AUTH_BASE_URL_MODE: "existing", HOST: "existing" };
      const call = await launch(["dev"], original);
      for (const [name, expected] of Object.entries(authValues)) {
        assert.equal(call.env[name], value === "true" ? expected : "existing", `${key}=${value}: ${name}`);
      }
    }
  }
});
