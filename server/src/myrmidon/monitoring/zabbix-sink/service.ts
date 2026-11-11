// server/src/myrmidon/monitoring/zabbix-sink/service.ts
// myrmidon(1.7-ZABBIX-SINK): orchestration of one Zabbix alarm — the dedup
// decision by eventid and the draft task creation. A draft is an issue in
// status `todo` without an assignee: it exists, it is visible, and a role
// claims it on the board. A repeated eventid returns the existing draft.

import { sinkBody, sinkTitle, type ZabbixSinkEvent } from "./domain.js";
import type { ZabbixSinkDedupStore, SinkDedupEntry } from "./store.js";

/** The vendor issue surface this feature needs; issueService(db) satisfies it. */
export interface SinkIssuePorts {
  createIssue(
    companyId: string,
    input: {
      title: string;
      description: string;
      priority: string;
      assigneeAgentId: string | null;
    },
  ): Promise<{ id: string; identifier: string | null; status: string }>;
}

export interface SinkOutcome {
  eventId: string;
  action: "create" | "dedup";
  issueId: string | null;
  issueIdentifier: string | null;
}

export interface ZabbixSinkServiceDeps {
  store: ZabbixSinkDedupStore;
  issues: SinkIssuePorts;
}

export function createZabbixSinkService(deps: ZabbixSinkServiceDeps) {
  // The registry read and the draft creation must be one turn: two deliveries
  // of the same eventid must not both observe "no entry" and create two drafts.
  let sinkQueue: Promise<void> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = sinkQueue.then(task, task);
    sinkQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    async handleEvent(companyId: string, event: ZabbixSinkEvent): Promise<SinkOutcome> {
      return enqueue(async () => {
        const existing: SinkDedupEntry | null = await deps.store.get(companyId, event.eventId);
        if (existing) {
          return {
            eventId: event.eventId,
            action: "dedup",
            issueId: existing.issueId,
            issueIdentifier: existing.issueIdentifier,
          };
        }
        const issue = await deps.issues.createIssue(companyId, {
          title: sinkTitle(event),
          description: sinkBody(event),
          priority: event.priority,
          assigneeAgentId: null,
        });
        await deps.store.upsert(companyId, event.eventId, {
          issueId: issue.id,
          issueIdentifier: issue.identifier,
        });
        return {
          eventId: event.eventId,
          action: "create",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
        };
      });
    },
  };
}
