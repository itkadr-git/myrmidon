// myrmidon(1.6.6 MONITORING D): the whole lifecycle of an alert task.
//
// Alarm → task of the owner role with the runbook steps → the alert resolves →
// the task closes by itself once the alarm has stayed resolved for the hold →
// a repeat inside the window comes back into the same task, not a new one.
//
// The store and the issue service are fakes on purpose: what is pinned here is
// the decision the service makes on every event and every sweep pass, not the
// drizzle wiring (that is the job of the wiring test in this folder).

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  alertRecoveryIdentity,
  resolveAlertRecoverySettings,
  type AlertRecoveryRecord,
  type AlertRecoverySettings,
} from "@paperclipai/shared";
import { createAlertRecoveryService, type AlertRecoveryAlert, type AlertRecoveryIssuePort } from "./index.js";
import { alertRecoveryRunbooks } from "./runbook.js";
import type { AlertRecoveryStore } from "./store.js";

const COMPANY_ID = "11111111-2222-4333-8444-555555555555";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

/** The alert under test: a disk alert on one host, the runbook of the registry. */
function firing(overrides: Partial<AlertRecoveryAlert> = {}): AlertRecoveryAlert {
  return {
    companyId: COMPANY_ID,
    source: "zabbix",
    trigger: "Disk space is low on /data",
    status: "firing",
    severity: "high",
    summary: "used 96% of /data",
    hosts: ["vm-exec"],
    happenedAt: "2026-10-07T04:00:00.000Z",
    url: "https://zabbix.example/tr_events.php?triggerid=42",
    ...overrides,
  };
}

interface FakeTask {
  id: string;
  identifier: string;
  title: string;
  body: string;
  status: string;
  priority: string;
  comments: string[];
}

function createFakeIssues() {
  const tasks = new Map<string, FakeTask>();
  let sequence = 0;
  const port: AlertRecoveryIssuePort = {
    async createIssue(input) {
      sequence += 1;
      const id = `issue-${sequence}`;
      const identifier = `OPE-9${sequence}`;
      tasks.set(id, {
        id,
        identifier,
        title: input.title,
        body: input.body,
        status: "todo",
        priority: input.priority,
        comments: [],
      });
      return { id, identifier };
    },
    async addComment(issueId, body) {
      const task = tasks.get(issueId);
      if (!task) return false;
      task.comments.push(body);
      return true;
    },
    async closeIssue({ issueId, body }) {
      const task = tasks.get(issueId);
      if (!task) return "refused";
      if (task.status === "done") return "already";
      task.status = "done";
      task.comments.push(body);
      return "applied";
    },
    async reopenIssue({ issueId, body }) {
      const task = tasks.get(issueId);
      if (!task) return "refused";
      if (task.status !== "done" && task.status !== "cancelled") return "already";
      task.status = "todo";
      task.comments.push(body);
      return "applied";
    },
  };
  return { tasks, port, created: () => [...tasks.values()] };
}

function createMemoryStore(initial?: Partial<AlertRecoverySettings>) {
  // The raw settings row, not the resolved values: what a store hands back is
  // what an operator saved (nothing, at first), and the sources must say so.
  let stored: unknown = initial ?? {};
  let records: AlertRecoveryRecord[] = [];
  const store: AlertRecoveryStore = {
    readResolved: async () => resolveAlertRecoverySettings({ stored }),
    writeSettings: async (next) => {
      stored = next;
    },
    readRecords: async (companyId) =>
      companyId ? records.filter((record) => record.companyId === companyId) : records.slice(),
    writeRecords: async (companyId, next) => {
      records = [...records.filter((record) => record.companyId !== companyId), ...next];
    },
  };
  return {
    store,
    records: () => records.slice(),
    /** What an operator saved, exactly as the settings row would hold it. */
    storedRow: () => stored,
  };
}

function harness(initial?: Partial<AlertRecoverySettings>) {
  let clock = new Date("2026-10-07T04:00:00.000Z");
  const issues = createFakeIssues();
  const memory = createMemoryStore(initial);
  const service = createAlertRecoveryService({
    store: memory.store,
    issues: issues.port,
    now: () => clock,
  });
  return {
    service,
    issues,
    memory,
    at: (iso: string) => {
      clock = new Date(iso);
    },
  };
}

describe("alert recovery lifecycle", () => {
  it("turns an alarm into one task of the owner role with the runbook steps", async () => {
    const { service, issues, memory } = harness();

    const result = await service.ingest(firing());

    expect(result.kind).toBe("create");
    expect(result.ownerRole).toBe("devops");
    expect(result.runbookKey).toBe("disk-space-low");

    const [task] = issues.created();
    expect(issues.created()).toHaveLength(1);
    expect(task.title).toContain("Disk space is low on /data");
    expect(task.priority).toBe("high");
    // The steps of the runbook of this trigger, and the document behind the key.
    expect(task.body).toContain("Шаги восстановления");
    expect(task.body).toContain("docs/myrmidon/runbooks/disk-space-low.md");
    expect(task.body).toContain("df -h /data");
    expect(task.body).toContain("продержится снятой 10 мин");
    expect(task.body).toContain("## Автозакрытие");

    const [record] = memory.records();
    expect(record.identity).toBe(alertRecoveryIdentity(firing()));
    expect(record.state).toBe("open");
    expect(record.firedCount).toBe(1);
    expect(record.issueId).toBe(task.id);
  });

  it("keeps a repeat alarm in the same task instead of opening a new one", async () => {
    const { service, issues, memory, at } = harness();
    await service.ingest(firing());

    at("2026-10-07T04:05:00.000Z");
    const second = await service.ingest(firing({ happenedAt: "2026-10-07T04:05:00.000Z", severity: "disaster" }));

    expect(second.kind).toBe("join");
    expect(issues.created()).toHaveLength(1);
    const [task] = issues.created();
    expect(task.comments).toHaveLength(1);
    expect(task.comments[0]).toContain("срабатывание №2");
    expect(task.comments[0]).toContain("Автозакрытие не сработает, пока тревога горит");
    const [record] = memory.records();
    expect(record.firedCount).toBe(2);
    expect(record.state).toBe("open");
  });

  it("closes the task by itself once the alarm has stayed resolved for the hold", async () => {
    const { service, issues, memory, at } = harness();
    await service.ingest(firing());

    at("2026-10-07T04:08:00.000Z");
    const resolved = await service.ingest(firing({ status: "resolved", happenedAt: "2026-10-07T04:08:00.000Z" }));
    expect(resolved.kind).toBe("await-close");
    expect(memory.records()[0].state).toBe("awaiting-close");

    // Before the hold is up nothing closes.
    at("2026-10-07T04:15:00.000Z");
    const early = await service.sweep();
    expect(early.closed).toHaveLength(0);
    expect(issues.created()[0].status).toBe("todo");

    // The hold is ten minutes: 04:18 is the earliest close.
    at("2026-10-07T04:18:01.000Z");
    const late = await service.sweep();
    expect(late.closed).toHaveLength(1);

    const [task] = issues.created();
    expect(task.status).toBe("done");
    expect(task.comments.at(-1)).toContain("автоматически");
    const [record] = memory.records();
    expect(record.state).toBe("closed");
    expect(record.closedAt).toBe("2026-10-07T04:18:01.000Z");
  });

  it("takes the task back into work when the alarm fires again inside the window", async () => {
    const { service, issues, memory, at } = harness();
    await service.ingest(firing());
    at("2026-10-07T04:08:00.000Z");
    await service.ingest(firing({ status: "resolved", happenedAt: "2026-10-07T04:08:00.000Z" }));
    at("2026-10-07T04:18:01.000Z");
    await service.sweep();
    expect(issues.created()[0].status).toBe("done");

    // A repeat half an hour later, inside the recurrence window.
    at("2026-10-07T04:26:00.000Z");
    const again = await service.ingest(firing({ happenedAt: "2026-10-07T04:26:00.000Z" }));

    expect(again.kind).toBe("reopen");
    expect(issues.created()).toHaveLength(1);
    const [task] = issues.created();
    expect(task.status).toBe("todo");
    expect(task.comments.at(-1)).toContain("это та же задача, новая не открывается");
    expect(memory.records()[0].state).toBe("open");
    expect(memory.records()[0].resolvedAt).toBeNull();
  });

  it("opens a new task when the alarm comes back after the window", async () => {
    const { service, issues, at } = harness();
    await service.ingest(firing());
    at("2026-10-07T04:08:00.000Z");
    await service.ingest(firing({ status: "resolved", happenedAt: "2026-10-07T04:08:00.000Z" }));
    at("2026-10-07T04:18:01.000Z");
    await service.sweep();

    // Well past the thirty minute window: the closed record is pruned and the
    // alarm opens a task of its own.
    at("2026-10-07T05:20:00.000Z");
    const fresh = await service.ingest(firing({ happenedAt: "2026-10-07T05:20:00.000Z" }));

    expect(fresh.kind).toBe("create");
    expect(issues.created()).toHaveLength(2);
  });

  it("cancels the automatic close when the alarm comes back before the hold is up", async () => {
    const { service, issues, memory, at } = harness();
    await service.ingest(firing());
    at("2026-10-07T04:08:00.000Z");
    await service.ingest(firing({ status: "resolved", happenedAt: "2026-10-07T04:08:00.000Z" }));

    at("2026-10-07T04:12:00.000Z");
    const back = await service.ingest(firing({ happenedAt: "2026-10-07T04:12:00.000Z" }));
    expect(back.kind).toBe("cancel-close");
    expect(issues.created()).toHaveLength(1);
    expect(issues.created()[0].comments.at(-1)).toContain("автозакрытие отменено");

    // The hold restarts from the resolve that follows.
    at("2026-10-07T04:16:00.000Z");
    await service.ingest(firing({ status: "resolved", happenedAt: "2026-10-07T04:16:00.000Z" }));
    at("2026-10-07T04:20:00.000Z");
    const early = await service.sweep();
    expect(early.closed).toHaveLength(0);
    expect(memory.records()[0].state).toBe("awaiting-close");
    at("2026-10-07T04:27:00.000Z");
    const due = await service.sweep();
    expect(due.closed).toHaveLength(1);
  });

  it("a repeated resolve does not push the close away", async () => {
    const { service, memory, at } = harness();
    await service.ingest(firing());
    at("2026-10-07T04:08:00.000Z");
    await service.ingest(firing({ status: "resolved", happenedAt: "2026-10-07T04:08:00.000Z" }));

    // Something re-sends the resolved event: the hold still counts from the
    // first resolve, so the task cannot be kept open forever by a chatterer.
    at("2026-10-07T04:17:00.000Z");
    const repeat = await service.ingest(firing({ status: "resolved", happenedAt: "2026-10-07T04:17:00.000Z" }));
    expect(repeat.kind).toBe("ignore");
    expect(memory.records()[0].resolvedAt).toBe("2026-10-07T04:08:00.000Z");
    expect(memory.records()[0].state).toBe("awaiting-close");
  });

  it("honours the settings the instance was given", async () => {
    const { service, issues, at } = harness({ holdMinutes: 30, recurrenceWindowMinutes: 5 });
    await service.ingest(firing());
    at("2026-10-07T04:08:00.000Z");
    await service.ingest(firing({ status: "resolved", happenedAt: "2026-10-07T04:08:00.000Z" }));

    // The default hold would have closed it at 04:18; thirty minutes does not.
    at("2026-10-07T04:18:01.000Z");
    expect((await service.sweep()).closed).toHaveLength(0);
    at("2026-10-07T04:38:01.000Z");
    expect((await service.sweep()).closed).toHaveLength(1);
    expect(issues.created()[0].status).toBe("done");
  });

  it("reports the knobs, the runbook registry and the journal of one company", async () => {
    const { service, at } = harness();
    await service.ingest(firing());
    at("2026-10-07T04:08:00.000Z");
    await service.ingest(firing({ status: "resolved", happenedAt: "2026-10-07T04:08:00.000Z" }));

    const view = await service.view(COMPANY_ID);
    expect(view.settings.holdMinutes).toBe(10);
    expect(view.settings.sources.holdMinutes).toBe("default");
    expect(view.runbooks.map((runbook) => runbook.key)).toEqual([
      "disk-space-low",
      "host-unreachable",
      "metrics-scrape-failing",
      "generic",
    ]);
    expect(view.runbooks[0].document).toBe("docs/myrmidon/runbooks/disk-space-low.md");
    expect(view.records).toHaveLength(1);
    expect(view.records[0].closeDueAt).toBe("2026-10-07T04:18:00.000Z");
    expect(view.active).toEqual({ open: 0, awaitingClose: 1 });

    // Another company sees its own (empty) journal and its own due times.
    const other = await service.view("22222222-3333-4444-8555-666666666666");
    expect(other.records).toEqual([]);
    expect(other.active).toEqual({ open: 0, awaitingClose: 0 });
  });

  it("every runbook of the registry has its document on disk", async () => {
    for (const runbook of alertRecoveryRunbooks()) {
      const document = await readFile(resolve(REPO_ROOT, runbook.document), "utf8");
      expect(document.length).toBeGreaterThan(0);
      // The title the board shows and the document must agree on the subject.
      expect(document).toContain(runbook.title);
    }
  });
});