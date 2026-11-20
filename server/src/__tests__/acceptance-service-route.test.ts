import { execFileSync } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import { describe, expect, it } from "vitest";
import { agents, companies, createDb, documentRevisions, documents, heartbeatRuns, issueDocuments, issues, nativeFinalizationGrants, nativeFinalizationOutbox, nativeFinalizationRequests, nativeRunFinalizations } from "@myrmidon/db";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@myrmidon/db/test-embedded-postgres";
import { acceptanceServiceCredentialsService } from "../services/acceptance-service-credentials.js";
import { claimNativeFinalizationRequest, settleNativeFinalizationRequest } from "../services/native-runtime/native-finalization-request-recovery.js";
import { acceptanceServiceRoutes } from "../routes/acceptance-service.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("acceptance service TLS route", () => {
  it("binds credentials to a verified certificate and company and enforces strong revision pins", async () => {
    const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR ?? process.env.TMPDIR ?? process.cwd(), "acceptance-tls-"));
    const pair = (name: string) => {
      const keyPath = join(dir, `${name}.key`), certPath = join(dir, `${name}.crt`);
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", `/CN=${name}`], { stdio: "ignore" });
      return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
    };
    const serverCert = pair("server"), client = pair("client"), other = pair("other");
    const fixture = await startEmbeddedPostgresTestDatabase("acceptance-tls-route-");
    const db = createDb(fixture.connectionString);
    const app = express();
    app.use(express.json());
    app.use("/api", acceptanceServiceRoutes(db));
    app.use(errorHandler);
    const server = createServer({ ...serverCert, ca: [client.cert, other.cert], requestCert: true, rejectUnauthorized: true }, app);
    try {
      const companyId = randomUUID(), foreignId = randomUUID(), issueId = randomUUID();
      await db.insert(companies).values([{ id: companyId, name: "A", issuePrefix: "AAA" }, { id: foreignId, name: "B", issuePrefix: "BBB" }]);
      await db.insert(issues).values({ id: issueId, companyId, title: "Task", identifier: "AAA-1" });
      const fingerprint = createHash("sha256").update(new X509Certificate(client.cert).raw).digest("hex");
      const service = acceptanceServiceCredentialsService(db);
      const issued = await service.issue(companyId, fingerprint, new Date(Date.now() + 60_000));
      const submit = await service.issueFinalization(companyId, fingerprint, new Date(Date.now() + 60_000));
      const foreign = await service.issue(foreignId, fingerprint, new Date(Date.now() + 60_000));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("listener unavailable");
      const call = (token: string, cert = client, match?: string, ref = "AAA-1") => new Promise<{ status: number; etag?: string; body: string }>((resolve, reject) => {
        const req = httpsRequest({ host: "127.0.0.1", port: address.port, path: `/api/service/issues/${ref}/acceptance-scenarios`, method: "GET", ...cert, rejectUnauthorized: false, headers: { authorization: `Bearer ${token}`, ...(match ? { "if-match": match } : {}) } }, (res) => {
          let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, etag: res.headers.etag, body }));
        });
        req.on("error", reject); req.end();
      });
      const submitWithoutPin = await new Promise<number>((resolve, reject) => {
        const req = httpsRequest({
          host: "127.0.0.1", port: address.port,
          path: `/api/service/native-runs/${randomUUID()}/finalization-requests`,
          method: "POST", ...client, rejectUnauthorized: false,
          headers: { authorization: `Bearer ${submit.token}`, "idempotency-key": "test-request" },
        }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
        req.on("error", reject); req.end();
      });
      expect(submitWithoutPin).toBe(428);
      const post = (token: string, cert = client, match?: string) => new Promise<number>((resolve, reject) => {
        const req = httpsRequest({ host: "127.0.0.1", port: address.port,
          path: `/api/service/native-runs/${randomUUID()}/finalization-requests`, method: "POST",
          ...cert, rejectUnauthorized: false,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "request-1", ...(match ? { "if-match": match } : {}) },
        }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
        req.on("error", reject); req.end(JSON.stringify({ documentId: randomUUID(), expectedRevisionId: randomUUID(), expectedIssueEpoch: "1" }));
      });
      expect(await post(issued.token)).toBe(401);
      expect(await post(submit.token, other)).toBe(401);
      expect(await post(submit.token, client, 'W/"weak"')).toBe(400);
      expect(await post(submit.token, client, `"${"a".repeat(64)}"`)).toBe(404);
      const agentId = randomUUID(), runId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId });
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "awaiting_result" });
      const ungranted = await new Promise<number>((resolve, reject) => {
        const req = httpsRequest({ host: "127.0.0.1", port: address.port,
          path: `/api/service/native-runs/${runId}/finalization-requests`, method: "POST",
          ...client, rejectUnauthorized: false,
          headers: { authorization: `Bearer ${submit.token}`, "content-type": "application/json", "if-match": `"${"a".repeat(64)}"`, "idempotency-key": "request-1" },
        }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
        req.on("error", reject); req.end(JSON.stringify({ documentId: randomUUID(), expectedRevisionId: randomUUID(), expectedIssueEpoch: "1" }));
      });
      expect(ungranted).toBe(403);
      const documentId = randomUUID(), revisionId = randomUUID(), principalId = randomUUID();
      await db.insert(documents).values({ id: documentId, companyId, latestBody: "criteria", latestRevisionId: revisionId, latestRevisionNumber: 1 });
      await db.insert(documentRevisions).values({ id: revisionId, documentId, companyId, revisionNumber: 1, body: "criteria" });
      await db.insert(issueDocuments).values({ companyId, issueId, documentId, key: "acceptance-scenarios" });
      const grantInput = { companyId, issueId, runId, principalId, credentialId: submit.id, notAfter: new Date(Date.now() + 30_000), createdByOperatorId: "test" };
      await db.update(nativeRunFinalizations).set({ leaseOwner: "worker", leaseExpiresAt: new Date(Date.now() + 30_000) }).where(eq(nativeRunFinalizations.runId, runId));
      await expect(service.grantFinalization(grantInput)).rejects.toThrow("native_finalization_grant_not_available");
      await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
      await service.grantFinalization(grantInput);
      await expect(service.grantFinalization(grantInput)).rejects.toThrow("native_finalization_grant_not_available");
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      expect(coordinator.authorizationMode).toBe("service_required");
      expect(await db.select().from(nativeFinalizationGrants).where(eq(nativeFinalizationGrants.runId, runId))).toHaveLength(1);
      const racingRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: racingRunId, companyId, agentId, nativeIssueId: issueId });
      await db.insert(nativeRunFinalizations).values({ runId: racingRunId, companyId, issueId, phase: "awaiting_result" });
      const grantRace = await Promise.allSettled([
        service.grantFinalization({ ...grantInput, runId: racingRunId }),
        service.grantFinalization({ ...grantInput, runId: racingRunId }),
      ]);
      expect(grantRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(grantRace.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await db.select().from(nativeFinalizationGrants).where(eq(nativeFinalizationGrants.runId, racingRunId))).toHaveLength(1);
      const [racingCoordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, racingRunId));
      expect(racingCoordinator.authorizationMode).toBe("service_required");
      const pinned = await call(issued.token);
      const snapshot = JSON.parse(pinned.body);
      const payload = { documentId, expectedRevisionId: revisionId, expectedIssueEpoch: snapshot.issue.version };
      const admit = (key = "request-1", requestBody: object = payload) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpsRequest({ host: "127.0.0.1", port: address.port, path: `/api/service/native-runs/${runId}/finalization-requests`, method: "POST", ...client, rejectUnauthorized: false,
          headers: { authorization: `Bearer ${submit.token}`, "content-type": "application/json", "if-match": pinned.etag, "idempotency-key": key } }, (res) => {
          let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject); req.end(JSON.stringify(requestBody));
      });
      expect((await admit("untrusted-identity", { ...payload, companyId: foreignId, principalId: randomUUID() })).status).toBe(400);
      const [admitted, concurrentReplay] = await Promise.all([admit(), admit()]);
      expect(admitted.status).toBe(202);
      expect(concurrentReplay.status).toBe(202);
      expect(JSON.parse(concurrentReplay.body).id).toBe(JSON.parse(admitted.body).id);
      const replay = await admit();
      expect(replay.status).toBe(202);
      expect(JSON.parse(replay.body).id).toBe(JSON.parse(admitted.body).id);
      expect((await admit("request-1", { ...payload, expectedRevisionId: randomUUID() })).status).toBe(409);
      const alternative = await admit("request-2");
      expect(alternative.status).toBe(409);
      const requests = await db.select().from(nativeFinalizationRequests).where(eq(nativeFinalizationRequests.runId, runId));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ companyId, runId, issueId, credentialId: submit.id, principalId, verifiedPeerSha256: fingerprint, documentId, expectedRevisionId: revisionId });
      const result = (token: string, requestId = requests[0].id, cert = client) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpsRequest({ host: "127.0.0.1", port: address.port, path: `/api/service/native-runs/${runId}/finalization-requests/${requestId}`, method: "GET", ...cert, rejectUnauthorized: false,
          headers: { authorization: `Bearer ${token}` } }, (res) => {
          let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject); req.end();
      });
      const pendingResult = await result(submit.token);
      expect(pendingResult.status).toBe(200);
      expect(JSON.parse(pendingResult.body)).toEqual({ requestId: requests[0].id, runId, state: "accepted" });
      expect((await result(issued.token)).status).toBe(401);
      expect((await result(submit.token, randomUUID())).status).toBe(404);
      expect((await result(submit.token, requests[0].id, other)).status).toBe(401);
      expect(await db.select().from(nativeFinalizationOutbox).where(eq(nativeFinalizationOutbox.requestId, requests[0].id))).toHaveLength(1);
      const now = new Date();
      const claims = await Promise.all([
        claimNativeFinalizationRequest(db, "worker-a", now, 1000),
        claimNativeFinalizationRequest(db, "worker-b", now, 1000),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.find(Boolean)?.id).toBe(requests[0].id);
      const recoveredAt = new Date(now.getTime() + 1001);
      const firstLease = await claimNativeFinalizationRequest(db, "worker-c", recoveredAt, 1000);
      expect(firstLease).toMatchObject({ id: requests[0].id, leaseOwner: "worker-c" });
      const reclaimedAt = new Date(recoveredAt.getTime() + 1001);
      const secondLease = await claimNativeFinalizationRequest(db, "worker-c", reclaimedAt, 1000);
      expect(secondLease).toMatchObject({ id: requests[0].id, leaseOwner: "worker-c" });
      expect(await settleNativeFinalizationRequest(db, requests[0].id, "worker-c", reclaimedAt, { errorCode: "stale" }, firstLease!.leaseUntil!)).toBe(false);
      // Failure after updating the request must roll back the whole settlement.
      await db.delete(nativeFinalizationOutbox).where(eq(nativeFinalizationOutbox.requestId, requests[0].id));
      await expect(settleNativeFinalizationRequest(db, requests[0].id, "worker-c", reclaimedAt, { errorCode: "denied" }, secondLease!.leaseUntil!))
        .rejects.toThrow("native_finalization_outbox_missing");
      const [afterFailedSettlement] = await db.select().from(nativeFinalizationRequests).where(eq(nativeFinalizationRequests.id, requests[0].id));
      expect(afterFailedSettlement).toMatchObject({ state: "processing", leaseOwner: "worker-c", errorCode: null, completedAt: null });
      await db.insert(nativeFinalizationOutbox).values({ requestId: requests[0].id });
      expect(await settleNativeFinalizationRequest(db, requests[0].id, "worker-c", reclaimedAt, { errorCode: "denied" }, secondLease!.leaseUntil!)).toBe(true);
      expect(await settleNativeFinalizationRequest(db, requests[0].id, "worker-c", reclaimedAt, { errorCode: "denied" }, secondLease!.leaseUntil!)).toBe(false);
      expect(await claimNativeFinalizationRequest(db, "worker-d", new Date(now.getTime() + 4000), 1000)).toBeNull();
      const [settled] = await db.select().from(nativeFinalizationRequests).where(eq(nativeFinalizationRequests.id, requests[0].id));
      expect(settled).toMatchObject({ state: "rejected", errorCode: "denied", leaseOwner: null, leaseUntil: null });
      const [dispatched] = await db.select().from(nativeFinalizationOutbox).where(eq(nativeFinalizationOutbox.requestId, requests[0].id));
      expect(dispatched.dispatchedAt).not.toBeNull();
      const first = await call(issued.token);
      expect(first.status).toBe(200);
      expect(first.etag).toMatch(/^"[a-f0-9]{64}"$/);
      expect(JSON.parse(first.body).issue.id).toBe(issueId);
      expect((await call(issued.token, client, first.etag)).status).toBe(200);
      expect((await call(issued.token, client, `W/${first.etag}`)).status).toBe(412);
      expect((await call(issued.token, other)).status).toBe(401);
      expect((await call(submit.token)).status).toBe(401);
      expect((await call(foreign.token)).status).toBe(404);
      const concurrent = await Promise.all(Array.from({ length: 8 }, () => call(issued.token, client, first.etag)));
      expect(concurrent.every((response) => response.status === 200 && response.etag === first.etag)).toBe(true);
      const [racingReads] = await Promise.all([
        Promise.all(Array.from({ length: 8 }, () => call(issued.token, client, first.etag, issueId))),
        db.update(issues).set({ identifier: "AAA-2" }).where(eq(issues.id, issueId)),
      ]);
      for (const response of racingReads) {
        expect([200, 412]).toContain(response.status);
        if (response.status === 200) {
          expect(response.etag).toBe(first.etag);
          expect(JSON.parse(response.body).issue.identifier).toBe("AAA-1");
        }
      }
      expect((await call(issued.token, client, first.etag, issueId)).status).toBe(412);
      const [revocationReads] = await Promise.all([
        Promise.all(Array.from({ length: 8 }, () => call(issued.token, client, undefined, issueId))),
        service.revoke(companyId, issued.id),
      ]);
      expect(revocationReads.every((response) => response.status === 200 || response.status === 401)).toBe(true);
      expect((await call(issued.token, client, undefined, issueId)).status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.$client.end(); await fixture.cleanup(); rmSync(dir, { recursive: true, force: true });
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
