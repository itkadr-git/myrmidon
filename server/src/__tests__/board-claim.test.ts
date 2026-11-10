import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  principalPermissionGrants,
} from "@myrmidon/db";
import {
  claimBoardOwnership,
  getBoardClaimWarningUrl,
  initializeBoardClaimChallenge,
  inspectBoardClaimChallenge,
} from "../board-claim.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("board claim", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-claim-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await initializeBoardClaimChallenge(db, { deploymentMode: "local_trusted" });
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("lets a signed-in user claim a local-board-only authenticated instance", async () => {
    const now = new Date();
    const userId = `claim-user-${randomUUID()}`;
    const company = await db
      .insert(companies)
      .values({
        name: "Board Claim Co",
        issuePrefix: `BC${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);

    await db.insert(authUsers).values({
      id: userId,
      name: "Board Claim User",
      email: "board-claim@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(instanceUserRoles).values({
      userId: "local-board",
      role: "instance_admin",
    });

    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const warningUrl = getBoardClaimWarningUrl("127.0.0.1", 3197);
    expect(warningUrl).toBeTruthy();

    const parsed = new URL(warningUrl!);
    const token = parsed.pathname.split("/").pop()!;
    const code = parsed.searchParams.get("code")!;

    expect(inspectBoardClaimChallenge(token, code)).toMatchObject({
      status: "available",
      requiresSignIn: true,
      claimedByUserId: null,
    });

    await expect(
      claimBoardOwnership(db, { token, code, userId }),
    ).resolves.toEqual({
      status: "claimed",
      claimedByUserId: userId,
    });

    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, "local-board"), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
          ),
        ),
    ).resolves.toMatchObject([
      {
        status: "active",
        membershipRole: "owner",
      },
    ]);
    expect(inspectBoardClaimChallenge(token, code)).toMatchObject({
      status: "claimed",
      claimedByUserId: userId,
    });
  });

  it("always evaluates both token and code comparisons (constant-time)", async () => {
    await db.insert(instanceUserRoles).values({
      userId: "local-board",
      role: "instance_admin",
    });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const warningUrl = getBoardClaimWarningUrl("127.0.0.1", 3197);
    expect(warningUrl).toBeTruthy();
    const parsed = new URL(warningUrl!);
    const token = parsed.pathname.split("/").pop()!;
    const code = parsed.searchParams.get("code")!;

    // Spy on timingSafeEqual to count invocations. Both token and code must be
    // compared even when the token is wrong (no early return).
    let tseCount = 0;
    const originalTse = timingSafeEqual;
    vi.spyOn(await import("node:crypto"), "timingSafeEqual").mockImplementation(((a: Buffer, b: Buffer) => {
      tseCount += 1;
      return originalTse(a, b);
    }) as typeof timingSafeEqual);

    try {
      // Wrong token, correct code -> invalid, but BOTH comparisons ran.
      tseCount = 0;
      expect(inspectBoardClaimChallenge("wrong-token", code).status).toBe("invalid");
      expect(tseCount).toBe(2);

      // Correct token, wrong code -> invalid, both comparisons ran.
      tseCount = 0;
      expect(inspectBoardClaimChallenge(token, "wrong-code").status).toBe("invalid");
      expect(tseCount).toBe(2);

      // Both wrong -> still exactly 2 comparisons.
      tseCount = 0;
      expect(inspectBoardClaimChallenge("wrong-token", "wrong-code").status).toBe("invalid");
      expect(tseCount).toBe(2);

      // Both correct -> 2 comparisons, available.
      tseCount = 0;
      expect(inspectBoardClaimChallenge(token, code).status).toBe("available");
      expect(tseCount).toBe(2);

      // Different-length token must not throw.
      tseCount = 0;
      expect(inspectBoardClaimChallenge("x", code).status).toBe("invalid");
      expect(tseCount).toBe(2);

      // Empty code must not throw.
      tseCount = 0;
      expect(inspectBoardClaimChallenge(token, "").status).toBe("invalid");
      expect(tseCount).toBe(2);

      // Undefined code must not throw.
      tseCount = 0;
      expect(inspectBoardClaimChallenge(token, undefined).status).toBe("invalid");
      expect(tseCount).toBe(2);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
