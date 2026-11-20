import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { acceptanceServiceCredentials, nativeFinalizationGrants, nativeRunFinalizations, type Db } from "@myrmidon/db";

export const ACCEPTANCE_SERVICE_AUDIENCE = "acceptance-scenarios";
export const NATIVE_FINALIZATION_AUDIENCE = "native-finalization-submit";
type ServiceAudience = typeof ACCEPTANCE_SERVICE_AUDIENCE | typeof NATIVE_FINALIZATION_AUDIENCE;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function acceptanceServiceCredentialsService(db: Db) {
  async function issue(companyId: string, certificateSha256: string, expiresAt: Date, audience: ServiceAudience) {
    if (!/^[a-f0-9]{64}$/.test(certificateSha256) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
      throw new Error("Invalid certificate fingerprint or expiry");
    }
    const token = `myrmidon_svc_${randomBytes(32).toString("base64url")}`;
    const [credential] = await db.insert(acceptanceServiceCredentials).values({
      companyId, certificateSha256, expiresAt, audience, keyHash: digest(token),
    }).returning({ id: acceptanceServiceCredentials.id });
    return { id: credential.id, token };
  }

  async function revoke(companyId: string, id: string, audience: ServiceAudience) {
    const rows = await db.update(acceptanceServiceCredentials).set({ revokedAt: new Date() }).where(and(
      eq(acceptanceServiceCredentials.id, id), eq(acceptanceServiceCredentials.companyId, companyId),
      eq(acceptanceServiceCredentials.audience, audience), isNull(acceptanceServiceCredentials.revokedAt),
    )).returning({ id: acceptanceServiceCredentials.id });
    return rows.length > 0;
  }

  async function authenticate(token: string, certificateSha256: string, audience: ServiceAudience) {
    if (!/^myrmidon_svc_[A-Za-z0-9_-]{43}$/.test(token) || !/^[a-f0-9]{64}$/.test(certificateSha256)) return null;
    const [credential] = await db.select({ companyId: acceptanceServiceCredentials.companyId, credentialId: acceptanceServiceCredentials.id }).from(acceptanceServiceCredentials).where(and(
      eq(acceptanceServiceCredentials.keyHash, digest(token)),
      eq(acceptanceServiceCredentials.certificateSha256, certificateSha256),
      eq(acceptanceServiceCredentials.audience, audience),
      isNull(acceptanceServiceCredentials.revokedAt),
      gt(acceptanceServiceCredentials.expiresAt, new Date()),
    )).limit(1);
    return credential ?? null;
  }

  async function grantFinalization(input: { companyId: string; issueId: string; runId: string; principalId: string; credentialId: string; notAfter: Date; createdByOperatorId: string }) {
    return db.transaction(async (tx) => {
      const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, input.issueId), eq(nativeRunFinalizations.runId, input.runId),
      )).for("update");
      if (!coordinator || coordinator.authorizationMode !== "internal" || coordinator.decisionId || coordinator.assessmentId ||
          !["awaiting_result", "workspace_finalizing"].includes(coordinator.phase) ||
          (coordinator.leaseOwner && (!coordinator.leaseExpiresAt || coordinator.leaseExpiresAt > new Date()))) {
        throw new Error("native_finalization_grant_not_available");
      }
      const [credential] = await tx.select().from(acceptanceServiceCredentials).where(and(
        eq(acceptanceServiceCredentials.id, input.credentialId), eq(acceptanceServiceCredentials.companyId, input.companyId),
        eq(acceptanceServiceCredentials.audience, NATIVE_FINALIZATION_AUDIENCE), isNull(acceptanceServiceCredentials.revokedAt),
        gt(acceptanceServiceCredentials.expiresAt, new Date()),
      )).for("update");
      if (!credential || !Number.isFinite(input.notAfter.getTime()) || input.notAfter <= new Date() || input.notAfter > credential.expiresAt) {
        throw new Error("native_finalization_grant_invalid_credential");
      }
      const [grant] = await tx.insert(nativeFinalizationGrants).values({ ...input, certificateSha256: credential.certificateSha256 }).returning();
      await tx.update(nativeRunFinalizations).set({ authorizationMode: "service_required", updatedAt: new Date() }).where(eq(nativeRunFinalizations.runId, input.runId));
      return grant;
    });
  }

  return {
    grantFinalization,
    issueFinalization: (companyId: string, fingerprint: string, expiresAt: Date) => issue(companyId, fingerprint, expiresAt, NATIVE_FINALIZATION_AUDIENCE),
    revokeFinalization: (companyId: string, id: string) => revoke(companyId, id, NATIVE_FINALIZATION_AUDIENCE),
    authenticateFinalization: (token: string, fingerprint: string) => authenticate(token, fingerprint, NATIVE_FINALIZATION_AUDIENCE),
    issue: (companyId: string, fingerprint: string, expiresAt: Date) => issue(companyId, fingerprint, expiresAt, ACCEPTANCE_SERVICE_AUDIENCE),
    revoke: (companyId: string, id: string) => revoke(companyId, id, ACCEPTANCE_SERVICE_AUDIENCE),
    async authenticate(token: string, fingerprint: string) {
      const credential = await authenticate(token, fingerprint, ACCEPTANCE_SERVICE_AUDIENCE);
      return credential ? { companyId: credential.companyId } : null;
    },
  };
}
