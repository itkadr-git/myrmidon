#!/usr/bin/env node
// VERIFY-ON-PROD: release-stage proof for the exact deployed version and its
// board release tasks. This is the machine-readable contract consumed by the
// final Latest promotion; a health-only check is not sufficient.
import fs from "node:fs";

class UsageError extends Error {}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

export function releaseTaskResults(issues) {
  return (Array.isArray(issues) ? issues : []).map((issue) => ({
    identifier: issue.identifier ?? issue.id ?? "unknown",
    title: issue.title ?? "untitled",
    status: issue.status ?? "unknown",
    verified: issue.status === "done",
  }));
}

export function buildReport({ version, label, health, tasks, generatedAt = new Date().toISOString() }) {
  const taskResults = releaseTaskResults(tasks);
  const checks = [
    { name: "production-version", verified: health?.status === "ok" && health?.version === version, details: { expected: version, actual: health?.version ?? null, status: health?.status ?? null } },
    { name: "release-tasks", verified: taskResults.length > 0 && taskResults.every((task) => task.verified), details: { label, count: taskResults.length } },
  ];
  return { version, label, generatedAt, verified: checks.every((check) => check.verified), checks, tasks: taskResults };
}

async function request(api, path, init = {}) {
  const response = await fetch(`${api.url.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(api.key ? { Authorization: `Bearer ${api.key}` } : {}), Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

export async function verifyOnProduction({ version, label, healthUrl, apiUrl, apiKey, companyId, token }) {
  const healthHeaders = token ? { Authorization: `Bearer ${token}` } : {};
  const healthResponse = await fetch(healthUrl, { headers: healthHeaders });
  if (!healthResponse.ok) throw new Error(`health: HTTP ${healthResponse.status}`);
  const health = await healthResponse.json();
  const labels = await request({ url: apiUrl, key: apiKey }, `/api/companies/${encodeURIComponent(companyId)}/labels`);
  const releaseLabel = labels.find((item) => item.name === label || item.name === `release:${label}`);
  if (!releaseLabel) throw new Error(`release label "${label}" not found`);
  const tasks = await request({ url: apiUrl, key: apiKey }, `/api/companies/${encodeURIComponent(companyId)}/issues?labelId=${encodeURIComponent(releaseLabel.id)}&limit=100&view=compact`);
  return buildReport({ version, label, health, tasks });
}

export function formatReport(report) {
  const lines = [
    `# VERIFY-ON-PROD ${report.version}`,
    "",
    `- Result: ${report.verified ? "PASS" : "FAIL"}`,
    `- Release label: ${report.label}`,
    `- Checked at: ${report.generatedAt}`,
    "",
    "## Checks",
    ...report.checks.map((check) => `- ${check.verified ? "PASS" : "FAIL"} ${check.name}: ${JSON.stringify(check.details)}`),
    "",
    "## Release tasks",
  ];
  for (const task of report.tasks) {
    lines.push(`- ${task.verified ? "PASS" : "FAIL"} ${task.identifier} — ${task.title} [${task.status}]`);
  }
  return `${lines.join("\n")}\n`;
}

function usage() {
  console.error(`usage:
  node scripts/myrmidon/release/verify-on-prod.mjs --version X.Y.Z --health-url <url>
    --api-url <board-api-url> --company-id <uuid>
    [--label <release-label>] [--api-key <key>] [--api-key-env]
    [--health-token-file <file>] [--report <out.json>]

Exit codes: 0 = verified (board runs X.Y.Z, every release task done),
1 = verification failed (report still printed/written), 2 = usage error.`);
}

export async function main(argv) {
  const args = parseArgs(argv);
  const required = ["version", "health-url", "api-url", "company-id"];
  const missing = required.filter((name) => !args[name] || args[name] === true);
  if (missing.length > 0) {
    usage();
    throw new Error(`missing argument(s): ${missing.map((name) => `--${name}`).join(", ")}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(args.version)) {
    throw new UsageError(`--version must look like X.Y.Z (got: ${args.version})`);
  }
  const token = args["health-token-file"] ? fs.readFileSync(args["health-token-file"], "utf8").trim() : null;
  const apiKey = args["api-key"] === true || args["api-key"] === undefined
    ? process.env.PAPERCLIP_API_KEY
    : args["api-key"];
  const report = await verifyOnProduction({
    version: args.version,
    label: args.label || args.version.split(".").slice(0, 2).join("."),
    healthUrl: args["health-url"],
    apiUrl: args["api-url"],
    apiKey,
    companyId: args["company-id"],
    token,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const output = args.report ? json : formatReport(report);
  process.stdout.write(output);
  if (args.report) fs.writeFileSync(args.report, json);
  return report.verified ? EXIT_OK : EXIT_FAILED;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      if (!(error instanceof UsageError)) console.error(`VERIFY-ON-PROD FAILED: ${error.message}`);
      process.exit(EXIT_USAGE);
    });
}
