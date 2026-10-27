import { describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { generateSiteCa, issueSiteClientCertificate, SITE_CLIENT_CERT_VALIDITY_DAYS } from "./site-client-pki.js";

describe("site client PKI", () => {
  it("generates a private P-256 CA and a signed 90-day client cert", () => {
    const now = new Date("2026-10-25T00:00:00Z");
    const ca = generateSiteCa(now);
    const caCert = new X509Certificate(ca.cert);
    const client = issueSiteClientCertificate(ca, "test-site", now);
    const clientCert = new X509Certificate(client.cert);

    expect(caCert.ca).toBe(true);
    expect(caCert.publicKey.asymmetricKeyType).toBe("ec");
    expect(caCert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(clientCert.verify(caCert.publicKey)).toBe(true);
    expect(clientCert.ca).toBe(false);
    expect(clientCert.checkIssued(caCert)).toBe(true);
    expect(clientCert.validFrom).toBe("Oct 24 23:59:00 2026 GMT");
    expect(client.notAfter.getTime() - now.getTime()).toBe(SITE_CLIENT_CERT_VALIDITY_DAYS * 86_400_000);
    expect(client.fingerprint).toHaveLength(64);
    expect(ca.key).not.toContain(client.key);
  });
});
