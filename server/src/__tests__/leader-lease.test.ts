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

import { describe, expect, it, beforeAll, afterAll } from "vitest";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(50);
    lease.stop();
    expect(lease.isLeader()).toBe(true);
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
    const lb = b.lease("scheduler");
    la.start();
    await sleep(50);
    la.stop();
    lb.start();
    await sleep(50);
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
    await sleep(350);
    lease.stop();
    expect(lease.isLeader()).toBe(true);
    // First pass acquires (epoch 1), every renew pass runs the same UPDATE so
    // the epoch keeps incrementing per §5.3.
    expect(lease.currentEpoch()).toBeGreaterThanOrEqual(2);
  });

  it("expire: a stalled holder is displaced after the TTL", async () => {
    await cleanLeases();
    const a = leaderLeaseService(db, { ttlMs: 300, renewIntervalMs: 100 });
    const la = a.lease("scheduler");
    la.start();
    await sleep(50);
    la.stop(); // holder frozen: no renewals, no release (kill -9 shape)

    const b = leaderLeaseService(db, { ttlMs: 300, renewIntervalMs: 50 });
    let bAcquired = 0;
    const lb = b.lease("scheduler", { onAcquired: (epoch) => { bAcquired = epoch; } });
    lb.start();
    await sleep(700);
    lb.stop();
    expect(lb.isLeader()).toBe(true);
    expect(bAcquired).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(boardLeases);
    expect(rows[0].holderBootId).toBe(b.bootId);
  });

  it("release: the row is deleted and the contender takes over on its next pass", async () => {
    await cleanLeases();
    const a = leaderLeaseService(db, { ttlMs: 60_000, renewIntervalMs: 1_000 });
    const b = leaderLeaseService(db, { ttlMs: 60_000, renewIntervalMs: 50 });
    const la = a.lease("scheduler");
    const lb = b.lease("scheduler");
    la.start();
    await sleep(50);
    expect(la.isLeader()).toBe(true);
    la.stop();

    lb.start();
    await sleep(120);
    expect(lb.isLeader()).toBe(false); // live lease, not yet expired

    const t0 = Date.now();
    await la.release();
    // Contender pass every 50 ms → takeover well inside 1 s (§5.3).
    let handed = false;
    while (Date.now() - t0 < 1_000) {
      if (lb.isLeader()) { handed = true; break; }
      await sleep(25);
    }
    lb.stop();
    expect(handed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
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
    await sleep(50);
    expect(la.isLeader()).toBe(true);

    // Force a loss: delete the row, let the contender take it; the next renew
    // of the old holder must not return a row → onLost with aborted signal.
    await db.delete(boardLeases);
    const lb = b.lease("scheduler");
    lb.start();
    await sleep(600);
    lb.stop();
    la.stop();
    expect(la.isLeader()).toBe(false);
    expect(lostSignal).not.toBeNull();
    expect(lostSignal!.aborted).toBe(true);
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
    await sleep(600);
    for (const name of BOARD_LEASE_NAMES) {
      const rows = await db.select().from(boardLeases);
      const row = rows.find((r) => r.name === name);
      expect(row).toBeDefined();
      const holders = [a.bootId, b.bootId];
      expect(holders).toContain(row!.holderBootId);
      const leaderA = leasesA.find((l) => l.name === name)!.isLeader();
      const leaderB = leasesB.find((l) => l.name === name)!.isLeader();
      // exactly one of the two contenders believes it is the leader
      expect(leaderA !== leaderB).toBe(true);
    }
    for (const l of [...leasesA, ...leasesB]) l.stop();
    for (const l of [...leasesA, ...leasesB]) await l.release();
  });

  it("graceful release hands the lease to the standby within 1 s", async () => {
    await db.delete(boardLeases);
    const a = leaderLeaseService(db, { ttlMs: 30_000, renewIntervalMs: 100 });
    const b = leaderLeaseService(db, { ttlMs: 30_000, renewIntervalMs: 50 });
    const la = a.lease("scheduler");
    const lb = b.lease("scheduler");
    la.start();
    await sleep(150);
    expect(la.isLeader()).toBe(true);
    lb.start();
    await sleep(150);
    expect(lb.isLeader()).toBe(false);

    const t0 = Date.now();
    await la.release();
    while (Date.now() - t0 < 1_000 && !lb.isLeader()) await sleep(20);
    lb.stop();
    expect(lb.isLeader()).toBe(true);
    expect(Date.now() - t0).toBeLessThanOrEqual(1_000);
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
    await sleep(120);
    expect(la.isLeader()).toBe(true);
    la.stop(); // kill -9: no release, no renew

    lb.start();
    const t0 = Date.now();
    while (Date.now() - t0 < TTL * 3 && !lb.isLeader()) await sleep(25);
    lb.stop();
    expect(lb.isLeader()).toBe(true);
    // §5.2: takeover at kill -9 within TTL (plus scheduler slack).
    expect(Date.now() - t0).toBeLessThan(TTL * 3);
    await lb.release();
  });

  it("setTiming applies a live TTL change without restart (§5.7)", async () => {
    await db.delete(boardLeases);
    const a = leaderLeaseService(db, { ttlMs: 30_000, renewIntervalMs: 50 });
    const la = a.lease("scheduler");
    la.start();
    await sleep(120);
    expect(la.isLeader()).toBe(true);
    const rowBefore = await db.select().from(boardLeases);
    expect(rowBefore[0]?.expiresAt && rowBefore[0]?.acquiredAt).toBeTruthy();
    const ttlBefore = rowBefore[0]!.expiresAt.getTime() - rowBefore[0]!.acquiredAt.getTime();

    // Operator edits general.processes.leaderLeaseTtlSec from 30 s to 1 s:
    // the manager pushes the new timing into the running lease.
    la.setTiming(1_000, 100);
    expect(la.currentTtlMs()).toBe(1_000);
    await sleep(150); // one renew pass at the new TTL
    const rowAfter = await db.select().from(boardLeases);
    const renewWindow = rowAfter[0]!.expiresAt.getTime() - Date.now();
    expect(renewWindow).toBeLessThanOrEqual(1_000 + 250); // ≈ new TTL, not 30 s
    expect(ttlBefore).toBeGreaterThan(10_000);
    expect(la.isLeader()).toBe(true); // leadership kept across the TTL change
    await la.release();
  });
});
