// myrmidon(1.7 KNOWLEDGE-2.0 L-13): signed git push ingress for a refresh.
//
// The board pulls the configured local checkout at startup and on every
// authenticated webhook. The lifecycle independently reads the checkout, so a
// reverted commit takes effect on the next profile reconciliation.

import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { SkillGitRecordPort } from "../skill-lifecycle/service.js";

function verifyWebhook(
  secret: string,
  req: { headers: Record<string, string | undefined>; rawBody?: Buffer; body?: unknown },
): boolean {
  const signature = req.headers["x-hub-signature-256"] ?? "";
  const payload = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? ""), "utf8");
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function skillGitRecordRoutes(deps: { gitRecord: SkillGitRecordPort | null; secret?: string }) {
  const router = Router();

  router.post("/myrmidon/skill-git-record/webhook", async (req, res) => {
    if (!deps.secret || !verifyWebhook(deps.secret, req as unknown as { headers: Record<string, string | undefined>; rawBody?: Buffer; body?: unknown })) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }
    try {
      await deps.gitRecord?.refresh();
    } catch {
      // Git remains the source of record, so the next startup/webhook retries.
      res.status(503).json({ error: "Git record refresh failed" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
