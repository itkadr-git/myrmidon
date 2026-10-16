#!/usr/bin/env tsx
// scripts/procs-dev.ts
//
// myrmidon(1.6.6 PROCS-T1.5): one-command launch of the SPLIT board — N api
// processes + M worker processes in one terminal. The ticket's acceptance
// criterion is literally:
//
//   MYRMIDON_API_PROCESSES=2 MYRMIDON_WORKER_PROCESSES=2 pnpm dev:procs
//
// What this runner is allowed to be: a thin loop over the launch card that
// `buildProcessMap` + `buildLaunchPlan` already produced (pure code under
// server/src/myrmidon/process-orchestrator, pinned by tests). The runner
// spawns each child in order (workers first), prefixes its output with the
// card name, waits for its `/api/health` before the next entry, and stops
// everything on SIGINT/SIGTERM or when a child exits on its own.
//
// What it is NOT: the production supervisor. PROCS-1.2 owns restart policy,
// a crash loop, drain and a registry lifecycle; T1.5 deliberately has no
// restart — a dev stand that dies loudly teaches more than one that
// respawns in a loop. Do not add restart here.
//
// Storage note (design §2): the split stand shares one Postgres. With no
// DATABASE_URL the children fall through to embedded PostgreSQL, which has a
// pid-file reuse protocol (server/src/index.ts: a live postmaster.pid with a
// matching data directory is reused, not re-bootstrapped). The plan is
// started sequentially behind the health gate — worker-0 first — so exactly
// one child owns the bootstrap (initdb + start + migrations) and every later
// child reuses the running instance. An external DATABASE_URL overrides this
// as usual. Parallel bootstrap would corrupt the data directory, which is
// why the runner never spawns two children at once.

import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  API_COUNT_ENV,
  API_COUNT_MAX,
  RECOMMENDED_API_COUNT,
  RECOMMENDED_WORKER_COUNT,
  WORKER_COUNT_ENV,
  buildProcessMap,
  describeProcessMap,
  exceedsRecommendedWorkerCount,
} from "../server/src/myrmidon/process-orchestrator/config.js";
import { buildLaunchPlan, serverPackageRoot } from "../server/src/myrmidon/process-orchestrator/launcher.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noBuild = args.includes("--no-build");

function usage(): never {
  console.error(
    [
      "usage: pnpm dev:procs [--dry-run] [--no-build]",
      "",
      "  launches the split board from the env card:",
      `    ${API_COUNT_ENV}=N  (1..${API_COUNT_MAX}, default ${RECOMMENDED_API_COUNT})`,
      `    ${WORKER_COUNT_ENV}=M (1..2, default ${RECOMMENDED_WORKER_COUNT}; design rule 3 keeps prod at 1)`,
      "  PORT / MYRMIDON_WORKER_PORT / MYRMIDON_WORKER_HOST /",
      "  MYRMIDON_API_PORT_STRIDE refine the map; see docs/myrmidon/SETTINGS.md.",
      "",
      "  --dry-run   print the launch card and exit (spawns nothing)",
      "  --no-build  skip the one-time dependency builds (plugin sdk, ui)",
    ].join("\n"),
  );
  process.exit(2);
}

for (const arg of args) {
  if (arg !== "--dry-run" && arg !== "--no-build" && arg !== "--help" && arg !== "-h") {
    console.error(`[dev:procs] unknown argument: ${arg}`);
    usage();
  }
}
if (args.includes("--help") || args.includes("-h")) usage();

const env: NodeJS.ProcessEnv = { ...process.env, PAPERCLIP_PROCESS_MODE: "split" };
// Same normalization `pnpm dev` applies before its first child: children
// auto-apply migrations without a prompt, and dev bind/deployment overrides
// are cleared so the stand is local_trusted (design §2.1) regardless of an
// ambient profile env.
env.PAPERCLIP_MIGRATION_PROMPT ??= "never";
env.PAPERCLIP_MIGRATION_AUTO_APPLY ??= "true";
// The stand serves the BUILT ui dist (prepareWorkspace below builds it), so
// children must not each embed a vite dev middleware — with N+M processes
// that is N+M in-process vite watchers and every one of them ignores the
// dist we just produced. `pnpm dev` keeps middleware=true because it runs
// one server; the split stand optimizes for the shared static bundle.
env.PAPERCLIP_UI_DEV_MIDDLEWARE ??= "false";
delete env.PAPERCLIP_BIND;
delete env.PAPERCLIP_BIND_HOST;
delete env.PAPERCLIP_DEPLOYMENT_MODE;
delete env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
delete env.PAPERCLIP_AUTH_BASE_URL_MODE;
const map = buildProcessMap(env);

console.log("[dev:procs] launch card (mode=split):");
for (const line of describeProcessMap(map)) console.log(`  ${line}`);
if (exceedsRecommendedWorkerCount(map)) {
  console.warn(
    `[dev:procs] warning: ${map.workerCount} workers exceeds the stage-1 recommendation` +
      " (1 worker, design rule 3) — accepted in dev, do not copy to prod.",
  );
}

if (dryRun) {
  console.log("[dev:procs] --dry-run: nothing spawned.");
  process.exit(0);
}

// tsx lives in the server package (that is where `pnpm dev` gets it from);
// the script itself sits in the root `scripts/` dir, so resolve it by file
// location — the same `node_modules/tsx/dist/cli.mjs` dev-watch imports.
const tsxCliCandidates = [
  path.join(serverPackageRoot(), "node_modules/tsx/dist/cli.mjs"),
  path.join(serverPackageRoot(), "../node_modules/tsx/dist/cli.mjs"),
];
const tsxCliPath = tsxCliCandidates.find((candidate) => existsSync(candidate)) ?? null;
if (!tsxCliPath) {
  console.error("[dev:procs] tsx is not installed — run `pnpm install` first.");
  process.exit(1);
}

const bootId = randomUUID();
const plan = buildLaunchPlan(map, { watch: true, tsxCliPath, bootId });

async function runPnpmStep(argsList: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", argsList, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm ${argsList.join(" ")} failed with code ${code}`));
    });
  });
}

// Same one-time prep `pnpm dev` does before its first server child: the
// workspace links the server imports need to exist as built dists.
async function prepareWorkspace() {
  if (noBuild) {
    console.log("[dev:procs] --no-build: skipping dependency builds.");
    return;
  }
  console.log("[dev:procs] building plugin sdk...");
  await runPnpmStep(["--filter", "@paperclipai/plugin-sdk", "build"]);
  // The vite UI build peaks at ~2 GB; only pay it when the served dist is
  // missing (the stand runs with the middleware off, so it serves dist/).
  if (existsSync(path.resolve(serverPackageRoot(), "..", "ui/dist/index.html"))) {
    console.log("[dev:procs] ui dist already present — skipping build.");
    return;
  }
  console.log("[dev:procs] building ui dist...");
  await runPnpmStep(["--filter", "@paperclipai/ui", "build"]);
}

const children: { name: string; proc: ChildProcess }[] = [];
let shuttingDown = false;

function stopAll(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { proc } of children) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
  }
}

async function waitHealthy(spec: (typeof plan.specs)[number]): Promise<void> {
  const deadline = Date.now() + plan.readyTimeoutMs;
  let lastError = "no attempt";
  while (Date.now() < deadline) {
    if (shuttingDown) return;
    try {
      const res = await fetch(spec.healthUrl, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    // The child dying during probe surfaces via its exit handler below.
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `${spec.name} not healthy at ${spec.healthUrl} after ${plan.readyTimeoutMs}ms (last: ${lastError})`,
  );
}

function startChild(spec: (typeof plan.specs)[number]) {
  const proc = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `[${spec.name}]`;
  const pipe = (stream: NodeJS.ReadableStream, sink: NodeJS.WritableStream) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        sink.write(`${prefix} ${buffer.slice(0, idx)}\n`);
        buffer = buffer.slice(idx + 1);
      }
    });
  };
  pipe(proc.stdout!, process.stdout);
  pipe(proc.stderr!, process.stderr);
  proc.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[dev:procs] ${spec.name} exited (code=${code} signal=${signal}) — stopping the stand.` +
        " No restart: dev stands die loudly (PROCS-1.2 owns restart policy).",
    );
    stopAll("SIGTERM");
    process.exitCode = code ?? 1;
  });
  children.push({ name: spec.name, proc });
}

process.on("SIGINT", () => {
  stopAll("SIGTERM");
  setTimeout(() => stopAll("SIGKILL"), 5000).unref();
});
process.on("SIGTERM", () => stopAll("SIGTERM"));

try {
  await prepareWorkspace();
  console.log(`[dev:procs] boot id ${bootId}`);
  for (const spec of plan.specs) {
    startChild(spec);
    await waitHealthy(spec);
    console.log(`[dev:procs] ${spec.name} healthy (${spec.healthUrl})`);
  }
  console.log(
    `[dev:procs] split stand up: ${map.apiCount} api (clients on :${map.apiPort})` +
      ` + ${map.workerCount} worker. Ctrl-C stops all.`,
  );
} catch (err) {
  console.error(`[dev:procs] ${err instanceof Error ? err.message : String(err)}`);
  stopAll("SIGTERM");
  process.exit(1);
}

// Keep the runner alive until the last child exits.
await new Promise<void>((resolve) => {
  const check = setInterval(() => {
    if (shuttingDown || children.every(({ proc }) => proc.exitCode !== null || proc.signalCode !== null)) {
      clearInterval(check);
      resolve();
    }
  }, 300);
});
