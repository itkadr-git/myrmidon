#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = value => typeof value === "string" && value.trim().length > 0 && value !== "unknown";

function inspect(report, side) {
  const errors = [];
  const fail = message => errors.push(`${side}: ${message}`);
  if (!isObject(report) || !nonempty(report.version) || !nonempty(report.label) ||
      !nonempty(report.generatedAt) || typeof report.verified !== "boolean" ||
      !Array.isArray(report.checks) || !Array.isArray(report.tasks)) {
    fail("incompatible report schema");
    return { errors };
  }
  const checks = new Map();
  for (const check of report.checks) {
    if (!isObject(check) || !nonempty(check.name) || typeof check.verified !== "boolean" || !isObject(check.details)) {
      fail("invalid check"); continue;
    }
    if (checks.has(check.name)) fail(`duplicate check: ${check.name}`);
    checks.set(check.name, check);
  }
  if (checks.size !== 2 || !checks.has("production-version") || !checks.has("release-tasks")) fail("incompatible checks");
  const tasks = new Map();
  for (const task of report.tasks) {
    if (!isObject(task) || !nonempty(task.identifier) || !nonempty(task.title) ||
        !nonempty(task.status) || typeof task.verified !== "boolean") {
      fail("invalid task"); continue;
    }
    if (tasks.has(task.identifier)) fail(`duplicate task identifier: ${task.identifier}`);
    tasks.set(task.identifier, task.status === "done" && task.verified);
  }
  const release = checks.get("release-tasks");
  if (release && (!Number.isSafeInteger(release.details.count) || release.details.count !== report.tasks.length)) fail("task count mismatch");
  if (release && release.details.label !== report.label) fail("release label mismatch");
  const production = checks.get("production-version");
  if (production && (!Object.hasOwn(production.details, "actual") || !Object.hasOwn(production.details, "status") || production.details.expected !== report.version ||
      !(production.details.actual === null || typeof production.details.actual === "string") ||
      !(production.details.status === null || typeof production.details.status === "string"))) fail("invalid production-version details");
  const productionPass = production && production.verified && production.details.status === "ok" && production.details.actual === report.version;
  const tasksPass = release && release.verified && report.tasks.length > 0 && [...tasks.values()].every(Boolean);
  return { errors, tasks, verified: Boolean(productionPass && tasksPass) };
}

export function diffReports(before, after) {
  const previous = inspect(before, "previous");
  const current = inspect(after, "current");
  const errors = [...previous.errors, ...current.errors];
  if (errors.length) return { status: "invalid", errors };
  const added = [...current.tasks.keys()].filter(id => !previous.tasks.has(id)).sort();
  const removed = [...previous.tasks.keys()].filter(id => !current.tasks.has(id)).sort();
  const regressions = [...previous.tasks.keys()].filter(id => previous.tasks.get(id) && current.tasks.has(id) && !current.tasks.get(id)).sort();
  const version = { before: before.version, after: after.version };
  const changed = added.length || removed.length || regressions.length || before.version !== after.version ||
    previous.verified !== current.verified || JSON.stringify(before) !== JSON.stringify(after);
  return { status: changed ? "changed" : "identical", version, added, removed, regressions,
    previous: { verified: previous.verified }, current: { verified: current.verified } };
}

export function main(argv) {
  let result;
  try {
    if (argv.length !== 2) throw new Error("usage: diff.mjs <previous.json> <current.json>");
    result = diffReports(JSON.parse(fs.readFileSync(argv[0], "utf8")), JSON.parse(fs.readFileSync(argv[1], "utf8")));
  } catch (error) {
    result = { status: "invalid", errors: [error.message] };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === "invalid" ? 2 : result.status === "changed" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
