import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const companyId = "company-reload";
const targetId = "11111111-1111-4111-8111-111111111111";
const endpointId = "22222222-2222-4222-8222-222222222222";

function row(id: string, name: string, status: string) {
  return Object.freeze({ id, name, status, title: null, metadata: Object.freeze({}), adapterConfig: Object.freeze({}) });
}

function snapshot(status: string, name: string) {
  return Object.freeze([row(endpointId, "Endpoint Agent", "idle"), row(targetId, name, status)]);
}

type Snapshot = ReturnType<typeof snapshot>;

function fakeDb(initial: Snapshot) {
  let rows = initial;
  const reads: unknown[][] = [];
  const writes = { insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
  const chain = {
    ...writes,
    select() { return chain; },
    from() { return chain; },
    where(condition: SQL) {
      const params = new PgDialect().sqlToQuery(condition).params;
      return { orderBy() { reads.push(params); return Promise.resolve(rows); } };
    },
  };
  return { db: chain as unknown as Db, reads, writes, replace(next: Snapshot) { rows = next; } };
}

const resolved = (name: string) => ({ kind: "resolved", addressee: { agentId: targetId, displayName: name } });
const invalid = { kind: "invalid_id" };

async function runTransitions(steps: ReadonlyArray<{ rows: Snapshot; expected: object }>) {
  const first = steps[0];
  if (!first) throw new Error("Missing transition");
  const fake = fakeDb(first.rows);
  for (const [index, step] of steps.entries()) {
    fake.replace(step.rows);
    expect(await resolveBridgeAddressee(fake.db, {
      companyId, text: `agent://${targetId}`, endpointAgentId: endpointId,
    })).toEqual(step.expected);
    expect(fake.reads).toEqual(Array.from({ length: index + 1 }, () => [companyId]));
    expect(fake.writes.insert).not.toHaveBeenCalled();
    expect(fake.writes.update).not.toHaveBeenCalled();
    expect(fake.writes.delete).not.toHaveBeenCalled();
  }
}

describe("explicit agent ID reloads status on the same database handle", () => {
  it("tracks idle, paused, running, terminated and idle without endpoint fallback", async () => {
    await runTransitions([
      { rows: snapshot("idle", "Target Idle"), expected: resolved("Target Idle") },
      { rows: snapshot("paused", "Target Paused"), expected: invalid },
      { rows: snapshot("running", "Target Running"), expected: resolved("Target Running") },
      { rows: snapshot("terminated", "Target Terminated"), expected: invalid },
      { rows: snapshot("idle", "Target Returned"), expected: resolved("Target Returned") },
    ]);
  });

  it("resolves a card after pending approval becomes idle", async () => {
    await runTransitions([
      { rows: snapshot("pending_approval", "Target Pending"), expected: invalid },
      { rows: snapshot("idle", "Target Approved"), expected: resolved("Target Approved") },
    ]);
  });
});
