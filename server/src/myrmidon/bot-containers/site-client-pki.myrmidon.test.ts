import { describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { connect, createServer, createSecureContext } from "node:tls";
import { once } from "node:events";
import { generateSiteCa, issueSiteClientCertificate, SITE_CLIENT_CERT_VALIDITY_DAYS } from "./site-client-pki.js";

describe("site client PKI", () => {
  it("generates a private P-256 CA and a signed 90-day client cert", () => {
    const now = new Date("2026-10-25T00:00:00Z");
    const ca = generateSiteCa(now);
    const caCert = new X509Certificate(ca.cert);
    const client = issueSiteClientCertificate(ca, "test-site", now);
    const clientCert = new X509Certificate(client.cert);

    expect(caCert.ca).toBe(true);
    expect(caCert.raw.toString("hex")).toContain("551d0f");
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

  it("rejects an expired site client certificate during TLS client authentication", async () => {
    const ca = generateSiteCa();
    const expiredClient = issueSiteClientCertificate(ca, "expired-site", { validityDays: -1 });
    const server = createServer({
      key: ca.key,
      cert: ca.cert,
      requestCert: true,
      rejectUnauthorized: false,
      ca: [ca.cert],
    });
    server.on("tlsClientError", () => {});
    const serverConnected = new Promise<{ authorized: boolean; authError: string | null }>((resolve) => {
      server.on("secureConnection", (socket) => {
        resolve({
          authorized: socket.authorized,
          authError: socket.authorizationError ? String(socket.authorizationError) : null,
        });
        socket.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TLS test server did not bind a TCP port");
    const client = connect({
      host: "127.0.0.1",
      port: address.port,
      ca: ca.cert,
      cert: expiredClient.cert,
      key: expiredClient.key,
      checkServerIdentity: () => undefined,
      rejectUnauthorized: false,
    });
    await Promise.all([once(client, "secureConnect"), serverConnected]);
    const result = await serverConnected;
    expect(result.authorized).toBe(false);
    expect(result.authError).toBe("CERT_HAS_EXPIRED");
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
