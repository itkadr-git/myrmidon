import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport } from "../verify-on-prod.mjs";
import { diffReports } from "./diff.mjs";

const VERSION = "1.7.0";
const LABEL = "1.7";

function report(tasks) {
  return buildReport({
    version: VERSION,
    label: LABEL,
    generatedAt: "2026-01-01",
    health: { status: "ok", version: VERSION },
    tasks,
  });
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function task(identifier, status) {
  return { identifier, title: identifier, status };
}

const failedStatuses = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "cancelled",
];

test("classifies every successful-task transition as a regression only when it becomes FAIL", () => {
  const transitions = [
    ["done to forged FAIL", { identifier: "OPE-1", status: "done", verified: false }, true],
    ...failedStatuses.map(status => [
      `done to ${status}`,
      task("OPE-1", status),
      true,
    ]),
    ["done to done", task("OPE-1", "done"), false],
  ];

  for (const [name, currentTask, expectedRegression] of transitions) {
    const previous = report([task("OPE-1", "done")]);
    const current = report([currentTask]);
    if (currentTask.verified === false) {
      current.tasks[0].verified = false;
      current.checks.find(check => check.name === "release-tasks").verified = true;
    }
    const result = diffReports(freeze(previous), freeze(current));
    assert.deepEqual(result.regressions, expectedRegression ? ["OPE-1"] : [], name);
    assert.equal(result.previous.verified, true, name);
    assert.equal(result.current.verified, !expectedRegression, name);
  }
});

test("reverse transitions never create regressions", () => {
  for (const status of ["done", ...failedStatuses]) {
    const previous = report([task("OPE-1", status)]);
    const current = report([task("OPE-1", "done")]);
    if (status === "done") previous.tasks[0].verified = false;
    const result = diffReports(freeze(previous), freeze(current));
    assert.deepEqual(result.regressions, [], `reverse ${status} to done`);
  }
});

test("separates removed successes, added failures, and persistent failures", () => {
  const previous = report([
    task("OPE-9", "done"),
    task("OPE-5", "blocked"),
    task("OPE-2", "done"),
  ]);
  const current = report([
    task("OPE-8", "blocked"),
    task("OPE-5", "in_review"),
    task("OPE-2", "todo"),
  ]);

  const result = diffReports(previous, current);
  assert.deepEqual(result.added, ["OPE-8"]);
  assert.deepEqual(result.removed, ["OPE-9"]);
  assert.deepEqual(result.regressions, ["OPE-2"]);
});

test("sorts independent diff arrays and is invariant to task permutations", () => {
  const beforeTasks = [
    task("OPE-30", "blocked"),
    task("OPE-10", "done"),
    task("OPE-20", "done"),
    task("OPE-40", "in_review"),
    task("OPE-90", "done"),
    task("OPE-70", "done"),
  ];
  const afterTasks = [
    task("OPE-80", "todo"),
    task("OPE-50", "todo"),
    task("OPE-30", "done"),
    task("OPE-20", "blocked"),
    task("OPE-40", "in_progress"),
    task("OPE-70", "cancelled"),
  ];
  const expected = {
    added: ["OPE-50", "OPE-80"],
    removed: ["OPE-10", "OPE-90"],
    regressions: ["OPE-20", "OPE-70"],
    previous: { verified: false },
    current: { verified: false },
  };

  const first = diffReports(report(beforeTasks), report(afterTasks));
  const second = diffReports(
    report([beforeTasks[1], beforeTasks[5], beforeTasks[3], beforeTasks[0], beforeTasks[4], beforeTasks[2]]),
    report([afterTasks[2], afterTasks[5], afterTasks[0], afterTasks[4], afterTasks[3], afterTasks[1]]),
  );
  assert.deepEqual(
    {
      added: first.added,
      removed: first.removed,
      regressions: first.regressions,
      previous: first.previous,
      current: first.current,
    },
    expected,
  );
  assert.deepEqual(second.added, expected.added);
  assert.deepEqual(second.removed, expected.removed);
  assert.deepEqual(second.regressions, expected.regressions);
  assert.deepEqual(second.previous, expected.previous);
  assert.deepEqual(second.current, expected.current);
});

test("does not mutate deeply frozen report inputs", () => {
  const previous = freeze(report([task("OPE-2", "done"), task("OPE-1", "blocked")]));
  const current = freeze(report([task("OPE-3", "todo"), task("OPE-2", "blocked")]));
  const previousSnapshot = structuredClone(previous);
  const currentSnapshot = structuredClone(current);

  const result = diffReports(previous, current);

  assert.deepEqual(result.added, ["OPE-3"]);
  assert.deepEqual(result.removed, ["OPE-1"]);
  assert.deepEqual(result.regressions, ["OPE-2"]);
  assert.deepEqual(previous, previousSnapshot);
  assert.deepEqual(current, currentSnapshot);
});
