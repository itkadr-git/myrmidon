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
    const clientContext = createSecureContext({ ca: ca.cert, cert: expiredClient.cert, key: expiredClient.key });
    const server = createServer({
      key: ca.key,
      cert: ca.cert,
      requestCert: true,
      rejectUnauthorized: true,
      ca: ca.cert,
    });
    server.on("secureConnection", (socket) => socket.end());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TLS test server did not bind a TCP port");
    const client = connect({
      host: "127.0.0.1",
      port: address.port,
      secureContext: clientContext,
      rejectUnauthorized: true,
    });
    const outcome = await Promise.race([
      once(client, "secureConnect").then(() => "connected" as const),
      once(client, "error").then(() => "rejected" as const),
    ]);
    expect(outcome).toBe("rejected");
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
