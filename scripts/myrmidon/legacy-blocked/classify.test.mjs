import assert from "node:assert/strict";
import test from "node:test";
import { classifyLegacyBlocked } from "./classify.ts";

const cases = [
  {
    name: "open issue explicitly blocks this work",
    facts: { links: [{ type: "issue", relation: "blocks", status: "in_progress", label: "OPE-10" }] },
    expected: "dependency",
  },
  {
    name: "linked issue explicitly owns recovery work",
    facts: { links: [{ type: "issue", relation: "recovery", status: "todo", label: "OPE-11" }] },
    expected: "recovery",
  },
  {
    name: "pending interaction requires a human decision",
    facts: { links: [{ type: "interaction", status: "pending", label: "owner decision" }] },
    expected: "human_decision",
  },
  {
    name: "pending external reference is waiting",
    facts: { links: [{ type: "external", status: "pending", label: "vendor response" }] },
    expected: "external_wait",
  },
  {
    name: "explicit resource link identifies a resource blocker",
    facts: { links: [{ type: "resource", status: "unavailable", label: "GitHub access" }] },
    expected: "resource",
  },
  {
    name: "explicitly cancelled task is terminal",
    facts: { taskStatus: "cancelled" },
    expected: "terminal",
  },
  {
    name: "open PR with pending checks is external wait",
    facts: { pullRequests: [{ state: "open", checksState: "pending", reviewState: "unknown" }] },
    expected: "external_wait",
  },
  {
    name: "open PR awaiting review is external wait",
    facts: { pullRequests: [{ state: "open", checksState: "passed", reviewState: "pending" }] },
    expected: "external_wait",
  },
  {
    name: "comment explicitly says blocked by an issue",
    facts: { latestComments: ["Progress is blocked by OPE-12 until its change lands."] },
    expected: "dependency",
  },
  {
    name: "comment explicitly requests owner decision",
    facts: { latestComments: ["Awaiting owner decision before proceeding."] },
    expected: "human_decision",
  },
  {
    name: "comment explicitly records missing permission",
    facts: { latestComments: ["Unable to proceed: permission denied for the required repository."] },
    expected: "resource",
  },
  {
    name: "comment explicitly records a duplicate outcome",
    facts: { latestComments: ["This request is a duplicate; no further work is needed."] },
    expected: "terminal",
  },
  {
    name: "no relevant facts remains unknown",
    facts: {},
    expected: "unknown",
  },
  {
    name: "resolved blocker alone does not establish a current class",
    facts: { links: [{ type: "issue", relation: "blocks", status: "done", label: "OPE-13" }] },
    expected: "unknown",
  },
  {
    name: "conflicting explicit facts remain unknown",
    facts: {
      links: [
        { type: "issue", relation: "blocks", status: "in_progress", label: "OPE-14" },
        { type: "interaction", status: "pending", label: "decision" },
      ],
    },
    expected: "unknown",
  },
  {
    name: "closed PR without merge does not imply terminal",
    facts: { pullRequests: [{ state: "closed", checksState: "unknown", reviewState: "unknown" }] },
    expected: "unknown",
  },
  {
    name: "comment mentioning resolved dependency is not current evidence",
    facts: { latestComments: ["The dependency is resolved; we are not waiting for CI or a human decision."] },
    expected: "unknown",
  },
  {
    name: "comment containing conflicting present-tense blockers is unknown",
    facts: { latestComments: ["Waiting for owner decision and blocked by OPE-15."] },
    expected: "unknown",
  },
  { name: "Russian blocked issue is a dependency", facts: { latestComments: ["Заблокировано OPE-21"] }, expected: "dependency" },
  { name: "Russian waiting issue is a dependency with ё normalization", facts: { latestComments: ["Ждёт OPE-22"] }, expected: "dependency" },
  { name: "Russian dependency wording is recognized", facts: { latestComments: ["Зависит от OPE-23"] }, expected: "dependency" },
  { name: "Russian owner decision is recognized", facts: { latestComments: ["Ждём решения владельца"] }, expected: "human_decision" },
  { name: "Russian approval is recognized", facts: { latestComments: ["Нужно согласование"] }, expected: "human_decision" },
  { name: "Russian missing access is recognized", facts: { latestComments: ["Нет доступа к репозиторию"] }, expected: "resource" },
  { name: "Russian denied access is recognized", facts: { latestComments: ["Отказано в доступе"] }, expected: "resource" },
  { name: "Russian missing rights is recognized", facts: { latestComments: ["Нет прав"] }, expected: "resource" },
  { name: "Russian vendor response is recognized", facts: { latestComments: ["Ждём ответа поставщика"] }, expected: "external_wait" },
  { name: "Russian provider response is recognized", facts: { latestComments: ["Ожидаем ответа провайдера"] }, expected: "external_wait" },
  { name: "Russian external service response is recognized", facts: { latestComments: ["Ждём ответа внешнего сервиса"] }, expected: "external_wait" },
  { name: "Russian duplicate outcome is terminal", facts: { latestComments: ["Дубликат"] }, expected: "terminal" },
  { name: "Russian cancellation outcome is terminal", facts: { latestComments: ["Отменено"] }, expected: "terminal" },
  { name: "Russian unnecessary work outcome is terminal", facts: { latestComments: ["Это не нужно"] }, expected: "terminal" },
  { name: "Russian recovery task is recognized", facts: { latestComments: ["Нужна задача восстановления"] }, expected: "recovery" },
  { name: "Russian operator action is recognized", facts: { latestComments: ["Требуется действие оператора"] }, expected: "recovery" },
  { name: "Russian negated wait is not current evidence", facts: { latestComments: ["Уже не ждём ответа поставщика"] }, expected: "unknown" },
  { name: "Russian unblocked state is not current evidence", facts: { latestComments: ["Разблокировано"] }, expected: "unknown" },
  { name: "Russian resolved state is not current evidence", facts: { latestComments: ["Решено"] }, expected: "unknown" },
  { name: "Russian cleared state is not current evidence", facts: { latestComments: ["Снято"] }, expected: "unknown" },
  { name: "Russian mixed blocker classes remain unknown", facts: { latestComments: ["Нет доступа и ждём ответа провайдера"] }, expected: "unknown" },
];

test("classifyLegacyBlocked has conservative table-driven coverage", async (t) => {
  for (const { name, facts, expected } of cases) {
    await t.test(name, () => {
      const result = classifyLegacyBlocked(facts);
      assert.equal(result.class, expected);
      assert.ok(Array.isArray(result.evidence));
      if (result.class !== "unknown") {
        assert.ok(result.evidence.some((item) => item.trim().length > 0));
      }
    });
  }
});
