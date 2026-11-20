import { createHash } from "node:crypto";
import { TLSSocket } from "node:tls";
import { Router } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { acceptanceServiceCredentials, nativeFinalizationGrants, nativeFinalizationOutbox, nativeFinalizationRequests, nativeRunFinalizations, type Db } from "@myrmidon/db";
import { isUuidLike } from "@myrmidon/shared";
import { acceptanceServiceCredentialsService } from "../services/acceptance-service-credentials.js";
import { issueAcceptanceSnapshotService } from "../services/issue-acceptance-snapshot.js";

export function acceptanceServiceRoutes(db: Db) {
  const router = Router();
  const credentials = acceptanceServiceCredentialsService(db);
  const snapshots = issueAcceptanceSnapshotService(db);
  router.post("/service/native-runs/:runId/finalization-requests", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const socket = req.socket;
    const authorization = req.headers.authorization;
    if (!(socket instanceof TLSSocket) || !socket.authorized || !authorization?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const certificate = socket.getPeerCertificate();
    if (!certificate.raw) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const fingerprint = createHash("sha256").update(certificate.raw).digest("hex");
    const credential = await credentials.authenticateFinalization(authorization.slice(7), fingerprint);
    if (!credential) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const match = req.headers["if-match"];
    if (match === undefined) {
      res.status(428).json({ error: "If-Match required" });
      return;
    }
    if (!/^"[a-f0-9]{64}"$/.test(match)) {
      res.status(400).json({ error: "Invalid If-Match" });
      return;
    }
    const runId = String(req.params.runId);
    if (!isUuidLike(runId)) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    const [run] = await db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, runId), eq(nativeRunFinalizations.companyId, credential.companyId),
    )).limit(1);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    const body = req.body;
    const key = req.headers["idempotency-key"];
    if (!body || typeof body !== "object" || typeof body.documentId !== "string" || !isUuidLike(body.documentId) ||
        typeof body.expectedRevisionId !== "string" || !isUuidLike(body.expectedRevisionId) || typeof body.expectedIssueEpoch !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(body.expectedIssueEpoch) || typeof key !== "string" ||
        !/^[\x21-\x7e]{1,128}$/.test(key)) {
      res.status(400).json({ error: "Invalid finalization request" });
      return;
    }
    const payloadHash = createHash("sha256").update(JSON.stringify([match, body.documentId, body.expectedRevisionId, body.expectedIssueEpoch])).digest("hex");
    const outcome = await db.transaction(async (tx) => {
      // Serialize admissions and grant revocation on the grant row.
      const [grant] = await tx.select().from(nativeFinalizationGrants).where(and(
        eq(nativeFinalizationGrants.companyId, credential.companyId), eq(nativeFinalizationGrants.runId, runId),
        eq(nativeFinalizationGrants.credentialId, credential.credentialId), eq(nativeFinalizationGrants.certificateSha256, fingerprint),
        isNull(nativeFinalizationGrants.revokedAt), gt(nativeFinalizationGrants.notAfter, new Date()),
      )).for("update");
      if (!grant) return { status: 403, error: "Forbidden" };
      const [validCredential] = await tx.select({ id: acceptanceServiceCredentials.id }).from(acceptanceServiceCredentials).where(and(
        eq(acceptanceServiceCredentials.id, credential.credentialId), eq(acceptanceServiceCredentials.companyId, credential.companyId),
        isNull(acceptanceServiceCredentials.revokedAt), gt(acceptanceServiceCredentials.expiresAt, new Date()),
      )).for("update");
      if (!validCredential) return { status: 401, error: "Unauthorized" };
      const [existing] = await tx.select().from(nativeFinalizationRequests).where(and(
        eq(nativeFinalizationRequests.credentialId, credential.credentialId), eq(nativeFinalizationRequests.runId, runId),
        eq(nativeFinalizationRequests.idempotencyKey, key),
      ));
      if (existing) return existing.canonicalPayloadHash === payloadHash
        ? { status: 202, id: existing.id } : { status: 409, error: "Idempotency key conflict" };
      const [active] = await tx.select({ id: nativeFinalizationRequests.id }).from(nativeFinalizationRequests).where(and(
        eq(nativeFinalizationRequests.runId, runId),
      ));
      if (active) return { status: 409, error: "Finalization request already exists" };
      const snapshot = await issueAcceptanceSnapshotService(tx as unknown as Db).read(grant.issueId, credential.companyId);
      const etag = snapshot && `"${createHash("sha256").update(JSON.stringify([snapshot.issue.id, snapshot.issue.version, snapshot.document?.latestRevisionId ?? null])).digest("hex")}"`;
      if (!snapshot?.document || match !== etag || snapshot.document.id !== body.documentId ||
          snapshot.document.latestRevisionId !== body.expectedRevisionId || snapshot.issue.version !== body.expectedIssueEpoch) {
        return { status: 412, error: "Snapshot changed" };
      }
      const [request] = await tx.insert(nativeFinalizationRequests).values({
        companyId: credential.companyId, issueId: grant.issueId, runId, grantId: grant.id, grantGeneration: grant.generation,
        principalId: grant.principalId, credentialId: credential.credentialId, verifiedPeerSha256: fingerprint,
        authenticatedAt: new Date(), documentId: body.documentId, expectedRevisionId: body.expectedRevisionId,
        expectedIssueEpoch: body.expectedIssueEpoch, strongEtag: match, canonicalPayloadHash: payloadHash, idempotencyKey: key,
      }).returning({ id: nativeFinalizationRequests.id });
      await tx.insert(nativeFinalizationOutbox).values({ requestId: request.id });
      return { status: 202, id: request.id };
    });
    res.status(outcome.status).json(outcome.id ? { id: outcome.id } : { error: outcome.error });
  });
  router.get("/service/issues/:id/acceptance-scenarios", async (req, res) => {
    if (req.method !== "GET") {
      res.sendStatus(404);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    const socket = req.socket;
    const authorization = req.headers.authorization;
    if (!(socket instanceof TLSSocket) || !socket.authorized || !authorization?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const certificate = socket.getPeerCertificate();
    if (!certificate.raw) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const fingerprint = createHash("sha256").update(certificate.raw).digest("hex");
    const credential = await credentials.authenticate(authorization.slice(7), fingerprint);
    if (!credential) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    let snapshot;
    try {
      snapshot = await snapshots.read(String(req.params.id), credential.companyId);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Ambiguous acceptance snapshot") throw error;
      res.status(409).json({ error: "Ambiguous acceptance snapshot" });
      return;
    }
    if (!snapshot) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const etag = `"${createHash("sha256").update(JSON.stringify([snapshot.issue.id, snapshot.issue.version, snapshot.document?.latestRevisionId ?? null])).digest("hex")}"`;
    res.setHeader("ETag", etag);
    const match = req.headers["if-match"];
    if (match !== undefined && match !== etag) {
      res.status(412).json({ error: "Snapshot changed" });
      return;
    }
    res.json(snapshot);
  });
  return router;
}
