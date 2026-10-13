#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";

export function failedTestNames(output) {
  const names = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:FAIL\s+|[×✗]\s+|failed:\s*)(.+?)\s*$/i);
    if (match) names.add(match[1]);
  }
  return [...names];
}

export function runWithOneRetry(command, args, { spawn = spawnSync, env = process.env, onOutput = () => {} } = {}) {
  const first = spawn(command, args, { encoding: "utf8", env });
  const initialOutput = `${first.stdout ?? ""}${first.stderr ?? ""}`;
  onOutput(initialOutput);
  if (first.error) return { status: 1, output: initialOutput, quarantined: [first.error.message] };
  if (first.status === 0) return { status: 0, output: initialOutput, quarantined: [] };
  const names = failedTestNames(initialOutput);
  if (first.status === null) return { status: 1, output: initialOutput, quarantined: ["test process terminated without an exit status"] };
  const second = spawn(command, args, { encoding: "utf8", env });
  const retryOutput = `${second.stdout ?? ""}${second.stderr ?? ""}`;
  onOutput(retryOutput);
  if (second.status === 0) return { status: 0, output: `${initialOutput}${retryOutput}`, quarantined: [] };
  if (second.status === null) return {
    status: 1,
    output: `${initialOutput}${retryOutput}`,
    quarantined: names.length ? names : ["test process terminated without an exit status"],
  };
  return {
    status: second.status ?? 1,
    output: `${initialOutput}${retryOutput}`,
    quarantined: names.length ? names : ["test process failed before naming a test"],
  };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const [logPath, command, ...args] = process.argv.slice(2);
  if (!logPath || !command) throw new Error("usage: shard-retry.mjs <attempt-1-log> <command> [args...]");
  const result = runWithOneRetry(command, args);
  fs.writeFileSync(logPath, result.output);
  for (const name of result.quarantined) console.log(`flaky-quarantine: ${name}`);
  process.exitCode = result.status;
}