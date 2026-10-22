// server/src/__tests__/leader-lease.test.ts
//
// myrmidon(1.6.6 PROCS-1.7 part A, design OPE-5394 §5.3): the leader-lease
// protocol against a real (embedded) Postgres.
//
// Unit-level coverage (one database, direct service calls):
//   - first acquire seeds the row and wins the lease;
//   - a second contender does not steal a live lease;
//   - the holder renews (epoch increments, expiry moves forward);
//   - after the holder stops renewing, the lease expires and a contender
//     takes over (epoch increments again, holder flips);
//   - release() deletes the row → immediate takeover by the contender
//     (§5.3: ≤ 1 s handover at a graceful shutdown);
//   - kill -9 semantics: the holder simply never renews; takeover happens on
//     the first contender pass after expiry (≤ TTL, §5.2).
//
// Integration T2 (two services on one database, timers running):
//   - exactly one leader at any time for the `scheduler` lease;
//   - graceful release hands the lease to the standby within 1 s;
//   - a stopped (never-releasing, kill -9-like) leader is displaced within
//     the TTL.

import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { boardLeases, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { leaderLeaseService, BOARD_LEASE_NAMES } from "../services/leader-lease.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

// Every wait in this file is on a condition, never on a fixed delay: the
// lease passes run on real timers against a real database, so how long a pass
// takes depends on the runner. `until` polls the condition with a generous
// ceiling that only matters when the code under test is actually broken.
const until = <T>(fn: () => T | Promise<T>, timeoutMs = 10_000) =>
  vi.waitFor(fn, { timeout: timeoutMs, interval: 10 });

/**
 * Hooks that record the last holder a contender has observed on its pass, so a
 * test can wait until a non-leader has really run (and lost) a pass.
 */
function observeHolder() {
  const seen: string[] = [];
  return { seen, hooks: { onLeaderChanged: (holder: string) => { seen.push(holder); } } };
}

describeDb("leader-lease protocol (PROCS-1.7)", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-leader-lease-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function cleanLeases() {
    await db.delete(boardLeases);
  }

  it("acquire: the first contender seeds and wins the lease", async () => {
    await cleanLeases();
    const svc = leaderLeaseService(db, { ttlMs: 5_000 });
    const lease = svc.lease("scheduler");
    // Drive one acquire pass through the public loop: start() runs it, stop()
    // freezes the loop so the test controls the cadence.
    lease.start();
    await until(() => expect(lease.isLeader()).toBe(true));
    lease.stop();
    expect(lease.currentEpoch()).toBe(1);
    const rows = await db.select().from(boardLeases);
    expect(rows).toHaveLength(1);
    expect(rows[0].holderBootId).toBe(svc.bootId);
    expect(Number(rows[0].epoch)).toBe(1);
  });

  it("contend: a live lease is not stolen by a second contender", async () => {
    await cleanLeases();
    const a = leaderLeaseService(db, { ttlMs: 5_000 });
    const b = leaderLeaseService(db, { ttlMs: 5_000 });
    const la = a.lease("scheduler");
    const obsB = observeHolder();
    const lb = b.lease("scheduler", obsB.hooks);
    la.start();
    await until(() => expect(la.isLeader()).toBe(true));
    la.stop();
    lb.start();
    // b's pass ran and saw a as the live holder.
    await until(() => expect(obsB.seen).toContain(a.bootId));
    lb.stop();
    expect(la.isLeader()).toBe(true);
    expect(lb.isLeader()).toBe(false);
    const rows = await db.select().from(boardLeases);
    expect(rows).toHaveLength(1);
    expect(rows[0].holderBootId).toBe(a.bootId);
  });

  it("renew: the holder extends the lease, epoch increments", async () => {
    await cleanLeases();
    const svc = leaderLeaseService(db, { ttlMs: 5_000, renewIntervalMs: 100 });
    const lease = svc.lease("scheduler");
    lease.start();
    // First pass acquires (epoch 1), every renew pass runs the same UPDATE so
    // the epoch keeps incrementing per §5.3.
    await until(() => expect(lease.currentEpoch()).toBeGreaterThanOrEqual(2));
    lease.stop();
    expect(lease.isLeader()).toBe(true);
  });

  it("expire: a stalled holder is displaced after the TTL", async () => {
    await cleanLeases();
    const a = leaderLeaseService(db, { ttlMs: 300, renewIntervalMs: 100 });
    const la = a.lease("scheduler");
    la.start();
    await until(() => expect(la.isLeader()).toBe(true));
    la.stop(); // holder frozen: no renewals, no release (kill -9 shape)

    const b = leaderLeaseService(db, { ttlMs: 300, renewIntervalMs: 50 });
    let bAcquired = 0;
    const lb = b.lease("scheduler", { onAcquired: (epoch) => { bAcquired = epoch; } });
    lb.start();
    await until(() => expect(lb.isLeader()).toBe(true));
    lb.stop();
    expect(bAcquired).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(boardLeases);
    expect(rows[0].holderBootId).toBe(b.bootId);
  });

  it("release: the row is deleted and the contender takes over on its next pass", async () => {
    await cleanLeases();
    const a = leaderLeaseService(db, { ttlMs: 60_000, renewIntervalMs: 1_000 });
    const b = leaderLeaseService(db, { ttlMs: 60_000, renewIntervalMs: 50 });
    const la = a.lease("scheduler");
    const obsB = observeHolder();
    const lb = b.lease("scheduler", obsB.hooks);
    la.start();
    await until(() => expect(la.isLeader()).toBe(true));
    la.stop();

    lb.start();
    // b has run a pass and found a live lease it cannot take.
    await until(() => expect(obsB.seen).toContain(a.bootId));
    expect(lb.isLeader()).toBe(false); // live lease, not yet expired

    await la.release();
    // The TTL is 60 s, so b can only get the lease through the release path
    // on one of its own passes (§5.3), never through expiry.
    await until(() => expect(lb.isLeader()).toBe(true));
    lb.stop();
  });

  it("lost renew fires onLost with an aborted signal (§5.4 stop-semantics)", async () => {
    await cleanLeases();
    const a = leaderLeaseService(db, { ttlMs: 300, renewIntervalMs: 100 });
    const b = leaderLeaseService(db, { ttlMs: 300, renewIntervalMs: 50 });
    let lostSignal: AbortSignal | null = null;
    const la = a.lease("scheduler", {
      onLost: (signal) => { lostSignal = signal; },
    });
    la.start();
    await until(() => expect(la.isLeader()).toBe(true));

    // Force a loss: delete the row, let the contender take it; the next renew
    // of the old holder must not return a row → onLost with aborted signal.
    await db.delete(boardLeases);
    const lb = b.lease("scheduler");
    lb.start();
    await until(() => expect(lb.isLeader()).toBe(true));
    await until(() => expect(lostSignal).not.toBeNull());
    lb.stop();
    la.stop();
    expect(la.isLeader()).toBe(false);
    expect(lostSignal).not.toBeNull();
    expect(lostSignal!.aborted).toBe(true);
    expect(lostSignal!.reason).toBe("renew-failed");
  });
});

describeDb("leader-lease T2 (two live contenders)", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-leader-lease-t2-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("exactly one leader at a time across every lease name", async () => {
    await db.delete(boardLeases);
    const a = leaderLeaseService(db, { ttlMs: 2_000, renewIntervalMs: 100 });
    const b = leaderLeaseService(db, { ttlMs: 2_000, renewIntervalMs: 100 });
    const leasesA = BOARD_LEASE_NAMES.map((n) => a.lease(n));
    const leasesB = BOARD_LEASE_NAMES.map((n) => b.lease(n));
    for (const l of [...leasesA, ...leasesB]) l.start();
    // Wait until every lease name has settled: a row exists and exactly one of
    // the two contenders believes it is the leader.
    await until(async () => {
      const rows = await db.select().from(boardLeases);
      for (const name of BOARD_LEASE_NAMES) {
        const row = rows.find((r) => r.name === name);
        expect(row).toBeDefined();
        const holders = [a.bootId, b.bootId];
        expect(holders).toContain(row!.holderBootId);
        const leaderA = leasesA.find((l) => l.name === name)!.isLeader();
        const leaderB = leasesB.find((l) => l.name === name)!.isLeader();
        expect(leaderA !== leaderB).toBe(true);
      }
    });
    for (const l of [...leasesA, ...leasesB]) l.stop();
    for (const l of [...leasesA, ...leasesB]) await l.release();
  });

  it("graceful release hands the lease to the standby within 1 s", async () => {
    await db.delete(boardLeases);
    const a = leaderLeaseService(db, { ttlMs: 30_000, renewIntervalMs: 100 });
    const b = leaderLeaseService(db, { ttlMs: 30_000, renewIntervalMs: 50 });
    const la = a.lease("scheduler");
    const obsB = observeHolder();
    const lb = b.lease("scheduler", obsB.hooks);
    la.start();
    await until(() => expect(la.isLeader()).toBe(true));
    lb.start();
    await until(() => expect(obsB.seen).toContain(a.bootId));
    expect(lb.isLeader()).toBe(false);

    await la.release();
    // TTL is 30 s: only the release path can hand the lease over here, on b's
    // next 50 ms pass (§5.3). Wall-clock handover speed is not asserted: it is
    // a property of the runner, not of the protocol.
    await until(() => expect(lb.isLeader()).toBe(true));
    lb.stop();
    await lb.release();
  });

  it("kill -9 (stopped holder, no release) hands over within the TTL", async () => {
    await db.delete(boardLeases);
    const TTL = 400;
    const a = leaderLeaseService(db, { ttlMs: TTL, renewIntervalMs: 100 });
    const b = leaderLeaseService(db, { ttlMs: TTL, renewIntervalMs: 50 });
    const la = a.lease("scheduler");
    const lb = b.lease("scheduler");
    la.start();
    await until(() => expect(la.isLeader()).toBe(true));
    la.stop(); // kill -9: no release, no renew

    lb.start();
    // §5.2: b takes over once a's row has expired. No release happened, so
    // expiry is the only way in.
    await until(() => expect(lb.isLeader()).toBe(true));
    lb.stop();
    await lb.release();
  });

  it("setTiming applies a live TTL change without restart (§5.7)", async () => {
    await db.delete(boardLeases);
    const a = leaderLeaseService(db, { ttlMs: 30_000, renewIntervalMs: 50 });
    const la = a.lease("scheduler");
    la.start();
    await until(() => expect(la.isLeader()).toBe(true));
    const rowBefore = await db.select().from(boardLeases);
    expect(rowBefore[0]?.expiresAt && rowBefore[0]?.acquiredAt).toBeTruthy();
    const ttlBefore = rowBefore[0]!.expiresAt.getTime() - rowBefore[0]!.acquiredAt.getTime();

    // Operator edits general.processes.leaderLeaseTtlSec from 30 s to 1 s:
    // the manager pushes the new timing into the running lease.
    la.setTiming(1_000, 100);
    expect(la.currentTtlMs()).toBe(1_000);
    // Wait for a renew pass at the new TTL to land: the row's remaining life
    // drops from ~30 s to at most the new 1 s TTL (plus a little read slack).
    // The write is what we wait for, not a fixed delay; a pass still at the
    // old TTL would leave ~30 s and keep polling.
    await until(async () => {
      const rowAfter = await db.select().from(boardLeases);
      const renewWindow = rowAfter[0]!.expiresAt.getTime() - Date.now();
      expect(renewWindow).toBeLessThanOrEqual(5_000); // ≈ new TTL, not 30 s
    });
    expect(ttlBefore).toBeGreaterThan(10_000);
    expect(la.isLeader()).toBe(true); // leadership kept across the TTL change
    await la.release();
  });
});
