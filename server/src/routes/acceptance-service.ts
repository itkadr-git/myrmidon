import { createHash } from "node:crypto";
import { TLSSocket } from "node:tls";
import { Router } from "express";
import type { Db } from "@myrmidon/db";
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
    // No request is accepted until durable run grants and admission exist.
    res.status(503).json({ error: "Finalization admission unavailable" });
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
