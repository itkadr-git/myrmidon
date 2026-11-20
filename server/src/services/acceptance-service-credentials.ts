import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { acceptanceServiceCredentials, type Db } from "@myrmidon/db";

export const ACCEPTANCE_SERVICE_AUDIENCE = "acceptance-scenarios";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function acceptanceServiceCredentialsService(db: Db) {
  return {
    async issue(companyId: string, certificateSha256: string, expiresAt: Date) {
      if (!/^[a-f0-9]{64}$/.test(certificateSha256) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
        throw new Error("Invalid certificate fingerprint or expiry");
      }
      const token = `myrmidon_svc_${randomBytes(32).toString("base64url")}`;
      const [credential] = await db.insert(acceptanceServiceCredentials).values({
        companyId, certificateSha256, expiresAt,
        audience: ACCEPTANCE_SERVICE_AUDIENCE,
        keyHash: digest(token),
      }).returning({ id: acceptanceServiceCredentials.id });
      return { id: credential.id, token };
    },
    async revoke(companyId: string, id: string) {
      const rows = await db.update(acceptanceServiceCredentials).set({ revokedAt: new Date() }).where(and(
        eq(acceptanceServiceCredentials.id, id), eq(acceptanceServiceCredentials.companyId, companyId),
        isNull(acceptanceServiceCredentials.revokedAt),
      )).returning({ id: acceptanceServiceCredentials.id });
      return rows.length > 0;
    },
    async authenticate(token: string, certificateSha256: string) {
      if (!/^myrmidon_svc_[A-Za-z0-9_-]{43}$/.test(token) || !/^[a-f0-9]{64}$/.test(certificateSha256)) return null;
      const [credential] = await db.select({ companyId: acceptanceServiceCredentials.companyId }).from(acceptanceServiceCredentials).where(and(
        eq(acceptanceServiceCredentials.keyHash, digest(token)),
        eq(acceptanceServiceCredentials.certificateSha256, certificateSha256),
        eq(acceptanceServiceCredentials.audience, ACCEPTANCE_SERVICE_AUDIENCE),
        isNull(acceptanceServiceCredentials.revokedAt),
        gt(acceptanceServiceCredentials.expiresAt, new Date()),
      )).limit(1);
      return credential ?? null;
    },
  };
}
