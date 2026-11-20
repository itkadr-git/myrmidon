import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReport } from "./verify-on-prod.mjs";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function assertReport(report, expected) {
  const before = structuredClone(report);
  deepFreeze(report);
  assert.equal(formatReport(report), expected);
  assert.deepEqual(report, before);
}

test("PASS report preserves the full ordered Markdown and frozen input", () => {
  assertReport({
    version: "1.7.3", label: "release:1.7", generatedAt: "2026-11-16T12:34:56.000Z", verified: true,
    checks: [
      { name: "production-version", verified: true, details: { expected: "1.7.3", actual: "1.7.3", endpoint: "https://example.invalid/health" } },
      { name: "release-tasks", verified: true, details: { label: "release:1.7", count: 1 } },
    ],
    tasks: [{ identifier: "FAKE-1", title: "Ship release", status: "done", verified: true }],
  }, `# VERIFY-ON-PROD 1.7.3

- Result: PASS
- Release label: release:1.7
- Checked at: 2026-11-16T12:34:56.000Z

## Checks
- PASS production-version: {"expected":"1.7.3","actual":"1.7.3","endpoint":"https://example.invalid/health"}
- PASS release-tasks: {"label":"release:1.7","count":1}

## Release tasks
- PASS FAKE-1 — Ship release [done]
`);
});

test("mixed report preserves supplied flags, order, JSON details and every Unicode task", () => {
  assertReport({
    version: "1.7.3", label: "release:1.7", generatedAt: "2026-11-16T12:34:56.000Z", verified: true,
    checks: [
      { name: "release-tasks", verified: false, details: { count: 3, nested: { reason: "blocked", key: "fictional-key" } } },
      { name: "production-version", verified: true, details: { expected: "1.7.3", actual: null, status: "bad" } },
    ],
    tasks: [
      { identifier: "FAKE-3", title: "Готово 🚀", status: "done", verified: false },
      { identifier: "FAKE-2", title: "Заблокировано", status: "blocked", verified: true },
      { identifier: "FAKE-1", title: "未知 task", status: "unknown", verified: false },
    ],
  }, `# VERIFY-ON-PROD 1.7.3

- Result: PASS
- Release label: release:1.7
- Checked at: 2026-11-16T12:34:56.000Z

## Checks
- FAIL release-tasks: {"count":3,"nested":{"reason":"blocked","key":"fictional-key"}}
- PASS production-version: {"expected":"1.7.3","actual":null,"status":"bad"}

## Release tasks
- FAIL FAKE-3 — Готово 🚀 [done]
- PASS FAKE-2 — Заблокировано [blocked]
- FAIL FAKE-1 — 未知 task [unknown]
`);
});

test("FAIL report with empty tasks keeps the header and one trailing LF", () => {
  assertReport({
    version: "1.7.3", label: "release:1.7", generatedAt: "2026-11-16T12:34:56.000Z", verified: false,
    checks: [{ name: "release-tasks", verified: true, details: { label: "release:1.7", count: 0 } }],
    tasks: [],
  }, `# VERIFY-ON-PROD 1.7.3

- Result: FAIL
- Release label: release:1.7
- Checked at: 2026-11-16T12:34:56.000Z

## Checks
- PASS release-tasks: {"label":"release:1.7","count":0}

## Release tasks
`);
});
